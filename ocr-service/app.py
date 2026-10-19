# PTYP OCR Servisi — taranmış PDF / TIFF belgelerden tablo ve rakam okuma
# Akıllı OCR: GLM-OCR (Ollama) tüm sayfayı tek seferde okur (direk no + Y + X),
# yetersiz kalırsa OpenCV ile tespit edilen satır bantları bant bant tekrar okunur.
#
# Gürültüye dayanıklılık (v2.1):
#   1. Fon normalizasyonu (eşit olmayan aydınlatma / gri fon / gölge)
#   2. Gürültü ölçümü → yalnız gerektiğinde medyan (tuz-biber) + NL-means (gauss)
#   3. Eğim düzeltme (tablo çizgilerinden, yoksa projeksiyon varyansından)
#   4. Benek (speckle) ve kenar lekesi temizliği → bant tespiti gürültüden etkilenmez
#   5. Uyarlanır bant eşikleri (sabit %2 yerine sayfanın kendi gürültü tabanı)
#   6. GLM'e ham tarama değil temizlenmiş görüntü gider; deterministik örnekleme
#   7. Zayıf bant → ikili (binarize) görüntüyle bir kez daha okuma
#   8. Sonuç doğrulama: eksen sırası, tekrar satırlar, aykırı koordinatlar,
#      direk numarası için çoğunluk (mod) tabanlı sıra tamamlama
#
# Çalıştırma (Ubuntu):
#   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
#   OLLAMA_URL=http://127.0.0.1:11434 VISION_MODEL=glm-ocr \
#     .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8787
import base64
import asyncio
import io
import os
import logging
import re
import time
from collections import Counter
from dataclasses import dataclass

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse, StreamingResponse
from pydantic import BaseModel
from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(asctime)s [OCR] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("ocr")

app = FastAPI(title="PTYP OCR Servisi", version="2.1.0")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
VISION_MODEL = os.environ.get("VISION_MODEL", "glm-ocr")
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.55"))
# Ollama çağrısı kaç kez denenir / kaç sn beklenir (0 = devre dışı)
OLLAMA_ATTEMPTS = int(os.environ.get("OLLAMA_ATTEMPTS", "1"))
OLLAMA_TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT", "240"))
# Aynı anda Ollama'ya gönderilecek bant isteği (OLLAMA_NUM_PARALLEL ile uyumlu tutun)
# Ollama tek modeli sırayla işler; 2 eşzamanlı istek 1.3B f16 modelde
# llama-server çökmelerine yol açtı (HTTP 500 + bağlantı kopması) → 1 kalmalı
OCR_CONCURRENCY = max(1, int(os.environ.get("OCR_CONCURRENCY", "1")))
# PDF render ölçeği (2.0 ≈ 144 dpi)
PDF_SCALE = float(os.environ.get("PDF_SCALE", "2.0"))
# Sayfa medyanından bu kadar metre sapan koordinat şüpheli sayılır
OUTLIER_M = float(os.environ.get("OUTLIER_M", "25000"))
# Zayıf bantları ikili görüntüyle yeniden okumayı aç/kapat
RETRY_WEAK = os.environ.get("RETRY_WEAK", "1") != "0"


# ---------- Görüntü hazırlama ----------

