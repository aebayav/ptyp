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
import json
import os
import logging
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse, StreamingResponse
from pydantic import BaseModel
from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(asctime)s [OCR] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("ocr")

app = FastAPI(title="PTYP OCR Servisi", version="2.1.0")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
VISION_MODEL = os.environ.get("VISION_MODEL", "glm-ocr")
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.70"))
# Ollama çağrısı kaç kez denenir / kaç sn beklenir (0 = devre dışı)
OLLAMA_ATTEMPTS = int(os.environ.get("OLLAMA_ATTEMPTS", "1"))
OLLAMA_TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT", "240"))
# Aynı anda Ollama'ya gönderilecek bant isteği (OLLAMA_NUM_PARALLEL ile uyumlu tutun)
# Ollama tek modeli sırayla işler; 2 eşzamanlı istek 1.3B f16 modelde
# llama-server çökmelerine yol açtı (HTTP 500 + bağlantı kopması) → 1 kalmalı
OCR_CONCURRENCY = max(1, int(os.environ.get("OCR_CONCURRENCY", "1")))
# PDF render ölçeği (2.0 ≈ 144 dpi)
PDF_SCALE = float(os.environ.get("PDF_SCALE", "2.0"))

# ---------- Indra OCR (hızlı CPU motoru — ana yol) ----------
# glm-ocr (VLM) yedek olarak duruyor: indra yetersizse / belirsiz doğrulamada.
INDRA_BIN = os.environ.get("INDRA_BIN", "")  # boşsa venv/PATH'ten bulunur
INDRA_CORES = int(os.environ.get("INDRA_CORES", "6"))
INDRA_MIN_ROWS = int(os.environ.get("INDRA_MIN_ROWS", "2"))
INDRA_ENABLED = os.environ.get("INDRA_ENABLED", "1") not in ("0", "false", "False")
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
    v_row: np.ndarray | None = None  # her y satırındaki dikey tablo çizgisi piksel sayısı


def auto_orient_page(img: np.ndarray) -> np.ndarray:
    """Dikey (portre, h > w) taranmış yatay DTL tablolarını otomatik 90° döndürür.
    Düz DTL sayfasında çok sütunlu tablo ızgarası üst/orta bölgede (0.20..0.55 H),
    az dikey çizgili imza bloğu ise alt bölgede (0.80..0.95 H) yer alır."""
    h, w = img.shape[:2]
    if h <= w * 1.05:
        return img
    ccw = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    cw = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    _, v_ccw = ruling_masks(binarize(_to_gray(ccw)))
    v_row = (v_ccw > 0).sum(axis=1)
    H = len(v_row)
    top_v = float(v_row[int(H * 0.20) : int(H * 0.55)].mean()) if H > 10 else 0.0
    bot_v = float(v_row[int(H * 0.80) : int(H * 0.95)].mean()) if H > 10 else 0.0
    return ccw if top_v >= bot_v else cw


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
    v_row = (vert > 0).sum(axis=1)
    clean = cv2.subtract(ink, cv2.dilate(vert, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 1))))
    clean[horiz > 0] = 0
    clean = remove_specks(clean, speck, border_frac=1.1)

    bands = row_bands(clean)
    return PreparedPage(gray=gray, ink=ink, clean=clean, bands=bands, skew=round(skew, 2), noise=noise, v_row=v_row)


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
# Direk kalıbı: PB1, D-14, P3, DP-2, Direk 5, Portal (kelime sınırı ile ND.1 içindeki D.1 eşleşmez)
POLE_PAT_RE = re.compile(r"(?i)\b(?:direk\s*)?(?:portal|(?:d|p|dp|pb|dm)[-./]?\d{1,4})\b")
# Prompt yankısı sayılan kalıplar (boş bantta model prompt'u tekrar eder)
ECHO_WORDS = ("yalnızca", "formatta", "başka bir şey", "uydurma", "aynen koru", "koordinat değeri")
# Rakam bağlamında sık OCR karışıklıkları (yalnızca rakam veya rakam+nokta sonrasında)
_DIGIT_FIX = {"O": "0", "o": "0", "D": "0", "Q": "0", "l": "1", "I": "1", "i": "1",
              "S": "5", "s": "5", "B": "8", "Z": "2", "z": "2", "G": "6", "g": "9", "<": "4"}
_DIGIT_FIX_RE = re.compile(r"(\d\.?)([OoDQlIiSsBZzGg<])(?=[\d.OoDQlIiSsBZzGg<\s|]|$)")


def _fix_digits(s: str) -> str:
    """Rakamların içinde/sonunda kalan harf benzeri karakterleri rakama çevir
    (ör. 4256O07.4O → 4256007.40, 369O4O.OO → 369040.00). Ardışık karışıklıklar
    (4OO1, .OO) için üç geçiş uygulanır."""
    for _ in range(3):
        s = _DIGIT_FIX_RE.sub(lambda m: m.group(1) + _DIGIT_FIX[m.group(2)], s)
    return s


def _normalize_coord_str(s: str) -> str:
    """Koordinat metnindeki OCR kaynaklı boşluk, nokta düşmesi ve harf-rakam karışıklıklarını onar."""
    out = (s or "").replace(",", ".")
    out = re.sub(r"(?<=[\d\s])<(?=\d)", "4", out)
    out = _fix_digits(out)
    # Binlik ayırıcı / OCR boşluğu: "4 256 007.40" → "4256007.40"
    out = re.sub(r"\b(\d{1,3})[ ](\d{3})[ ](\d{3})(?=\.\d|\b)", r"\1\2\3", out)
    out = re.sub(r"\b(\d{3})[ '’](\d{3})(?=\.\d|\b)", r"\1\2", out)
    # 7 haneli Northing'de son basamağın boşlukla ayrılması: "425861 7 00" veya "425861 7.00" → "4258617.00"
    out = re.sub(r"\b([345]\d{5})\s+(\d)[.\s](\d{2})\b", r"\1\2.\3", out)
    # Ondalık noktası düşüp 8-9 haneye birleşmiş koordinatlar: "37315021" → "373150.21", "425734335" → "4257343.35"
    out = re.sub(r"\b([345]\d{6})(\d{2})\b", r"\1.\2", out)
    out = re.sub(r"\b([2-8]\d{5})(\d{2})\b", r"\1.\2", out)
    # 6-7 haneli koordinat ile 2 haneli ondalık arasında nokta yerine boşluk: "380949 00" → "380949.00"
    out = re.sub(r"\b([2-8]\d{5}|[345]\d{6})\s+(\d{2})\b", r"\1.\2", out)
    return out