def pages_from_pdf(buf: bytes) -> list[np.ndarray]:
    """PDF'ten sayfa görüntüleri (pypdfium2 — sistem bağımlılığı yok)."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(buf)
    pages = []
    try:
        for i in range(len(pdf)):
            page = pdf[i]
            bitmap = page.render(scale=PDF_SCALE, grayscale=False)
            pages.append(np.array(bitmap.to_pil().convert("RGB")))
            page.close()
    finally:
        pdf.close()
    return pages


def pages_from_tiff(buf: bytes) -> list[np.ndarray]:
    """Çok sayfalı TIFF dahil."""
    img = Image.open(io.BytesIO(buf))
    pages = []
    for frame in range(getattr(img, "n_frames", 1)):
        img.seek(frame)
        pages.append(np.array(img.convert("RGB")))
    return pages


def _to_gray(img: np.ndarray) -> np.ndarray:
    return img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)


def normalize_background(gray: np.ndarray) -> np.ndarray:
    """Fonu (kağıt rengi, gölge, aydınlatma eğimi) tahmin edip böl → beyaz fon.
    Hız için 1/4 ölçekte tahmin edilir."""
    h, w = gray.shape
    f = 4
    small = cv2.resize(gray, (max(1, w // f), max(1, h // f)), interpolation=cv2.INTER_AREA)
    # Yazıyı sil (dilate = koyu pikselleri yut), sonra yumuşat → fon tahmini
    bg = cv2.dilate(small, cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7)))
    bg = cv2.medianBlur(bg, 21)
    bg = cv2.resize(bg, (w, h), interpolation=cv2.INTER_LINEAR)
    return cv2.divide(gray, np.maximum(bg, 1), scale=255)


def _impulse_mask(gray: np.ndarray, med: np.ndarray) -> np.ndarray:
    """Tuz-biber pikselleri: komşularından çok farklı VE yalıtık (≤2 piksellik)
    noktalar. 5x5 pencerede toplam koyu piksel sayısı da sınırlandırılarak 1 px
    ince karakter uçlarının ve ondalık noktalarının silinmesi önlenir."""
    diff = gray.astype(np.int16) - med.astype(np.int16)
    dark = (diff < -75).astype(np.uint8)
    light = (diff > 75).astype(np.uint8)
    k3 = np.ones((3, 3), np.float32)
    k5 = np.ones((5, 5), np.float32)
    ink5 = cv2.filter2D((gray < 180).astype(np.uint8), -1, k5, borderType=cv2.BORDER_CONSTANT)
    n_dark = cv2.filter2D(dark, -1, k3, borderType=cv2.BORDER_CONSTANT)
    n_light = cv2.filter2D(light, -1, k3, borderType=cv2.BORDER_CONSTANT)
    return ((dark > 0) & (n_dark <= 2) & (ink5 <= 3)) | ((light > 0) & (n_light <= 2))


def estimate_noise(gray: np.ndarray) -> tuple[float, float]:
    """(gauss_sigma, impulse_oranı). Sigma, Immerkær yöntemiyle yalnız yazıdan
    UZAK fon piksellerinde ölçülür; böylece yazı kenarları / ince çizgiler ölçümü
    şişirmez, beyazda kırpılan gürültü de (255 tavanı) ölçümü sıfıra çekmez."""
    med = cv2.medianBlur(gray, 3)
    imp = _impulse_mask(gray, med)
    impulse = float(imp.mean())
    blur = cv2.blur(gray, (5, 5))
    ink_near = cv2.dilate((blur < 150).astype(np.uint8), np.ones((9, 9), np.uint8))
    bg = (ink_near == 0) & ~cv2.dilate(imp.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    if bg.sum() < 1000:
        return 0.0, impulse
    k = np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]], np.float32)
    lap = np.abs(cv2.filter2D(gray.astype(np.float32), -1, k))
    sigma = float(np.sqrt(np.pi / 2) * lap[bg].mean() / 6.0)
    return sigma, impulse


def denoise(gray: np.ndarray) -> tuple[np.ndarray, dict]:
    """Gürültü seviyesine göre uyarlanır temizlik; temiz sayfalara dokunmaz.
    NL-means 3x3 şablon penceresi kullanır: hem 3x hızlıdır hem de 1 px ince
    tablo çizgilerini ve rakam bacaklarını bulanıklaştırıp silmez."""
    sigma, impulse = estimate_noise(gray)
    info = {"sigma": round(sigma, 1), "impulse": round(impulse, 4), "impulse_fix": False, "nlm": False}
    out = gray
    if impulse > 0.0005:
        med = cv2.medianBlur(out, 3)
        mask = _impulse_mask(out, med)
        out = out.copy()
        out[mask] = med[mask]
        info["impulse_fix"] = True
        sigma, _ = estimate_noise(out)
    if sigma > 5.0:
        h = float(min(18.0, 0.65 * sigma + 2.0))
        out = cv2.fastNlMeansDenoising(out, None, h=h, templateWindowSize=3, searchWindowSize=15)
        info["nlm"] = True
    return out, info


def _speck_area(h: int) -> int:
    """Benek eşiği çözünürlüğe göre ölçeklenir (144 dpi A3 ≈ 1750px → ~5px²)."""
    return max(4, int(round(5 * (h / 1750.0) ** 2)))


def remove_specks(bin_img: np.ndarray, min_area: int, border_frac: float = 0.15) -> np.ndarray:
    """Küçük benekleri ve kenara yapışık büyük tarama lekelerini sil.
    Boyu veya eni ≥5 px olan ince karakter bacakları ('1', '7', '-') korunur."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(bin_img, connectivity=8)
    if n <= 1:
        return bin_img
    H, W = bin_img.shape
    min_dim = max(4, int(round(5 * (H / 1750.0))))
    x, y, w, h, area = stats[:, 0], stats[:, 1], stats[:, 2], stats[:, 3], stats[:, 4]
    keep = (area >= min_area) | (w >= min_dim) | (h >= min_dim)
    touches = (x <= 1) | (y <= 1) | (x + w >= W - 1) | (y + h >= H - 1)
    big_border = touches & ((w > W * border_frac) | (h > H * border_frac)) & (area > 0.5 * w * h)
    keep &= ~big_border
    keep[0] = False
    return np.where(keep[labels], 255, 0).astype(np.uint8)


def binarize(gray: np.ndarray) -> np.ndarray:
    """Normalize edilmiş gri → mürekkep=255. Otsu (gri vurgulu satır gölgelerini
    almamak için [165, 190] aralığında sınırlı) + yüksek eşikli yerel adaptif
    ikileme birleştirilerek gürültü sonrası soluklaşan ince çizgi/rakamlar korunur."""
    t, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    t = min(max(t, 165.0), 190.0)
    _, b1 = cv2.threshold(gray, t, 255, cv2.THRESH_BINARY_INV)
    b2 = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 35, 26)
    return cv2.bitwise_or(b1, b2)


def ruling_masks(bin_img: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Tablo çizgileri:
      1. Önce dikey çizgiler: rakam boyunun ~2 katı (h//60) uzunluktaki dikey
         parçalar bulunur ve yalnız sayfa yüksekliğinin ≥%8'ini kaplayan gerçek
         tablo sütun çizgileri (v_cols) dikey çizgi kabul edilir; böylece kopuk
         taranmış dikey çizgiler tam temizlenir, rakam sütunlarına dokunulmaz.
      2. Dikey çizgiler çıkarıldıktan sonra yatay çizgi adayları bulunur ve
         yalnız sayfa genişliğinin ≥%12'sini kaplayan gerçek tablo sınır
         satırları (h_rows) yatay çizgi kabul edilir."""
    h, w = bin_img.shape
    vk = max(24, h // 60)
    vb = cv2.morphologyEx(bin_img, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 5)))
    v_cand = cv2.morphologyEx(vb, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, vk)))
    v_cov = np.convolve((v_cand > 0).sum(axis=0) / max(h, 1), [1 / 3, 1 / 3, 1 / 3], "same")
    v_cols = np.convolve((v_cov >= 0.08).astype(np.uint8), [1, 1, 1], "same") > 0
    vert = np.zeros_like(bin_img)
    vert[:, v_cols] = v_cand[:, v_cols]
    vert = cv2.morphologyEx(vert, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(25, h // 50))))

    no_v = cv2.subtract(bin_img, cv2.dilate(vert, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 1))))
    hk = max(80, w // 15)
    hb = cv2.morphologyEx(no_v, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (15, 2)))
    h_cand = cv2.morphologyEx(hb, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (hk, 1)))
    h_cov = np.convolve((h_cand > 0).sum(axis=1) / max(w, 1), [1 / 3, 1 / 3, 1 / 3], "same")
    h_rows = np.convolve((h_cov >= 0.12).astype(np.uint8), [1, 1, 1], "same") > 0

    horiz = np.zeros_like(bin_img)
    horiz[h_rows, :] = 255
    return horiz, vert


def estimate_skew(bin_img: np.ndarray) -> float:
    """Eğim açısı (derece, rotate() ile doğrudan düzeltilir).
    Önce dikey çizgileri ayırır, sonra hafif dikey kalınlaştırma + yatay açılış ile
    eğik tablo çizgilerinin kopmasını önleyerek uzun yatay çizgilere doğru uydurur;
    yeterli tablo çizgisi yoksa projeksiyon varyansına düşer."""
    h, w = bin_img.shape
    vert = cv2.morphologyEx(bin_img, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(40, h // 25))))
    no_v = cv2.subtract(bin_img, cv2.dilate(vert, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 1))))
    closed = cv2.morphologyEx(no_v, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (25, 3)))
    thick = cv2.dilate(closed, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 4)))
    hlines = cv2.morphologyEx(thick, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(50, w // 30), 1)))
    contours, _ = cv2.findContours(hlines, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    angles, weights = [], []
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        if cw < w / 5 or ch > 0.13 * cw + 12:
            continue
        vx, vy = cv2.fitLine(c, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()[:2]
        a = float(np.degrees(np.arctan2(vy, vx)))
        a = (a + 90) % 180 - 90
        if abs(a) < 7:
            angles.append(a)
            weights.append(cw)
    if len(angles) >= 5:
        order = np.argsort(angles)
        cum = np.cumsum(np.array(weights)[order])
        return float(np.array(angles)[order][np.searchsorted(cum, cum[-1] / 2)])  # ağırlıklı medyan

    f = 4
    small = cv2.resize(bin_img, (max(1, w // f), max(1, h // f)), interpolation=cv2.INTER_AREA)
    sh, sw = small.shape

    def score(a: float) -> float:
        M = cv2.getRotationMatrix2D((sw / 2, sh / 2), a, 1.0)
        rot = cv2.warpAffine(small, M, (sw, sh), flags=cv2.INTER_NEAREST, borderValue=0)
        return float(np.var(rot.sum(axis=1, dtype=np.float64)))

    coarse = max(np.arange(-5.0, 5.01, 1.0), key=score)
    fine = max(np.arange(coarse - 1.0, coarse + 1.01, 0.1), key=score)
    return float(fine)


def rotate(img: np.ndarray, angle: float, border) -> np.ndarray:
    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    return cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=border)


def stretch_levels(gray: np.ndarray, white: int = 225) -> np.ndarray:
    """Seviye germe: en koyu mürekkep → 0, `white` üstü → 255.
    Soluk / ince yazı koyulaşır, fondaki kalan hafif gri doku beyaza gider."""
    lo = float(np.percentile(gray, 0.5))
    lo = min(lo, white - 60.0)
    lut = np.clip((np.arange(256, dtype=np.float32) - lo) * 255.0 / (white - lo), 0, 255).astype(np.uint8)
    return cv2.LUT(gray, lut)


@dataclass
class PreparedPage:
    gray: np.ndarray      # eğimi düzeltilmiş, fonu normalize, gürültüsü alınmış gri (GLM girdisi)
    ink: np.ndarray       # benekleri silinmiş ikili mürekkep (çizgiler dahil)
    clean: np.ndarray     # ink − tablo çizgileri (bant tespiti / yoğunluk ölçümü)
    bands: list[tuple[int, int]]
    skew: float
    noise: dict


def prepare_page(original: np.ndarray) -> PreparedPage:
    """Tek geçişte: gürültü al → normalize → eğim düzelt → ikile → çizgi/benek sök → bantla."""
    h = original.shape[0]
    speck = _speck_area(h)

    gray, noise = denoise(_to_gray(original))
    gray = stretch_levels(normalize_background(gray))

    ink = remove_specks(binarize(gray), speck)
    base = gray
    skew = 0.0
    for _ in range(2):  # 2. geçiş kalan küçük açıyı düzeltir (eğik çizgi kırık olduğundan ilk tahmin eksik kalır)
        a = estimate_skew(ink)
        if not (0.08 <= abs(a) <= 7.0) or abs(skew + a) > 7.0:
            break
        skew += a
        gray = rotate(base, skew, 255)
        ink = remove_specks(binarize(gray), speck)

    horiz, vert = ruling_masks(ink)
    clean = cv2.subtract(ink, cv2.dilate(vert, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 1))))
    clean[horiz > 0] = 0
    clean = remove_specks(clean, speck, border_frac=1.1)

    bands = row_bands(clean)
    return PreparedPage(gray=gray, ink=ink, clean=clean, bands=bands, skew=round(skew, 2), noise=noise)


def preprocess_gray(img: np.ndarray) -> np.ndarray:
    """Geriye dönük uyumluluk: normalize + gürültüsü alınmış gri."""
    return denoise(normalize_background(_to_gray(img)))[0]


def encode_b64(img: np.ndarray, max_w: int = 1200, fmt: str = ".jpg") -> str:
    """GLM-OCR'a / önizlemeye gidecek görüntü (base64).
    Gri temiz görüntüler PNG ile hem küçük hem kayıpsız olur (ondalık noktası korunur)."""
    h, w = img.shape[:2]
    if w > max_w:
        img = cv2.resize(img, (max_w, int(h * max_w / w)), interpolation=cv2.INTER_AREA)
    if img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    params = [cv2.IMWRITE_JPEG_QUALITY, 88] if fmt == ".jpg" else [cv2.IMWRITE_PNG_COMPRESSION, 3]
    ok, buf = cv2.imencode(fmt, img, params)
    return base64.b64encode(buf.tobytes()).decode() if ok else ""


def jpeg_b64(img: np.ndarray, max_w: int = 1200) -> str:
    return encode_b64(img, max_w, ".jpg")


# ---------- GLM-OCR akıllı okuma ----------

PAGE_PROMPT = (
    "Bu, bir enerji nakil hattı direk listesi tablosudur. Tablodaki HER satırı oku. "
    "Her satır için YALNIZCA şu formatta tek satır yaz: DIR | Y | X\n"
    "DIR: direk numarası (ör. D-14, P3, DP-2, 5, Portal)\n"
    "Y: ilk koordinat değeri (6-7 haneli sayı, ondalıklı olabilir)\n"
    "X: ikinci koordinat değeri (6-7 haneli sayı, ondalıklı olabilir)\n"
    "Başlık satırlarını ve diğer yazıları atla. Sayıları aynen koru, hiçbir değer uydurma. "
    "Başka hiçbir şey yazma."
)

ROW_PROMPT = (
    "Bu görüntüde solda direk numarası, sağda iki koordinat değeri (Y ve X) var. "
    "Şu formatta tek satır yaz: DIR | Y | X\n"
    "DIR direk numarası (1-3 basamaklı sayı, ör. 41, 12, D-14, PB1) — TÜM basamaklarını eksiksiz yaz. "
    "Y ve X 6-7 haneli koordinat sayıları, ondalık kısmı dahil aynen koru; uydurma. Başka bir şey yazma."
)

COORD_RE = re.compile(r"\b\d{6,7}(?:[.,]\d{1,4})?\b")
# Direk kalıbı: PB1, D-14, P3, DP-2, Direk 5, Portal
POLE_PAT_RE = re.compile(r"(?i)(?:direk\s*)?(?:portal|(?:d|p|dp|pb|dm)[-./]?\d{1,4})")
# Prompt yankısı sayılan kalıplar (boş bantta model prompt'u tekrar eder)
ECHO_WORDS = ("yalnızca", "formatta", "başka bir şey", "uydurma", "aynen koru", "koordinat değeri")
# Rakam bağlamında sık OCR karışıklıkları
_DIGIT_FIX = {"O": "0", "o": "0", "D": "0", "Q": "0", "l": "1", "I": "1", "i": "1",
              "S": "5", "s": "5", "B": "8", "Z": "2", "z": "2", "G": "6", "g": "9", "<": "4"}
_DIGIT_FIX_RE = re.compile(r"(?<=[\d.])[OoDQlIiSsBZzGg<](?=[\d.OoDQlIiSsBZzGg<\s|]|$)")


def _fix_digits(s: str) -> str:
    """Rakamların içinde/sonunda kalan harf benzeri karakterleri rakama çevir
    (ör. 4256O07.4O → 4256007.40, 369O4O.OO → 369040.00). Ardışık karışıklıklar
    (4OO1, .OO) için üç geçiş uygulanır."""
    for _ in range(3):
        s = _DIGIT_FIX_RE.sub(lambda m: _DIGIT_FIX[m.group(0)], s)
    return s


def parse_glm_line(line: str) -> dict | None:
    """GLM çıktı satırını {pole, coords: [y, x], text} biçimine çevirir."""
    text = (line or "").strip().strip("|").strip()
    if not text:
        return None
    norm = text.replace(",", ".")
    norm = re.sub(r"(?<=[\d\s])<(?=\d)", "4", norm)
    norm = _fix_digits(norm)
    # Binlik ayırıcı / OCR boşluğu: "4 256 007.40" → "4256007.40" (yalnız koordinat boyunda)
    norm = re.sub(r"\b(\d{1,3})[ ](\d{3})[ ](\d{3})(?=\.\d|\b)", r"\1\2\3", norm)
    norm = re.sub(r"\b(\d{3})[ '’](\d{3})(?=\.\d|\b)", r"\1\2", norm)
    coords = COORD_RE.findall(norm)
    # DTL tablolarında koordinatlar son iki büyük sayıdır
    coords = coords[-2:] if len(coords) >= 2 else coords
    rest = COORD_RE.sub(" ", norm).strip()
    pole = ""
    m = POLE_PAT_RE.search(rest)
    if m:
        pole = m.group(0).strip()
    else:
        m2 = re.search(r"\b\d{1,4}\b", rest)
        if m2:
            pole = m2.group(0)
            # DTL tablolarında direk no ayrı hücrelerde yazılır (yüzler|onlar|birler):
            # GLM '4 1' → '41', '1 0 0' → '100' (en çok 3 basamak)
            tail = rest[m2.end() :]
            while len(pole) < 3:
                m3 = re.match(r"[\s|]+(\d)\b", tail)
                if not m3:
                    break
                pole += m3.group(1)
                tail = tail[m3.end() :]
    if len(coords) >= 2:
        return {"pole": pole, "coords": [coords[-2], coords[-1]], "text": text}
    return {"pole": pole, "coords": coords, "text": text, "weak": True}


def _is_noise_line(parsed: dict) -> bool:
    """Zayıf satırlardan yalnızca koordinat kanıtı olanları tut;
    prompt yankısı / başlık / boş bant gürültüsünü at."""
    if not parsed.get("weak"):
        return False
    t = parsed["text"].lower()
    return not COORD_RE.search(parsed["text"]) or any(k in t for k in ECHO_WORDS)


_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    """Tek paylaşımlı istemci (her bant için yeni TCP bağlantısı açmamak için)."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=OLLAMA_TIMEOUT,
            limits=httpx.Limits(max_connections=OCR_CONCURRENCY + 2, max_keepalive_connections=OCR_CONCURRENCY + 2),
        )
    return _client


@app.on_event("shutdown")
async def _close_client():
    if _client is not None:
        await _client.aclose()


async def glm_read(images_b64: list[str], prompt: str, num_predict: int, timeout: int | None = None) -> str | None:
    """GLM-OCR'a tek seferlik soru. Başarısızsa None.
    Örnekleme deterministik (temperature 0, top_k 1, sabit seed) → aynı belge
    her yüklemede aynı sonucu verir."""
    if OLLAMA_ATTEMPTS <= 0:
        return None
    last_err = ""
    attempts = max(1, OLLAMA_ATTEMPTS)
    for attempt in range(attempts):
        try:
            r = await _http().post(
                f"{OLLAMA_URL}/api/generate",
                json={
                    "model": VISION_MODEL,
                    "prompt": prompt,
                    "images": images_b64,
                    "stream": False,
                    "think": False,
                    "options": {
                        "num_predict": num_predict,
                        "temperature": 0,
                        "top_k": 1,
                        "top_p": 1,
                        "seed": 42,
                        "repeat_penalty": 1.05,
                    },
                },
                timeout=timeout or OLLAMA_TIMEOUT,
            )
            if r.status_code == 200:
                return (r.json().get("response") or "").strip() or None
            if r.status_code == 404:  # model yok → boşuna tekrar deneme
                return None
            last_err = f"HTTP {r.status_code}"
        except Exception as e:
            last_err = str(e) or e.__class__.__name__
        if attempt + 1 < attempts:
            await asyncio.sleep(2 * (attempt + 1))  # geçici bağlantı kesintileri için geri çekilme
    log.warning("glm_read başarısız (%d): %s", attempts, last_err)
    return None


def _smooth(x: np.ndarray, win: int) -> np.ndarray:
    k = np.ones(2 * win + 1) / (2 * win + 1)
    return np.convolve(x, k, "same")


def _gap_threshold(proj_frac: np.ndarray) -> float:
    """Sayfanın kendi gürültü tabanına göre boşluk eşiği.
    Çizgileri ve benekleri temizlenmiş sayfada satır araları ~0'a iner; rakam
    gövdelerinin orta kesitinde yoğunluk düşebildiği için eşik tabana yakın tutulur."""
    lo = float(np.percentile(proj_frac, 15))
    hi = float(np.percentile(proj_frac, 90))
    return float(np.clip(lo + 0.06 * (hi - lo), 0.002, 0.025))


def _bands_from_gaps(proj_frac: np.ndarray, min_h: int, thr: float | None = None) -> list[tuple[int, int]]:
    """Eşiğin altındaki satırlar boşluk (seyrek belgelerde çalışır)."""
    if thr is None:
        thr = _gap_threshold(proj_frac)
    h = len(proj_frac)
    ink = proj_frac > thr
    bands = []
    start = None
    for y in range(h):
        if ink[y] and start is None:
            start = y
        elif not ink[y] and start is not None:
            if y - start >= min_h:
                bands.append((max(0, start - 4), min(h, y + 4)))
            start = None
    if start is not None and h - start >= min_h:
        bands.append((max(0, start - 4), h))
    return bands


def _bands_from_local_min(proj_frac: np.ndarray, min_h: int, min_gap: int = 14) -> list[tuple[int, int]]:
    """Yoğun tablolarda boşluklar mutlak sıfıra inmez; satır araları göreli
    çukurdur → yerel minimumlar satır sınırıdır."""
    n = len(proj_frac)
    p = _smooth(proj_frac, 1)  # tek piksellik gürültü çukur üretmesin
    sm = _smooth(proj_frac, 12)
    ceiling = max(0.04, float(np.percentile(proj_frac, 25)) * 1.5)
    local_min = (p <= sm) & (p < ceiling)
    idx = [int(y) for y in np.where(local_min)[0]]
    bounds = [0]
    for y in idx:
        if y - bounds[-1] >= min_gap:
            bounds.append(y)
    bounds.append(n)
    bands = []
    for a, b in zip(bounds, bounds[1:]):
        if b - a >= min_h:
            bands.append((a + 1, b - 1))
    return bands


def row_bands(clean: np.ndarray, min_h: int | None = None) -> list[tuple[int, int]]:
    """Satır bantları. `clean`: benek ve çizgileri temizlenmiş ikili görüntü
    (eski API uyumu için gri verilirse kendisi ikiler).
    Önce mutlak boşluk, dev bant kalırsa yerel minimum segmentasyonu."""
    if clean.dtype != np.uint8 or set(np.unique(clean[:: 50, :: 50]).tolist()) - {0, 255}:
        b = remove_specks(binarize(clean), _speck_area(clean.shape[0]))
        horiz, vert = ruling_masks(b)
        clean = cv2.subtract(b, cv2.dilate(vert, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 1))))
        clean[horiz > 0] = 0
        clean = remove_specks(clean, _speck_area(clean.shape[0]), border_frac=1.1)
    h, w = clean.shape
    scale = h / 1750.0
    if min_h is None:
        min_h = max(5, int(round(6 * scale)))
    raw_proj = (clean > 0).sum(axis=1) / max(w, 1)
    proj_frac = np.convolve(raw_proj, [0.25, 0.5, 0.25], "same")

    bands = _bands_from_gaps(proj_frac, min_h)
    big = int(200 * max(scale, 0.5))
    # Yoğun tablo: dev bantlar birleşik satır demektir → yerel minimum yöntemi
    if not bands or len(bands) < 4 or max(b[1] - b[0] for b in bands) > big:
        alt = _bands_from_local_min(proj_frac, min_h, min_gap=max(10, int(14 * scale)))
        if len(alt) > len(bands):
            bands = alt
    return bands