def _is_valid_coord_pair(c1: str | float | None, c2: str | float | None) -> bool:
    """Türkiye TM3 / UTM koordinat çifti doğrulaması:
    biri 6 haneli Easting (200k..850k), diğeri 7 haneli Northing (3.5M..5.5M) olmalı."""
    try:
        v1 = float(c1) if isinstance(c1, (int, float)) else float(str(c1 or "").replace(",", "."))
        v2 = float(c2) if isinstance(c2, (int, float)) else float(str(c2 or "").replace(",", "."))
    except ValueError:
        return False
    return (200_000 <= v1 <= 850_000 and 3_500_000 <= v2 <= 5_500_000) or (
        200_000 <= v2 <= 850_000 and 3_500_000 <= v1 <= 5_500_000
    )


def parse_glm_line(line: str) -> dict | None:
    """GLM çıktı satırını {pole, coords: [y, x], text} biçimine çevirir."""
    text = (line or "").strip().strip("|").strip()
    if not text:
        return None
    norm = _normalize_coord_str(text)
    coords = COORD_RE.findall(norm)
    # DTL tablolarında koordinatlar son iki büyük sayıdır
    coords = coords[-2:] if len(coords) >= 2 else coords
    rest = COORD_RE.sub(" ", norm).strip()
    pole = ""
    # Satır başındaki direk numarasını (ör. "1(S)", "85(S)", "PORTAL", "PB1", "2") önceliklendir
    m_head = re.match(r"(?i)^\s*(portal|(?:pb|dp|dm|d|p)[-./]?\d{1,4}|\d{1,3})(?:\s*\([a-z0-9]+\))?\b", rest)
    if m_head:
        pole = m_head.group(1).strip()
        if pole.upper() == "PORTAL":
            pole = "PORTAL"
        elif pole.isdigit():
            tail = rest[m_head.end() :]
            # Yalnızca "|" ile ayrılmış yüzler|onlar|birler hücrelerini birleştir (ara mesafe rakamını katma)
            while len(pole) < 3:
                m3 = re.match(r"\s*\|\s*(\d)\b", tail)
                if not m3:
                    break
                pole += m3.group(1)
                tail = tail[m3.end() :]
    else:
        m = POLE_PAT_RE.search(rest)
        if m:
            pole = m.group(0).strip()
            if pole.upper() == "PORTAL":
                pole = "PORTAL"
        else:
            m2 = re.search(r"\b\d{1,4}\b", rest)
            if m2:
                pole = m2.group(0)
    if len(coords) >= 2 and _is_valid_coord_pair(coords[-2], coords[-1]):
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
_ocr_lock = asyncio.Lock()


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
                        "num_ctx": 1024 if num_predict <= 200 else 2048,
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