def cells_from_parsed(parsed: dict) -> list[dict]:
    """parse_glm_line sonucunu hücre listesine çevir (Node tarafıyla uyumlu biçim)."""
    coords = parsed.get("coords") or []
    if len(coords) >= 2:
        cells = [
            {"text": parsed.get("pole") or "", "conf": 0.9},
            {"text": coords[0], "conf": 0.9},
            {"text": coords[1], "conf": 0.9},
        ]
    elif parsed.get("text"):
        # Zayıf satır → kullanıcı düzeltmesine düşsün
        cells = [{"text": parsed["text"], "conf": 0.3}]
    else:
        cells = []
    return cells


def compose_band(band_img: np.ndarray) -> np.ndarray:
    """Direk sütunu (sol) + koordinat sütunları (sağ) → tek odaklı görüntü.
    Küçük yazıyı büyüt: yükseklik hedefi 128px, büyütme en çok 4x,
    genişlik en çok 2400px."""
    h, w = band_img.shape[:2]
    pole_crop = band_img[:, 0 : max(1, int(w * 0.20))]
    coord_crop = band_img[:, int(w * 0.55) :]
    gap = np.full((h, 30) + band_img.shape[2:], 255, np.uint8)
    composed = np.hstack([pole_crop, gap, coord_crop])
    scale = 1.0
    if composed.shape[0] < 128:
        scale = max(scale, 128 / composed.shape[0])
    if composed.shape[1] * scale > 2400:
        scale = min(scale, 2400 / composed.shape[1])
    scale = min(scale, 4.0)
    if scale > 1.0:
        composed = cv2.resize(composed, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return composed


def _band_internal_gap(bbin: np.ndarray) -> int | None:
    """Bant içindeki en derin yatay boşluk (birleşik bantları bölmek için)."""
    proj = _smooth((bbin > 0).sum(axis=1).astype(np.float64), 1)
    h = len(proj)
    mid_lo, mid_hi = int(h * 0.2), int(h * 0.8)
    if mid_hi - mid_lo < 4:
        return None
    return mid_lo + int(np.argmin(proj[mid_lo:mid_hi]))


def plan_bands(prep: PreparedPage) -> list[tuple[int, int]]:
    """Okunacak bant listesi: birleşik bantları İÇ BOŞLUKTAN böl
    (kör orta nokta satırı keser), mürekkepsiz bantları baştan ele."""
    bands = prep.bands
    if not bands:
        return []
    w = prep.clean.shape[1]
    med = int(np.median([b[1] - b[0] for b in bands]))
    limit = 2 * min(60, max(20, med))
    out: list[tuple[int, int]] = []
    for y0, y1 in bands:
        y0, y1 = int(y0), int(y1)
        if y1 - y0 > limit:
            gap_y = _band_internal_gap(prep.clean[y0:y1])
            mid = y0 + gap_y if gap_y is not None else (y0 + y1) // 2
            parts = [(y0, mid), (mid, y1)]
        else:
            parts = [(y0, y1)]
        for a0, a1 in parts:
            if a1 - a0 < 8:
                continue
            # Gürültü/boş bantları ve koordinat bölgesinde hiç mürekkep olmayanları atla
            sub = prep.clean[a0:a1]
            if (sub > 0).mean() < 0.003 or (sub[:, int(w * 0.55) :] > 0).mean() < 0.002:
                continue
            out.append((a0, a1))
    return out


async def _read_band(prep: PreparedPage, y0: int, y1: int) -> tuple[list[dict] | None, int]:
    """Tek bantı kompozit görüntü olarak GLM'e okut. Döner: (hücreler, okuma_sayısı)."""
    composed = compose_band(prep.gray[y0:y1])
    line = await glm_read([encode_b64(composed, max_w=2000, fmt=".png")], ROW_PROMPT, 160)
    parsed = parse_glm_line(line or "")
    reads = 1
    if RETRY_WEAK and (parsed is None or parsed.get("weak")):
        # İkinci şans: ikili (siyah-beyaz) görüntü — gri gölge / soluk yazıda işe yarar
        bw = cv2.bitwise_not(prep.ink[y0:y1])
        line2 = await glm_read([encode_b64(compose_band(bw), max_w=2000, fmt=".png")], ROW_PROMPT, 160)
        reads += 1
        parsed2 = parse_glm_line(line2 or "")
        if parsed2 is not None and (parsed is None or not parsed2.get("weak")):
            parsed = parsed2
    if parsed is None or _is_noise_line(parsed):
        return None, reads
    cells = cells_from_parsed(parsed)
    return (cells or None), reads


# ---------- Sonuç doğrulama ----------

def _num(s: str) -> float | None:
    try:
        return float(str(s).replace(",", "."))
    except ValueError:
        return None


def _int_len(s: str) -> int:
    return len(str(s).replace(",", ".").split(".")[0])


def _finalize_rows(rows: list[list[dict]]) -> list[list[dict]]:
    """DTL tablolarında direkler sıralıdır (1'er artar) ve güzergah tekdüze
    ilerler. Adımlar:
      1. Ters okunmuş (X|Y) satırları düzelt (Easting 6 hane / Northing 7 hane)
      2. Aynı koordinatlı tekrar satırları at (bölünen bant / model tekrarı)
      3. Sayfa medyanından çok uzak koordinatları düşük güvenle işaretle
      4. Güzergahın baskın eksenine göre sırala
      5. Direk numarasını çoğunluk (mod) çapasıyla tamamla — tek bir hatalı
         okuma artık tüm numaraları kaydırmaz; PORTAL vb. adlar korunur."""
    valid = [r for r in rows if len(r) >= 3 and _num(r[1]["text"]) is not None and _num(r[2]["text"]) is not None]
    weak = [r for r in rows if r not in valid]
    if not valid:
        return rows

    # 1. Eksen sırası: Node tarafı (parseTm3Lines / parseUtmLines) önce Easting (6 hane,
    # 100k-900k), sonra Northing (7 hane, 3M-6M) bekler.
    for r in valid:
        v1, v2 = _num(r[1]["text"]), _num(r[2]["text"])
        if v1 is not None and v2 is not None and 3_000_000 <= v1 <= 6_000_000 and 100_000 <= v2 <= 900_000:
            r[1], r[2] = r[2], r[1]
    pattern = Counter((_int_len(r[1]["text"]), _int_len(r[2]["text"])) for r in valid).most_common(1)[0][0]
    if pattern[0] != pattern[1]:
        for r in valid:
            if (_int_len(r[1]["text"]), _int_len(r[2]["text"])) == (pattern[1], pattern[0]):
                r[1], r[2] = r[2], r[1]

    # 2. Tekrarlar
    seen: set[tuple[float, float]] = set()
    uniq = []
    for r in valid:
        key = (round(_num(r[1]["text"]), 1), round(_num(r[2]["text"]), 1))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(r)
    valid = uniq

    if len(valid) < 3:
        return valid + weak

    # 3. Aykırı değerler
    ys = np.array([_num(r[1]["text"]) for r in valid])
    xs = np.array([_num(r[2]["text"]) for r in valid])
    my, mx = float(np.median(ys)), float(np.median(xs))
    inlier = []
    for r, y, x in zip(valid, ys, xs):
        bad = abs(y - my) > OUTLIER_M or abs(x - mx) > OUTLIER_M
        if bad:
            r[1]["conf"] = r[2]["conf"] = 0.4
        inlier.append(not bad)

    # 4. Eksen belirleme — satırların sayfadaki yukarıdan aşağıya sırasını koru
    # (koordinata göre sıralamak kıvrılan hatları ve tek rakam hatası olan satırları
    # tablo boyunca sıçratıp direk sırasını bozar)
    iy, ix = ys[np.array(inlier)], xs[np.array(inlier)]
    axis = 2
    if len(iy) >= 2:
        axis = 2 if np.ptp(ix) >= np.ptp(iy) else 1

    # 4b. Güzergah tekdüzelik kontrolü: HER İKİ eksende komşularına göre
    # tersine dönen satırlar (rakam yanlış okumaları) belirsiz işaretlenir
    if len(valid) >= 3:
        other = 1 if axis == 2 else 2
        for a in (axis, other):
            vals = [_num(r[a]["text"]) for r in valid]
            for i in range(1, len(vals) - 1):
                x0, x1, x2 = vals[i - 1], vals[i], vals[i + 1]
                if None in (x0, x1, x2):
                    continue
                d1, d2 = x1 - x0, x2 - x1
                if d1 * d2 < 0 and abs(d1) + abs(d2) > 50:
                    valid[i][1]["conf"] = valid[i][2]["conf"] = 0.4

    # 5. Direk numarası — en uzun ARDIŞIK ofset dizisi çapayı belirler
    # (tek tek hatalı okumalar olsa bile sıralı kısım numaralandırmayı kurtarır)
    offsets: list[int | None] = []
    for i, r in enumerate(valid):
        t = r[0]["text"].strip()
        offsets.append(int(t) - i if re.fullmatch(r"\d{1,3}", t) else None)
    best_anchor, best_run = None, 0
    cur_anchor, cur_run = None, 0
    for o in offsets + [None]:
        if o is not None and o == cur_anchor:
            cur_run += 1
        else:
            if cur_anchor is not None and cur_run > best_run:
                best_anchor, best_run = cur_anchor, cur_run
            cur_anchor, cur_run = o, 1 if o is not None else 0
    if best_anchor is not None and best_run >= 3:
        for i, r in enumerate(valid):
            t = r[0]["text"].strip()
            if t and not re.fullmatch(r"\d{1,3}", t):
                continue  # PORTAL, D-14, PB1 gibi adlar olduğu gibi kalır
            want = str(best_anchor + i)
            if t != want:
                r[0]["text"] = want
                r[0]["conf"] = 0.7  # sıradan tamamlandı (belirsiz sayılmaz)
    return valid + weak


async def ocr_page_glm(original: np.ndarray) -> tuple[list[list[dict]], int, int]:
    """Bir sayfayı GLM-OCR ile oku.
    - Seyrek sayfa (≤12 bant): önce tüm sayfa, gerekirse bant bant.
    - Yoğun sayfa (>12 bant): doğrudan bant bant (1.3B model tam sayfada kararsız).
    Döner: (rows, band_sayısı, bant_okuma_sayısı)"""
    # CPU yoğun görüntü işleme olay döngüsünü kilitlemesin
    prep = await asyncio.to_thread(prepare_page, original)
    bands = prep.bands
    log.info("hazırlık: bant=%d eğim=%.2f° gürültü=%s", len(bands), prep.skew, prep.noise)

    page_rows: list[list[dict]] = []
    if len(bands) <= 12:
        text = await glm_read([encode_b64(prep.gray, fmt=".png")], PAGE_PROMPT, 2048)
        for l in (text or "").splitlines():
            parsed = parse_glm_line(l)
            if parsed is None or _is_noise_line(parsed):
                continue
            page_rows.append(cells_from_parsed(parsed))
        valid = sum(1 for r in page_rows if len(r) >= 3)
        if valid >= max(2, len(bands) - 2):
            return _finalize_rows(page_rows), len(bands), 0
        log.info("sayfa okuması zayıf (geçerli=%d, bant=%d) → bant bant oku", valid, len(bands))

    plan = plan_bands(prep)
    sem = asyncio.Semaphore(OCR_CONCURRENCY)

    async def worker(y0: int, y1: int):
        async with sem:
            return await _read_band(prep, y0, y1)

    # gather sırayı korur → satırlar sayfadaki sırayla gelir
    results = await asyncio.gather(*(worker(a, b) for a, b in plan))
    rows_with_band = [(cells, plan[i]) for i, (cells, _) in enumerate(results) if cells]
    band_reads = sum(n for _, n in results)

    # Kuyruk çapraz kontrolü: son 6 satırın bandını TAM GENİŞLİK kırpıyla ikinci
    # kez oku; iki okuma >100m uyuşmuyorsa belirsiz işaretle (silik tarama
    # kuyruğunda GLM kararsız olabiliyor → kullanıcı düzeltmesine düşsün)
    if len(rows_with_band) >= 3:
        for cells, (y0, y1) in rows_with_band[-6:]:
            if len(cells) < 3:
                continue
            try:
                band_img = prep.gray[y0:y1]
                if band_img.shape[0] < 60:
                    band_img = cv2.resize(band_img, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
                line2 = await glm_read([encode_b64(band_img, fmt=".png")], ROW_PROMPT, 160)
                p2 = parse_glm_line(line2 or "")
                if not (p2 and len(p2.get("coords") or []) >= 2):
                    continue
                a1, a2 = _num(cells[1]["text"]), _num(cells[2]["text"])
                b1, b2 = _num(p2["coords"][0]), _num(p2["coords"][1])
                if None in (a1, a2, b1, b2):
                    continue
                d = ((a1 - b1) ** 2 + (a2 - b2) ** 2) ** 0.5
                if d > 100:
                    cells[1]["conf"] = cells[2]["conf"] = 0.4
                    log.info("kuyruk çapraz kontrolü: bant y=%d-%d uyumsuz (fark=%.0fm)", y0, y1, d)
            except Exception:
                continue
    rows = [cells for cells, _ in rows_with_band]

    # Bant okuması sayfa okumasından kötü sonuç verdiyse sayfa sonucunu koru
    if len(rows) < sum(1 for r in page_rows if len(r) >= 3):
        log.info("bant okuması sayfadan kötü (%d < %d) → sayfa sonucu korundu", len(rows), len(page_rows))
        rows = page_rows
    return _finalize_rows(rows), len(bands), band_reads


# ---------- Uç noktalar ----------

@app.get("/health")
def health():
    return {
        "status": "ok",
        "ollama": OLLAMA_URL,
        "vision_model": VISION_MODEL,
        "concurrency": OCR_CONCURRENCY,
    }


# ---------- Test chat konsolu (SSH tüneliyle erişilir) ----------

class ChatMsg(BaseModel):
    prompt: str
    image: str | None = None  # base64, data: öneki olmadan
    history: list[dict] | None = None


@app.get("/chat", response_class=HTMLResponse)
def chat_page():
    chat_html = os.path.join(os.path.dirname(__file__), "chat.html")
    if os.path.exists(chat_html):
        return FileResponse(chat_html, media_type="text/html")
    return HTMLResponse("<h1>chat.html bulunamadı</h1>")


@app.post("/chat")
async def chat(req: ChatMsg):
    if not req.prompt.strip():
        return JSONResponse(status_code=400, content={"error": "Boş mesaj."})
    messages = []
    for h in (req.history or [])[-6:]:
        if h.get("user"):
            messages.append({"role": "user", "content": h["user"]})
        if h.get("assistant"):
            messages.append({"role": "assistant", "content": h["assistant"]})
    msg: dict = {"role": "user", "content": req.prompt}
    if req.image:
        msg["images"] = [req.image]
    messages.append(msg)

    async def gen():
        import json as _json

        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_URL}/api/chat",
                    json={
                        "model": VISION_MODEL,
                        "messages": messages,
                        "stream": True,
                        "think": False,
                        "options": {"num_predict": 300},
                    },
                ) as r:
                    if r.status_code != 200:
                        yield f"data: {_json.dumps({'error': f'Ollama: HTTP {r.status_code}'})}\n\n"
                        return
                    async for line in r.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            chunk = _json.loads(line)
                        except Exception:
                            continue
                        piece = (chunk.get("message") or {}).get("content", "")
                        if piece:
                            yield f"data: {_json.dumps({'t': piece})}\n\n"
                        if chunk.get("done"):
                            yield f"data: {_json.dumps({'done': True})}\n\n"
        except Exception as e:
            yield f"data: {_json.dumps({'error': f'Ollama akışı kesildi: {e}'})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/ocr/document")