def compose_band(band_img: np.ndarray, narrow: bool = False) -> np.ndarray:
    """Direk sütunu (sol %0-12) + koordinat sütunları (sağ %68-94 veya dar %72-91) → tek odaklı görüntü.
    Bant yüksekliği 64-88 px'e büyütülerek ardışık rakamların (ör. 4258333.00) kaynaması önlenir."""
    h, w = band_img.shape[:2]
    pole_end = 0.11 if narrow else 0.14
    coord_start = 0.72 if narrow else 0.66
    coord_end = 0.91 if narrow else 0.95
    pole_crop = band_img[:, 0 : max(1, int(w * pole_end))]
    coord_crop = band_img[:, int(w * coord_start) : max(int(w * coord_start) + 1, int(w * coord_end))]
    gap = np.full((h, 24) + band_img.shape[2:], 255, np.uint8)
    composed = np.hstack([pole_crop, gap, coord_crop])
    scale = 1.0
    if composed.shape[0] < 72:
        scale = max(scale, 72.0 / max(1, composed.shape[0]))
    if composed.shape[1] * scale > 2200:
        scale = min(scale, 2200.0 / max(1, composed.shape[1]))
    scale = min(scale, 3.0)
    if scale > 1.01:
        composed = cv2.resize(composed, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return composed


def compose_full_band(band_img: np.ndarray) -> np.ndarray:
    """Keşif/DTL okuması için tüm sütunları içeren tam genişlikli satır şeridi.
    Yatayda ~1.35x, dikeyde ~2.0x büyütülerek 20 px yüksekliğindeki küçük rakamlar netleştirilir."""
    h, w = band_img.shape[:2]
    fy = max(1.0, min(2.2, 52.0 / max(1, h)))
    fx = max(1.0, min(1.4, 3400.0 / max(1, w)))
    if fx > 1.01 or fy > 1.01:
        band_img = cv2.resize(band_img, None, fx=fx, fy=fy, interpolation=cv2.INTER_CUBIC)
    return band_img


# ---------- Tam sütun DTL (Direk Tevzi Listesi) ayrıştırıcı ----------

DTL_HEADER_PAT = re.compile(
    r"(?i)(?:TOWER\s+NO|WIND\s+SPAN|WEIGHT\s+SPAN|INSULATOR|ARA\s+MESAFE|FONKS.YON|"
    r"Tek\s+Ask|direklerin\s+ara|\(1\)\s*\(2\)|MAX\s+TOWER|S\.I\.NO\.)"
)
DTL_CENTER_RE = re.compile(
    r"(?i)(?:(?P<func>\b(?:KD|KT|N|D|T|A|B|C)\b)\s+)?"
    r"(?:(?P<pole2>\d{1,3}(?:\s*\([A-Z0-9]+\))?)\s+)?"
    r"(?P<ttype>\b(?:C?P[A-F]\d?(?:\([A-Z0-9]+\))?|2F[SN]\d|[1-4][A-Z]\d?|(?:K|G|T|D|N|PB|PA|PC|PD|PE|PF)[-./]?\d{1,3}))\s+"
    r"(?P<height>\d{1,2}(?:\.\d)?)\s+"
    r"(?P<body_ext>[+-]?\d{1,2})\b"
)


def normalize_crossing(raw: str) -> str:
    s = re.sub(r"[|]+", " ", raw or "")
    s = re.sub(r"\s+", " ", s).strip()
    if not s:
        return ""
    u = s.upper()
    items: list[str] = []
    if "380" in u and any(k in u for k in ("E.İ.H", "E.I.H", "E.LH", "E.L.H", "E I H", "E L H", "KV")):
        items.append("380 kV E.İ.H.")
    elif "154" in u and any(k in u for k in ("E.İ.H", "E.I.H", "E.LH", "E.L.H", "E I H", "E L H", "KV")):
        items.append("154 kV E.İ.H.")
    elif any(k in u for k in ("34.5", "34,5", "E.İ.H", "E.I.H", "E.LH", "E.L.H", "E I H", "E L H")):
        items.append("34.5 kV E.İ.HATTI")
    if "O.G" in u or "O.6" in u or "O G" in u or re.search(r"\bOG\b", u):
        items.append("O.G. HATTI")
    if "A.G" in u or re.search(r"\bAG\b", u):
        items.append("A.G. HATTI")
    if "TOPRAK" in u:
        items.append("TOPRAK YOL")
    elif "ASFALT" in u or "ŞOSE" in u or "SOSE" in u or ("YOL" in u and "DEMİR" not in u and "DEMIR" not in u):
        items.append("ASFALT YOL")
    if "P.T.T" in u or "PTT" in u or "TELEFON" in u or "TELEKOM" in u:
        items.append("P.T.T.")
    if ("DO" in u and "GAZ" in u) or "BORU HATTI" in u:
        items.append("DOĞALGAZ")
    if "DEMİRYOLU" in u or "DEMIRYOLU" in u or "TCDD" in u:
        items.append("DEMİRYOLU")
    if "DERE" in u or "NEHİR" in u or "ÇAY" in u:
        items.append("DERE / AKARSU")
    return " + ".join(items) if items else s


def normalize_remarks(raw: str) -> str:
    s = re.sub(r"[|]+", " ", raw or "")
    s = re.sub(r"\s+", " ", s).strip()
    if not s:
        return ""
    u = s.upper()
    items: list[str] = []
    if any(k in u for k in ("ZEL", "ASK", "ASL", "TAK", "TOK")):
        items.append("Özel Askı Takımı")
    if "KATOD" in u or "KATAT" in u:
        items.append("Katodik Koruma")
    if "EV" in u and "KONSOL" in u:
        items.append("ÇEVİRME KONSOLLU")
    if "MIKROKAZ" in u or "MİKROKAZ" in u:
        items.append("Mikrokazık Temelli")
    m_dr = re.search(r"(?i)\*?DR\.?\s*(\d+)\s+\S*stikametinde\s+hatta\s+dik", s)
    if m_dr:
        items.append(f"DR.{m_dr.group(1)} istikametinde hatta dik tesis")
    return ", ".join(items) if items else s


def parse_dtl_header_text(text: str) -> dict:
    raw = (text or "").replace("\r", "\n")
    m_v = re.search(r"(?i)\b(380|154|66|34[.,]5|33|31[.,]5|15[.,]8)\s*kV\b", raw)
    voltage_kv = (m_v.group(1).replace(",", ".") + " kV") if m_v else ""

    m_c = re.search(
        r"(?i)\b(\d{3,4}\s*MCM|\d/\d\s*AWG|(?:CARDINAL|PHEASANT|HAWK|DRAKE|PARTRIDGE|RAVEN|SWALLOW|PIGEON)(?:\s*\d+\s*MCM)?)\b",
        raw,
    )
    conductor = re.sub(r"\s+", " ", m_c.group(1)).upper() if m_c else ""

    line_name = ""
    for l in raw.splitlines():
        clean = l.strip()
        if not clean:
            continue
        if re.search(r"(?i)(?:TM|GES|RES|HES|OSB|HATTI|E\.İ\.H|E\.I\.H|E\.\s*[İI?]\.\s*HATTI|E\s+L\s+HATTI)", clean):
            clean = re.sub(r"(?i)\bC35\s+POLU\b", "G25 BOLU", clean)
            clean = re.sub(r"(?i)\bOSD\s+TM\b", "OSB TM", clean)
            clean = re.sub(r"(?i)\bE\s+L\s+HATTI\b", "E.İ.HATTI", clean)
            clean = re.sub(r"(?i)\bE\.\?\.HATTI\b", "E.İ.HATTI", clean)
            line_name = clean
            break

    notes = ""
    m_n = re.search(r"(?i)NOTLAR\s*:?\s*([^\n]+(?:\n[^\n]+)?)", raw)
    if m_n:
        notes = re.sub(r"\s+", " ", m_n.group(1)).strip()

    parts = [p for p in (voltage_kv, conductor, line_name) if p]
    return {
        "title": " — ".join(parts) if parts else line_name,
        "voltage_kv": voltage_kv,
        "conductor": conductor,
        "line_name": line_name,
        "notes": notes,
    }


def parse_dtl_line(line: str) -> dict | None:
    """Tam genişlikli DTL satır metnini 27 sütunlu sözlüğe ayrıştırır."""
    if not line or DTL_HEADER_PAT.search(line):
        return None
    s = _normalize_coord_str(line)
    s = re.sub(r"<[^>]+>", " ", s)  # olası HTML etiketlerini temizle
    s = re.sub(r"[|]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    if not s:
        return None

    # Silik ondalık ve kilometraj noktalarını onar
    s = re.sub(r"\b[S$B]\+(\d{3})", r"8+\1", s)
    s = re.sub(r"\bO\+(\d{3})", r"0+\1", s)
    s = re.sub(r"\bK[↑|1I]\s+(?=\d{1,3}\b)", "KD ", s)
    s = re.sub(r"\b(\d{1,3})\s*[*+-]\s*(\d{3})[., ](\d{2})\b", r"\1+\2.\3", s)
    s = re.sub(r"\b(\d{1,3}\+\d{3})(\d{2})\b", r"\1.\2", s)
    s = re.sub(r"\b(\d{1,3}\+\d{3})\s+(\d{2})\b", r"\1.\2", s)
    s = re.sub(r"\b(\d{6,7})\s+(\d{2})\b", r"\1.\2", s)
    s = re.sub(r"\b([12]\d{3}|[5-9]\d{2})\s+(\d{2})\b", r"\1.\2", s)
    s = re.sub(r"\b([12]\d{3}|[5-9]\d{2})(\d{2})(?=\s+(?:[ÇC]?G|G/|[ÇC]?A\b|\d{1,2}(?:/\d{1,2})?\b|U\d{2,3}))", r"\1.\2", s, flags=re.I)
    s = re.sub(r"^(\s*(?:PORTAL\.?|\d{1,3}(?:\([A-Z0-9]+\))?)\s+\d{2,3})(?:\s+|)(\d{2})\b", r"\1.\2", s, flags=re.I)
    s = re.sub(r"\b(8|9|10|11|12|13)(?:\s+|)(\d0)\b", r"\1.\2", s)
    s = re.sub(r"(?<!\S)([+-]0)\s+(\d0)\b", r"\1.\2", s)

    if re.match(r"(?i)^PORTAL\b", s):
        coords_p = COORD_RE.findall(s)
        easting_p = float(coords_p[-2]) if len(coords_p) >= 2 else None
        northing_p = float(coords_p[-1]) if len(coords_p) >= 2 else None
        s_no_coord = COORD_RE.sub(" ", s)
        m_st_p = re.search(r"\b(\d{1,3})\+(\d{3}(?:\.\d{1,2})?)\b", s_no_coord)
        st_text_p, st_m_p = "", None
        if m_st_p:
            st_text_p = m_st_p.group(0)
            st_m_p = round(float(m_st_p.group(1)) * 1000.0 + float(m_st_p.group(2)), 2)
            s_no_coord = s_no_coord[: m_st_p.start()] + " " + s_no_coord[m_st_p.end() :]
        nums = re.findall(r"\b\d+(?:\.\d+)?\b", s_no_coord)
        span_m, angle, elev = None, None, None
        for n in nums:
            v = float(n)
            if "." in n and len(n.split(".")[1]) >= 3 and 50 <= v <= 400:
                angle = v
            elif v >= 500:
                elev = v
            elif 5 <= v < 500 and span_m is None:
                span_m = v
        return {
            "pole": "PORTAL",
            "span_m": span_m,
            "wind_span_m": None,
            "weight_span_m": None,
            "station_text": st_text_p,
            "station_m": st_m_p,
            "some_no": "",
            "line_angle_grad": angle,
            "crossing": "",
            "function": "PORTAL",
            "tower_type": "PORTAL",
            "nominal_height_m": None,
            "body_ext_m": None,
            "hook_diff_m": None,
            "center_ext_m": None,
            "leg_a_m": None,
            "leg_b_m": None,
            "leg_c_m": None,
            "leg_d_m": None,
            "ground_elev_m": elev,
            "insulator_set": "",
            "insulator_count": "",
            "insulator_ref": "",
            "easting": easting_p,
            "northing": northing_p,
            "remarks": "",
            "profile_no": None,
            "ice_zone": None,
        }

    m = DTL_CENTER_RE.search(s)
    if not m:
        return None
    left = s[: m.start()].strip()
    right = s[m.end() :].strip()

    func = (m.group("func") or "").upper()
    pole2 = (m.group("pole2") or "").strip()
    raw_ttype = m.group("ttype").upper().replace("2FN1", "2FS1")
    if not func and ("(N)" in raw_ttype or "(S)" in raw_ttype):
        func = "N"
    ttype = re.sub(r"\([A-Z0-9]+\)$", "", raw_ttype)
    height = float(m.group("height"))
    body_ext = float(m.group("body_ext"))

    m_p1 = re.match(r"^(\d{1,3}(?:\([A-Z0-9]+\))?)\s+(.*)", left, flags=re.I)
    if m_p1:
        pole = m_p1.group(1)
        left_rest = m_p1.group(2)
    else:
        pole = pole2
        left_rest = left
    pole = re.sub(r"(?i)\(N\)", "(S)", pole)
    if not func and "(S)" in pole:
        func = "N"

    m_st = re.search(r"\b(\d{1,3})\+(\d{3}(?:\.\d{1,2})?)\b", left_rest)
    station_text, station_m, before_st, after_st = "", None, left_rest, ""
    if m_st:
        station_text = m_st.group(0)
        station_m = round(float(m_st.group(1)) * 1000.0 + float(m_st.group(2)), 2)
        before_st = left_rest[: m_st.start()].strip()
        after_st = left_rest[m_st.end() :].strip()

    b_nums = [float(x) for x in re.findall(r"\b\d+(?:\.\d+)?\b", before_st)]
    span_m = b_nums[0] if len(b_nums) >= 1 else None
    wind_span_m = b_nums[1] if len(b_nums) >= 2 else None
    weight_span_m = b_nums[2] if len(b_nums) >= 3 else None

    some_no = ""
    m_some = re.search(r"(?i)\b(ND\.[12]|[S8]\.\d{1,2}|S\.I)\b", after_st)
    if m_some:
        some_no = m_some.group(1).upper().replace("S.I", "S.1")
        if some_no.startswith("8."):
            some_no = "S." + some_no[2:]
        after_st = (after_st[: m_some.start()] + " " + after_st[m_some.end() :]).strip()

    line_angle = None
    m_ang = re.search(r"\b(\d{2,3}\.\d{3,4})\b", after_st)
    if m_ang:
        line_angle = float(m_ang.group(1))
        after_st = (after_st[: m_ang.start()] + " " + after_st[m_ang.end() :]).strip()

    crossing = normalize_crossing(after_st)

    coords = COORD_RE.findall(right)
    easting = float(coords[-2]) if len(coords) >= 2 else None
    northing = float(coords[-1]) if len(coords) >= 2 else None

    if len(coords) >= 2:
        c_idx = right.find(coords[-2])
        c2_idx = right.rfind(coords[-1])
        mid_right = right[:c_idx].strip()
        tail_right = right[c2_idx + len(coords[-1]) :].strip()
    else:
        mid_right = right
        tail_right = ""

    ins_ref = ""
    m_iref = re.search(r"(?i)\b(U\d{2,3}[A-Z]{1,3})\b", mid_right)
    if m_iref:
        ins_ref = m_iref.group(1).upper()
        mid_right = mid_right[: m_iref.start()].strip()

    ins_count = ""
    m_icnt = re.search(r"\b(\d{1,2}(?:/\d{1,2})?)\s*$", mid_right)
    if m_icnt:
        ins_count = m_icnt.group(1)
        mid_right = mid_right[: m_icnt.start()].strip()

    ground_elev = None
    ext_part = mid_right
    for m_e in re.finditer(r"\b(\d{3,4}\.\d{1,2})\b", mid_right):
        ground_elev = float(m_e.group(1))
        ext_part = mid_right[: m_e.start()].strip()

    if ins_count == "13":
        ins_set = "A"
    elif ins_count == "13/13":
        ins_set = "ÇA"
    elif "/" in ins_count:
        ins_set = "ÇGÇG"
    else:
        ins_set = "A" if func == "T" else "ÇGÇG"

    ext_nums = [float(x) for x in re.findall(r"[+-]?\d+(?:\.\d+)?", ext_part)]
    hook_diff = ext_nums[0] if len(ext_nums) >= 1 else None
    center_ext = ext_nums[1] if len(ext_nums) >= 2 else None
    legs = [int(x) for x in ext_nums[2:6]]
    while len(legs) < 4:
        legs.append(legs[-1] if legs else 0)

    tail_nums = re.findall(r"\b\d\b", tail_right)
    profile_no = int(tail_nums[-2]) if len(tail_nums) >= 2 else None
    ice_zone = int(tail_nums[-1]) if len(tail_nums) >= 2 else None
    remarks_raw = re.sub(r"(?:^|\s+)\d(?:\s+\d)?\s*$", "", tail_right).strip()
    remarks = normalize_remarks(remarks_raw)

    if not func:
        func = "T" if ins_set in ("A", "ÇA") else "KD"

    h0_default = 13.0 if ttype.startswith(("PD", "PE", "PF")) else 16.0
    if body_ext != 0 and height is not None:
        ab = abs(body_ext)
        body_ext = ab if abs((height - ab) - h0_default) < abs((height + ab) - h0_default) else -ab

    return {
        "pole": pole,
        "span_m": span_m,
        "wind_span_m": wind_span_m,
        "weight_span_m": weight_span_m,
        "station_text": station_text,
        "station_m": station_m,
        "some_no": some_no,
        "line_angle_grad": line_angle,
        "crossing": crossing,
        "function": func,
        "tower_type": ttype,
        "nominal_height_m": height,
        "body_ext_m": body_ext,
        "hook_diff_m": hook_diff,
        "center_ext_m": center_ext,
        "leg_a_m": legs[0],
        "leg_b_m": legs[1],
        "leg_c_m": legs[2],
        "leg_d_m": legs[3],
        "ground_elev_m": ground_elev,
        "insulator_set": ins_set,
        "insulator_count": ins_count,
        "insulator_ref": ins_ref,
        "easting": easting,
        "northing": northing,
        "remarks": remarks,
        "profile_no": profile_no,
        "ice_zone": ice_zone,
    }


def _fmt_station(st_m: float) -> str:
    km = int(st_m // 1000)
    rem = max(0.0, st_m - km * 1000)
    ip, dp = f"{rem:.2f}".split(".")
    return f"{km}+{ip.zfill(3)}.{dp}"


def finalize_dtl_rows(rows: list[dict]) -> list[dict]:
    """DTL satırlarında ardışık direk numarası ve kilometraj/ara mesafe tutarlılığını doğrular."""
    if not rows:
        return []
    out = [dict(r) for r in rows]

    tower_indices: list[int] = []
    offsets: list[int | None] = []
    for idx, r in enumerate(out):
        if r.get("pole") == "PORTAL" or r.get("tower_type") == "PORTAL":
            continue
        t_idx = len(tower_indices)
        tower_indices.append(idx)
        m = re.match(r"^(\d{1,3})", str(r.get("pole") or ""))
        offsets.append(int(m.group(1)) - t_idx if m else None)

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
        for t_idx, row_idx in enumerate(tower_indices):
            r = out[row_idx]
            m_suf = re.search(r"(\([A-Z0-9]+\))$", str(r.get("pole") or ""), flags=re.I)
            suffix = m_suf.group(1).upper() if m_suf else ""
            r["pole"] = f"{best_anchor + t_idx}{suffix}"

    for i in range(len(tower_indices) - 1):
        cur = out[tower_indices[i]]
        nxt = out[tower_indices[i + 1]]
        cur_st, nxt_st, cur_sp = cur.get("station_m"), nxt.get("station_m"), cur.get("span_m")
        if cur_st is not None and nxt_st is not None and cur_sp is not None:
            expected_next = round(cur_st + cur_sp, 2)
            if abs(nxt_st - expected_next) > 1.0:
                fixed_cur_st = round(nxt_st - cur_sp, 2)
                if fixed_cur_st >= 0 and abs(fixed_cur_st - cur_st) >= 900:
                    cur["station_m"] = fixed_cur_st
                    cur["station_text"] = _fmt_station(fixed_cur_st)
                elif nxt_st > cur_st and (nxt_st - cur_st) < 1200:
                    cur["span_m"] = round(nxt_st - cur_st, 2)

    return out


async def extract_dtl_header_from_page(prep: PreparedPage) -> dict:
    """Sayfanın üst başlık bloğundan gerilim, iletken ve hat adını okur."""
    h, w = prep.gray.shape
    top_crop = prep.gray[0 : int(h * 0.22), int(w * 0.05) : int(w * 0.75)]
    text = await glm_read([encode_b64(top_crop, max_w=1600, fmt=".png")], "Text Recognition:", 160)
    return parse_dtl_header_text(text or "")


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
    (kör orta nokta satırı keser), mürekkepsiz bantları ve tablo ızgarası
    dışındaki üst başlık / alt imza bloklarını baştan ele."""
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
            if a1 - a0 < 12:
                continue
            # Gürültü/boş bantları ve koordinat bölgesinde hiç mürekkep olmayanları atla
            sub = prep.clean[a0:a1]
            if (sub > 0).mean() < 0.003 or (sub[:, int(w * 0.55) :] > 0).mean() < 0.002:
                continue
            out.append((a0, a1))

    # Çok sütunlu tablo ızgarası varsa, dikey çizgi yoğunluğu düşük olan
    # üst antet ve alt imza (HAZIRLAYAN / KONTROL EDEN / ONAY) bantlarını ele
    if prep.v_row is not None and len(prep.v_row) == prep.clean.shape[0] and out:
        vmax = float(prep.v_row.max())
        if vmax >= 20:
            h = prep.clean.shape[0]
            # DTL şablonunda üst %17.5 başlık/sütun başlığıdır; veri satırları (PORTAL, 1. direk) ≥%17.5'te başlar
            filtered = [
                (a0, a1)
                for (a0, a1) in out
                if float(prep.v_row[a0:a1].mean()) >= 0.40 * vmax and a1 >= int(h * 0.175)
            ]
            if len(filtered) >= 3:
                out = filtered
    return out


async def _read_band(prep: PreparedPage, y0: int, y1: int, allow_retry: bool = True) -> tuple[list[dict] | None, int]:
    """Tek bantı kompozit görüntü olarak GLM'e okut. Döner: (hücreler, okuma_sayısı)."""
    composed = compose_band(prep.gray[y0:y1])
    line = await glm_read([encode_b64(composed, max_w=2200, fmt=".png")], ROW_PROMPT, 96)
    parsed = parse_glm_line(line or "")
    reads = 1
    if allow_retry and RETRY_WEAK and (parsed is None or parsed.get("weak")):
        # İkinci şans: ikili (siyah-beyaz) görüntü — gri gölge / soluk yazıda işe yarar
        bw = cv2.bitwise_not(prep.ink[y0:y1])
        line2 = await glm_read([encode_b64(compose_band(bw), max_w=2200, fmt=".png")], ROW_PROMPT, 96)
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
      4. Güzergahın baskın eksenini belirle (tablo sırasını koru)
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
    iy, ix = ys[np.array(inlier)], xs[np.array(inlier)]
    axis = 2
    if len(iy) >= 2:
        axis = 2 if np.ptp(ix) >= np.ptp(iy) else 1

    # 4b. Zigzag tespiti: yalnız BÜYÜK ileri-geri sıçramalar (rakam hatası)
    # belirsiz işaretlenir; küçük/sürekli yön değişimi = rota dönüşü, dokunma
    if len(valid) >= 4:
        for a in (1, 2):
            vals = [_num(r[a]["text"]) for r in valid]
            if any(v is None for v in vals):
                continue
            ds = np.abs(np.diff(vals))
            nonzero = ds[ds > 0]
            if not len(nonzero):
                continue
            step = float(np.median(nonzero))
            for i in range(1, len(vals) - 1):
                d1, d2 = vals[i] - vals[i - 1], vals[i + 1] - vals[i]
                if d1 * d2 < 0 and abs(d1) > step * 1.5 and abs(d2) > step * 1.5:
                    valid[i][1]["conf"] = valid[i][2]["conf"] = 0.4

    # 5. Direk numarası — en uzun ARDIŞIK ofset dizisi çapayı belirler
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


def _indra_bin() -> str | None:
    """indra-ocr CLI'sinin yolunu bul (venv öncelikli, sonra PATH)."""
    if INDRA_BIN:
        return INDRA_BIN
    exe = "indra-ocr.exe" if os.name == "nt" else "indra-ocr"
    cand = Path(sys.executable).with_name(exe)
    return str(cand) if cand.exists() else shutil.which(exe)


def parse_indra_dtl(joined: str, pole: str, easting: str | None, northing: str | None) -> dict:
    """Indra satır metninden KMZ nokta bilgilerini çıkar (hafif, düzen-agnostik).
    parse_dtl_line GLM transkripsiyon düzenine göre ayarlı; Indra'nın sütun
    sıralaması farklı geldiği için bu ayrı çıkarıcı kullanılır."""
    s = joined
    # İstasyon (km+metre)
    m_st = re.search(r"\b(\d{1,3})\+(\d{3})(?:[.,](\d{1,2}))?\b", s)
    station_text = m_st.group(0) if m_st else ""
    # Fonksiyon: T | KD | KT | N | D (istasyondan sonraki ilk uygun kısa token)
    func = ""
    func_pos = -1
    if m_st:
        m_f = re.search(r"\b(KD|KT|[TND])\b", s[m_st.end() :])
        if m_f:
            func = m_f.group(1).upper()
            func_pos = m_st.end() + m_f.end()
    # Direk tipi: fonksiyondan sonraki P ile başlayan kısa token (PBI→PB1 vb.)
    ttype = ""
    if func and func_pos >= 0:
        m_t = re.search(r"P[A-Za-z0-9\\)]{1,5}", s[func_pos:])
        if m_t:
            ttype = (
                m_t.group(0)
                .replace("I", "1")
                .replace(")", "1")
                .replace("l", "1")
                .replace("]", "1")
            )
    # Geçişler (bilinen anahtar sözcükler, tüm satırda aranır)
    CROSS_RE = re.compile(
        r"(TOPRAK YOL|ASFALT YOL|O\.?\s?G\.?\s?HATTI|О\.?\s?G\.?\s?HATTI|DERE|KANAL|BATAKLIK|"
        r"MEYVELIK|MEYVELİK|DOĞALGAZ|DSI KANAL|380 ?KV|BORU HATTI|KATOTIK)",
        re.I,
    )
    crossings: list[str] = []
    for w in CROSS_RE.findall(s):
        w = re.sub(r"\s+", " ", w).strip().upper()
        if w and w not in crossings:
            crossings.append(w)
    return {
        "pole": pole,
        "tower_type": ttype,
        "function": func,
        "station_text": station_text,
        "easting": float(easting) if easting else None,
        "northing": float(northing) if northing else None,
        "crossing": ", ".join(crossings),
    }


def _indra_rows_from_page(page: dict) -> tuple[list[tuple[int, list[dict]]], list[tuple[int, int]], list[dict]]:
    """Indra sayfa JSON'undan satırları kutu (box) y-koordinatıyla gruplayıp
    soldan sağa birleştirir; metin mevcut parse'tan geçer. Belge sırası korunur.
    Döner: ([(y, cells)], zayıf_bantlar, dtl_satırlar) — zayıflar GLM dolgusuna kalır."""
    lines = [l for l in (page.get("lines") or []) if l.get("text", "").strip()]
    if not lines:
        return [], [], []
    # Direk hücresini çapa alarak kümele: DTL'de direk kolonu sayfanın solunda
    # (x<380) ve her direk yeni satır başlatır. Açıklama/ek satırları komşu
    # satıra yaklaşsa bile çapalar kesin ayırır. Çapa yoksa boşluk kümelemesi.
    lines.sort(key=lambda l: float(l["box"][1]))
    ANCHOR_RE = re.compile(r"^\s*-?\d{1,3}\.?\s*$|[Pp][A-Za-z]*\d*[A-Za-z]*|[Dd][A-Za-z]*[-.]?\d*")
    anchors = [l for l in lines if float(l["box"][0]) < 380 and ANCHOR_RE.fullmatch(l["text"].strip())]
    if len(anchors) >= 2:
        anchors.sort(key=lambda l: float(l["box"][1]))
        tops = [float(a["box"][1]) for a in anchors]
        clusters: list[list[dict]] = []
        for i, a in enumerate(tops):
            b = tops[i + 1] if i + 1 < len(tops) else a + 120
            clusters.append([l for l in lines if a - 6 <= float(l["box"][1]) < b - 6])
    else:
        clusters = []
        for l in lines:
            y = float(l["box"][1])
            if clusters and y - float(clusters[-1][-1]["box"][1]) <= 16:
                clusters[-1].append(l)
            else:
                clusters.append([l])
    rows: list[tuple[int, list[dict]]] = []
    weak_ranges: list[tuple[int, int]] = []
    dtl_rows: list[dict] = []
    for items in clusters:
        items.sort(key=lambda l: float(l["box"][0]))
        joined = " | ".join(l["text"].strip() for l in items)
        parsed = parse_glm_line(joined)
        if parsed is None or _is_noise_line(parsed):
            continue
        cells = cells_from_parsed(parsed)
        y0 = int(min(float(l["box"][1]) for l in items))
        y1 = int(max(float(l["box"][3]) for l in items))
        # 27 sütunlu DTL analizi — KMZ nokta bilgileri (tip, fonksiyon, istasyon, geçiş)
        dtl = parse_dtl_line(joined)
        if not (dtl and dtl.get("pole")):
            cds = parsed.get("coords") or []
            dtl = parse_indra_dtl(
                joined,
                parsed.get("pole") or "",
                cds[0] if len(cds) > 0 else None,
                cds[1] if len(cds) > 1 else None,
            )
        if dtl and dtl.get("pole"):
            dtl_rows.append(dtl)
        if len(cells) < 3:
            # Direk benzeri başlangıcı olan eksik satır → GLM dolgusu için bant aralığı
            if parsed.get("pole") or re.search(r"^\d{1,3}\b", joined):
                weak_ranges.append((max(0, y0 - 4), y1 + 4))
            continue
        confs = [float(l.get("conf") or 0.0) for l in items if (l.get("conf") or 0) > 0]
        avg = sum(confs) / len(confs) if confs else 0.0
        for c in cells[1:3]:
            c["conf"] = round(avg, 4) if avg >= 0.55 else 0.4
        rows.append((y0, cells))
    return rows, weak_ranges, dtl_rows


async def ocr_page_indra(original: np.ndarray) -> tuple[list[tuple[int, list[dict]]], list[tuple[int, int]], list[dict], int]:
    """Indra OCR: tam sayfayı CPU'da okur (genelde 2-6 sn).
    Döner: ([(y, cells)], zayıf_bantlar, dtl_satırlar, ms). rows yetersizse GLM yoluna düşülür."""
    binp = await asyncio.to_thread(_indra_bin)
    if not binp:
        log.warning("indra ikili dosyası bulunamadı → GLM yoluna düşülür")
        return [], [], [], 0
    t0 = time.time()
    tmp = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            tmp = f.name
        bgr = cv2.cvtColor(original, cv2.COLOR_RGB2BGR)
        if not await asyncio.to_thread(cv2.imwrite, tmp, bgr):
            return [], [], [], 0

        def _run() -> subprocess.CompletedProcess:
            return subprocess.run(
                [binp, tmp, "--format", "json", "--mode", "ocr", "--cores", str(INDRA_CORES)],
                capture_output=True, text=True, timeout=600,
            )

        proc = await asyncio.to_thread(_run)
        if proc.returncode != 0:
            log.warning("indra çalışmadı (rc=%d): %s", proc.returncode, (proc.stderr or "")[-200:])
            return [], [], [], 0
        rows: list[tuple[int, list[dict]]] = []
        weak_ranges: list[tuple[int, int]] = []
        dtl_rows: list[dict] = []
        for line in proc.stdout.splitlines():
            try:
                rs, ws, ds = _indra_rows_from_page(json.loads(line))
                rows.extend(rs)
                weak_ranges.extend(ws)
                dtl_rows.extend(ds)
            except Exception:
                continue
        valid = sum(1 for _, r in rows if len(r) >= 3)
        ms = int((time.time() - t0) * 1000)
        log.info("indra: %d satır (%d geçerli, %d zayıf, %d dtl) %.0fms", len(rows), valid, len(weak_ranges), len(dtl_rows), ms)
        return rows, weak_ranges, dtl_rows, ms
    except Exception as e:
        log.warning("indra hatası (%s) → GLM yoluna düşülür", e)
        return [], [], [], 0
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


async def ocr_page_glm(
    original: np.ndarray,
    request: Request | None = None,
    read_header: bool = False,
) -> tuple[list[list[dict]], list[dict], dict | None, int, int]:
    """Bir sayfayı GLM-OCR ile oku.
    Hem KMZ için 3 hücreli [direk, Y, X] satırlarını hem de keşif için 27 sütunlu
    `dtl_rows` sözlüklerini tek geçişte üretir."""
    prep = await asyncio.to_thread(prepare_page, original)
    bands = prep.bands
    log.info("hazırlık: bant=%d eğim=%.2f° gürültü=%s", len(bands), prep.skew, prep.noise)

    header_info: dict | None = None
    if read_header:
        header_info = await extract_dtl_header_from_page(prep)

    page_rows: list[list[dict]] = []
    dtl_rows: list[dict] = []
    has_table_grid = prep.v_row is not None and float(prep.v_row.max()) >= 20
    if len(bands) <= 12 and not has_table_grid:
        text = await glm_read([encode_b64(prep.gray, fmt=".png")], PAGE_PROMPT, 2048)
        for l in (text or "").splitlines():
            parsed = parse_glm_line(l)
            if parsed is None or _is_noise_line(parsed):
                continue
            page_rows.append(cells_from_parsed(parsed))
        valid = sum(1 for r in page_rows if len(r) >= 3)
        if valid >= max(2, len(bands) - 2):
            return _finalize_rows(page_rows), dtl_rows, header_info, len(bands), 0
        log.info("sayfa okuması zayıf (geçerli=%d, bant=%d) → bant bant oku", valid, len(bands))

    plan = plan_bands(prep)
    parsed_list: list[dict | None] = []
    dtl_by_idx: dict[int, dict] = {}
    band_reads = 0

    # 1. Geçiş: tam genişlikli şeridi "Text Recognition:" ile oku (hem tüm DTL sütunları hem koordinatlar çıkar)
    for idx, (y0, y1) in enumerate(plan):
        if request is not None and await request.is_disconnected():
            raise RuntimeError("İstemci bağlantıyı kapattı")
        full_band = compose_full_band(prep.gray[y0:y1, :])
        line = await glm_read([encode_b64(full_band, max_w=3400, fmt=".png")], "Text Recognition:", 160)
        band_reads += 1
        dtl = parse_dtl_line(line or "")
        if dtl is not None:
            dtl_by_idx[idx] = dtl
            if _is_valid_coord_pair(dtl.get("easting"), dtl.get("northing")):
                pole_clean = re.sub(r"\(.*\)", "", str(dtl.get("pole") or "")).strip() or str(dtl.get("pole") or "")
                parsed_list.append(
                    {
                        "pole": pole_clean,
                        "coords": [f"{dtl['easting']:.2f}", f"{dtl['northing']:.2f}"],
                        "text": line or "",
                    }
                )
                continue
            if dtl.get("pole") == "PORTAL" and not COORD_RE.search(line or ""):
                parsed_list.append({"pole": "PORTAL", "coords": [], "text": line or "", "portal": True})
                continue
        parsed_list.append(parse_glm_line(line or ""))

    # 2. Geçiş (RETRY_WEAK): zayıf bantları dar odaklı compose_band + ikili görüntüyle tekrar dene
    if RETRY_WEAK and plan:
        for i in range(len(plan)):
            p = parsed_list[i]
            if p is not None and p.get("portal"):
                continue
            if p is None or p.get("weak"):
                if request is not None and await request.is_disconnected():
                    raise RuntimeError("İstemci bağlantıyı kapattı")
                y0, y1 = plan[i]
                composed_narrow = compose_band(prep.gray[y0:y1], narrow=True)
                b64_narrow = encode_b64(composed_narrow, max_w=2200, fmt=".png")
                line2 = await glm_read([b64_narrow], ROW_PROMPT, 96)
                band_reads += 1
                p2 = parse_glm_line(line2 or "")
                if p2 is None or p2.get("weak"):
                    line2b = await glm_read([b64_narrow], "Text Recognition:", 96)
                    band_reads += 1
                    p2b = parse_glm_line(line2b or "")
                    if p2b is not None and not p2b.get("weak"):
                        p2 = p2b
                if p2 is not None and not p2.get("weak"):
                    if not p2.get("pole") and p and p.get("pole"):
                        p2["pole"] = p["pole"]
                    parsed_list[i] = p2
                    if i in dtl_by_idx and len(p2.get("coords") or []) >= 2:
                        dtl_by_idx[i]["easting"] = float(p2["coords"][0])
                        dtl_by_idx[i]["northing"] = float(p2["coords"][1])
                    continue
                bw = cv2.bitwise_not(prep.ink[y0:y1])
                line3 = await glm_read([encode_b64(compose_band(bw), max_w=2200, fmt=".png")], ROW_PROMPT, 96)
                band_reads += 1
                p3 = parse_glm_line(line3 or "")
                if p3 is not None and (p is None or not p3.get("weak")):
                    if not p3.get("pole") and p and p.get("pole"):
                        p3["pole"] = p["pole"]
                    parsed_list[i] = p3
                    if i in dtl_by_idx and len(p3.get("coords") or []) >= 2 and not p3.get("weak"):
                        dtl_by_idx[i]["easting"] = float(p3["coords"][0])
                        dtl_by_idx[i]["northing"] = float(p3["coords"][1])

    rows: list[list[dict]] = []
    for idx, p in enumerate(parsed_list):
        if idx in dtl_by_idx:
            dtl_rows.append(dtl_by_idx[idx])
        if p is None or p.get("portal") or _is_noise_line(p):
            continue
        c = cells_from_parsed(p)
        if c:
            rows.append(c)

    if len(rows) < sum(1 for r in page_rows if len(r) >= 3):
        log.info("bant okuması sayfadan kötü (%d < %d) → sayfa sonucu korundu", len(rows), len(page_rows))
        rows = page_rows
    return _finalize_rows(rows), finalize_dtl_rows(dtl_rows), header_info, len(bands), band_reads


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
@app.post("/ocr/dtl")
async def ocr_document(request: Request, file: UploadFile):
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

    async with _ocr_lock:
        out_pages = []
        all_dtl_rows: list[dict] = []
        dtl_header: dict = {"title": "", "voltage_kv": "", "conductor": "", "line_name": "", "notes": ""}

        for page_idx, raw_page in enumerate(images):
            if await request.is_disconnected():
                log.warning("istemci bağlantıyı kapattı: %s (sayfa %d/%d)", file.filename, page_idx + 1, len(images))
                return JSONResponse(status_code=499, content={"error": "İstemci bağlantıyı kapattı"})
            try:
                original = await asyncio.to_thread(auto_orient_page, raw_page)
                need_hdr = page_idx == 0 or not dtl_header.get("line_name")
                indra_rows, indra_weak, indra_dtl, indra_ms = (await ocr_page_indra(original)) if INDRA_ENABLED else ([], [], [], 0)
                indra_valid = sum(1 for _, r in indra_rows if len(r) >= 3)
                if indra_valid >= INDRA_MIN_ROWS:
                    # GLM dolgusu: Indra'nın eksik bıraktığı bantları tek tek okut
                    for fy0, fy1 in indra_weak[:8]:
                        try:
                            band_img = original[fy0:fy1]
                            if band_img.shape[0] < 12:
                                continue
                            composed = await asyncio.to_thread(compose_band, band_img)
                            line = await glm_read([encode_b64(composed, fmt=".png")], ROW_PROMPT, 160)
                            p2 = parse_glm_line(line or "")
                            if p2 and len(p2.get("coords") or []) >= 2:
                                c2 = cells_from_parsed(p2)
                                if len(c2) >= 3:
                                    indra_rows.append((fy0, c2))
                        except Exception:
                            continue
                    indra_rows.sort(key=lambda t: t[0])
                    rows = _finalize_rows([cells for _, cells in indra_rows])
                    page_dtl_rows = finalize_dtl_rows(indra_dtl)
                    hdr = {}
                    band_count, band_reads = 0, 0
                    log.info("indra kullanıldı: sayfa %d (%dms, %d zayıf)", page_idx + 1, indra_ms, len(indra_weak))
                else:
                    rows, page_dtl_rows, hdr, band_count, band_reads = await ocr_page_glm(
                        original, request=request, read_header=need_hdr
                    )
                if hdr:
                    for k in ("voltage_kv", "conductor", "line_name", "notes", "title"):
                        if hdr.get(k) and not dtl_header.get(k):
                            dtl_header[k] = hdr[k]
                all_dtl_rows.extend(page_dtl_rows)
            except Exception as e:
                log.exception("OCR hatası (sayfa %d)", page_idx + 1)
                return JSONResponse(status_code=500, content={"error": f"OCR hatası: {e}"})

            low_conf = sum(1 for r in rows for c in r if c["conf"] < CONF_THRESHOLD)
            log.info(
                "sayfa %d/%d: satır=%d dtl_satır=%d bant=%d bant_okuma=%d düşük_güven=%d",
                page_idx + 1, len(images), len(rows), len(page_dtl_rows), band_count, band_reads, low_conf,
            )

            out_pages.append(
                {
                    "page": page_idx + 1,
                    "preview": "data:image/jpeg;base64," + await asyncio.to_thread(jpeg_b64, original),
                    "rows": rows,
                    "dtl_rows": page_dtl_rows,
                }
            )
    final_dtl = finalize_dtl_rows(all_dtl_rows)
    log.info(
        "bitti: %s sayfa=%d dtl_toplam=%d süre=%.1fs",
        file.filename, len(out_pages), len(final_dtl), time.time() - t0,
    )
    return {
        "pages": out_pages,
        "pages_count": len(out_pages),
        "dtl_header": dtl_header,
        "dtl_rows": final_dtl,
    }