async def ocr_document(file: UploadFile):
    t0 = time.time()
    buf = await file.read()
    name = (file.filename or "").lower()
    log.info("istek: dosya=%s boyut=%d bayt", file.filename, len(buf))
    try:
        if name.endswith(".pdf"):
            images = await asyncio.to_thread(pages_from_pdf, buf)
        elif name.endswith((".tif", ".tiff")):
            images = await asyncio.to_thread(pages_from_tiff, buf)
        elif name.endswith((".png", ".jpg", ".jpeg")):
            images = [np.array(Image.open(io.BytesIO(buf)).convert("RGB"))]
        else:
            log.warning("desteklenmeyen biçim: %s", file.filename)
            return JSONResponse(status_code=400, content={"error": "Desteklenmeyen biçim"})
    except Exception as e:
        log.warning("dosya açılamadı: %s (%s)", file.filename, e)
        return JSONResponse(status_code=400, content={"error": f"Dosya okunamadı: {e}"})

    if not images:
        log.warning("görüntü bulunamadı: %s", file.filename)
        return JSONResponse(status_code=400, content={"error": "Görüntü bulunamadı"})
    log.info("sayfalar: %d (%dx%d) — akıllı OCR (glm-ocr)", len(images), images[0].shape[1], images[0].shape[0])

    out_pages = []
    for page_idx, original in enumerate(images):
        try:
            rows, band_count, band_reads = await ocr_page_glm(original)
        except Exception as e:
            log.exception("OCR hatası (sayfa %d)", page_idx + 1)
            return JSONResponse(status_code=500, content={"error": f"OCR hatası: {e}"})

        low_conf = sum(1 for r in rows for c in r if c["conf"] < CONF_THRESHOLD)
        log.info(
            "sayfa %d/%d: satır=%d bant=%d bant_okuma=%d düşük_güven=%d",
            page_idx + 1, len(images), len(rows), band_count, band_reads, low_conf,
        )

        out_pages.append(
            {
                "page": page_idx + 1,
                "preview": "data:image/jpeg;base64,"
                + await asyncio.to_thread(jpeg_b64, original),
                "rows": rows,
            }
        )
    log.info("bitti: %s sayfa=%d süre=%.1fs", file.filename, len(out_pages), time.time() - t0)
    return {"pages": out_pages, "pages_count": len(out_pages)}
