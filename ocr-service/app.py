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
VISION_MODEL = os.environ.get("VISION_MODEL", "ptyp-ai")
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.70"))
# Ollama çağrısı kaç kez denenir / kaç sn beklenir (0 = devre dışı)
OLLAMA_ATTEMPTS = int(os.environ.get("OLLAMA_ATTEMPTS", "2"))
OLLAMA_TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT", "240"))
# Aynı anda Ollama'ya gönderilecek bant isteği (OLLAMA_NUM_PARALLEL ile uyumlu tutun)
OCR_CONCURRENCY = max(1, int(os.environ.get("OCR_CONCURRENCY", "1")))
# PDF render ölçeği (taban ölçek; düşük çözünürlüklü sayfalarda otomatik yükseltilir)
PDF_SCALE = float(os.environ.get("PDF_SCALE", "2.5"))
# Düşük çözünürlüklü görüntülerin OCR öncesi büyütüleceği hedef uzun kenar (piksel)
MIN_OCR_LONG_EDGE = int(os.environ.get("MIN_OCR_LONG_EDGE", "3300"))

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
    """PDF'ten sayfa görüntüleri (pypdfium2 — sistem bağımlılığı yok).
    Küçük/düşük boyutlu PDF sayfalarında uzun kenar en az MIN_OCR_LONG_EDGE olacak şekilde ölçeklenir."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(buf)
    pages = []
    try:
        for i in range(len(pdf)):
            page = pdf[i]
            pw, ph = page.get_size()
            long_pt = max(pw, ph, 1.0)
            dyn_scale = max(PDF_SCALE, min(4.0, MIN_OCR_LONG_EDGE / long_pt))
            bitmap = page.render(scale=dyn_scale, grayscale=False)
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


def _dtl_orientation_score(land_img: np.ndarray) -> float:
    """Yatay DTL sayfasının düz (0°) mü yoksa baş aşağı (180°) mı olduğunu puanlar.
    Düz DTL sayfasında:
      1. Üst %5..28 bölgesi (tablo sütun başlıkları) alt %72..95 bölgesinden (imza bloğu) daha fazla yatay çizgi içerir.
      2. Tablo gövdesinde sağ yarı (%50..88: direk tipi, boy, gövde, 6 ayak/uzatma sütunu, kot, izolatör, Y/X koordinatları)
         sol yarıdan (%12..50: çoğu satırda boş olan Some No, Açı, Geçilen Yer) her zaman daha yoğundur."""
    b = binarize(_to_gray(land_img))
    H, W = b.shape
    hk = max(60, W // 20)
    hlines = cv2.morphologyEx(b, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (25, 3)))
    hlines = cv2.morphologyEx(hlines, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (hk, 1)))
    top_h = float((hlines[int(0.05 * H) : int(0.28 * H), :] > 0).mean())
    bot_h = float((hlines[int(0.72 * H) : int(0.95 * H), :] > 0).mean())
    mid_r = float((b[int(0.22 * H) : int(0.75 * H), int(0.50 * W) : int(0.88 * W)] > 0).mean())
    mid_l = float((b[int(0.25 * H) : int(0.78 * H), int(0.12 * W) : int(0.50 * W)] > 0).mean())
    return (top_h - bot_h) * 2.0 + (mid_r - mid_l)


def detect_auto_rotation(img: np.ndarray) -> int:
    """Dikey (portre, h > w) veya ters taranmış yatay DTL tabloları için önerilen saat yönü açısı (0, 90, 180, 270)."""
    h, w = img.shape[:2]
    if h <= w * 1.05:
        return 0 if _dtl_orientation_score(img) >= -0.005 else 180
    cw = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    return 90 if _dtl_orientation_score(cw) >= 0.0 else 270


def deskew_for_ocr(img: np.ndarray) -> tuple[np.ndarray, float]:
    """Indra OCR öncesi gri/anti-aliasing dokusunu bozmadan ince tarama eğimini (skew) düzeltir.
    Eğik sayfalarda (örn. 0.6° eğimde 3300px genişlikte ~35px dikey kayma) sağdaki koordinatların
    alt satıra kaymasını tamamen önler."""
    h, w = img.shape[:2]
    # Çok küçük (ör. <1100px) görüntülerde karakter bacaklarının kopmaması için ılımlı büyütme
    if max(h, w) < 1100:
        s = min(2.2, 1650.0 / max(h, w, 1))
        img = cv2.resize(img, (int(round(w * s)), int(round(h * s))), interpolation=cv2.INTER_CUBIC)
        h, w = img.shape[:2]
    speck = _speck_area(h)
    gray = normalize_background(_to_gray(img))
    ink = remove_specks(binarize(gray), speck)
    skew = 0.0
    for _ in range(2):
        a = estimate_skew(ink)
        if not (0.08 <= abs(a) <= 7.0) or abs(skew + a) > 7.0:
            break
        skew += a
        rot_g = rotate(gray, skew, 255)
        ink = remove_specks(binarize(rot_g), speck)
    if abs(skew) >= 0.08:
        border = (255, 255, 255) if img.ndim == 3 else 255
        img = rotate(img, skew, border)
    return img


def rotate_page_orthogonal(img: np.ndarray, deg: int) -> np.ndarray:
    deg = deg % 360
    if deg == 90:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    if deg == 180:
        return cv2.rotate(img, cv2.ROTATE_180)
    if deg == 270:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return img


def auto_orient_page(img: np.ndarray) -> np.ndarray:
    """Dikey (portre, h > w) taranmış yatay DTL tablolarını otomatik 90° döndürür.
    Düz DTL sayfasında çok sütunlu tablo ızgarası üst/orta bölgede (0.20..0.55 H),
    az dikey çizgili imza bloğu ise alt bölgede (0.80..0.95 H) yer alır."""
    return rotate_page_orthogonal(img, detect_auto_rotation(img))


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

BAND_TEXT_PROMPT = (
    "Text Recognition:"
    if "glm" in VISION_MODEL.lower()
    else "Bu tablo satırındaki tüm hücreleri soldan sağa ' | ' ile ayırarak aynen yaz. Rakamları ve harfleri değiştirme, açıklama ekleme."
)

HEADER_TEXT_PROMPT = (
    "Text Recognition:"
    if "glm" in VISION_MODEL.lower()
    else "Görüntüdeki başlık bilgilerini (Hat adı, Gerilim kV, İletken tipi, Notlar) olduğu gibi oku, açıklama ekleme."
)

COORD_RE = re.compile(r"\b\d{6,7}(?:[.,]\d{1,4})?\b")
# Direk kalıbı: PB1, D-14, P3, DP-2, Direk 5, Portal (kelime sınırı ile ND.1 içindeki D.1 eşleşmez)
POLE_PAT_RE = re.compile(r"(?i)\b(?:direk\s*)?(?:portal|(?:d|p|dp|pb|dm)[-./]?\d{1,4})\b")
# Prompt yankısı sayılan kalıplar (boş bantta model prompt'u tekrar eder)
ECHO_WORDS = ("yalnızca", "formatta", "başka bir şey", "uydurma", "aynen koru", "koordinat değeri")
# Rakam bağlamında sık OCR karışıklıkları (yalnızca rakam veya rakam+nokta sonrasında)
_DIGIT_FIX = {"O": "0", "o": "0", "D": "0", "Q": "0", "l": "1", "I": "1", "i": "1",
              ")": "1", "]": "1", "!": "1",
              "S": "5", "s": "5", "B": "8", "Z": "2", "z": "2", "G": "6", "g": "9", "<": "4"}
_DIGIT_FIX_RE = re.compile(r"(\d\.?)([OoDQlIi\)\]!SsBZzGg<])(?=[\d.OoDQlIi\)\]!SsBZzGg<\s|]|$)")


def _fix_digits(s: str) -> str:
    """Rakamların içinde/sonunda kalan harf benzeri karakterleri rakama çevir
    (ör. 4256O07.4O → 4256007.40, 369O4O.OO → 369040.00, 59232).58 → 592321.58).
    Ardışık karışıklıklar (4OO1, .OO) için üç geçiş uygulanır."""
    for _ in range(3):
        s = _DIGIT_FIX_RE.sub(lambda m: m.group(1) + _DIGIT_FIX[m.group(2)], s)
    return s


def _normalize_coord_str(s: str) -> str:
    """Koordinat metnindeki OCR kaynaklı boşluk, nokta düşmesi ve harf-rakam karışıklıklarını onar."""
    out = (s or "").replace(",", ".")
    # Token başında yutulmuş "5": Indra "594377.00"i "$94377.00" / "$9232).58" okuyabilir.
    # 5 haneye düşünce COORD_RE göremez; "son iki 6-7 haneli sayı" kuralı istasyon hücresini
    # (örn. "22+122.18" → "224122.18") easting sanar (D-65 vakası). Bu yüzden önce onarılmalı.
    out = re.sub(r"(?<![\w.,])([$S])(?=[\d\)\]!Iil]{3,})", "5", out)
    out = re.sub(r"(?<=[\d\s])<(?=\d)", "4", out)
    # 7 haneli Northing'de 7. basamağın ve noktanın ") " / "] " olarak okunması: "423249) 73" → "4232491.73"
    out = re.sub(r"\b([345]\d{5})[\)\]!Iil]\s*(\d{2})\b", r"\g<1>1.\2", out)
    out = _fix_digits(out)
    # Binlik ayırıcı / OCR boşluğu veya düşük çözünürlükte tire/iki nokta: "4 256 007.40", "593-403.70", "592:094.81"
    out = re.sub(r"\b(\d{1,3})[ ](\d{3})[ ](\d{3})(?=\.\d|\b)", r"\1\2\3", out)
    out = re.sub(r"\b(\d{3})[ '’:\-](\d{3})(?=\.\d|\b)", r"\1\2", out)
    out = re.sub(r"\b([345]\d{2,3})[ '’:\-](\d{3,4})(?=\.\d{1,3}\b)", r"\1\2", out)
    # Düşük çözünürlükte 7 haneli Northing veya 6 haneli Easting içinde rastgele basamakta tek boşluk:
    # ör. "4241 148.90" → "4241148.90", "59 2321.58" → "592321.58"
    out = re.sub(
        r"\b([345]\d{1,5})\s+(\d{1,5})(?=\.\d{1,3}\b)",
        lambda m: (m.group(1) + m.group(2)) if len(m.group(1) + m.group(2)) == 7 else m.group(0),
        out,
    )
    out = re.sub(
        r"\b([2-8]\d{1,4})\s+(\d{1,4})(?=\.\d{1,3}\b)",
        lambda m: (m.group(1) + m.group(2)) if len(m.group(1) + m.group(2)) == 6 else m.group(0),
        out,
    )
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
                        "num_ctx": 2048 if num_predict <= 200 else 4096,
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
                resp = (r.json().get("response") or "").strip()
                if "<think>" in resp:
                    resp = re.sub(r"<think>.*?</think>", "", resp, flags=re.S).strip()
                return resp or None
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
    r"(?i)(?:(?P<func>\b(?:KD|KT|BD|N|D|T|A|B|C)\b)\s+)?"
    r"(?:(?P<pole2>(?:(?:MEV\.?\s*)?(?:D|DP|PB|DM)[.-]?\s*)?\d{1,3}(?:\s*\([A-Z0-9]+\))?)\s+)?"
    r"(?P<ttype>\b(?:C?P[A-F](?:\d|H)?(?:\([A-Z0-9]+\))?|[1-4]P[A-F]\d?(?:\([A-Z0-9]+\))?|2F[SN]\d?|[1-4][A-Z]\d?|(?:K|G|T|D|N|PB|PA|PC|PD|PE|PF)[-./]?\d{1,3}))\s+"
    r"(?P<height>\d{1,2}(?:\.\d)?)"
    r"(?:\s+(?P<body_ext>[+-]?\d{1,2})(?!\.\d)\b)?"
)


def _normalize_ttype_tokens(s: str) -> str:
    """Indra/GLM OCR kaynaklı direk tipi harf-rakam karışıklıklarını (PAI→PA1, PBI→PB1,
    PFl(N)→PF1(N), PEI(N)→PF1(N), 2FNI→2FN1, 3PBI→3PB1, CPEH(N→CPFH(N), PF]→PF1,
    PSI→PB1, 'PB 1 26'→'PB1 26' vb.) onarır."""
    s = re.sub(
        r"\b(C?P[A-F][0-9IilT\]\):H]?|[1-4]P[A-F][0-9IilT\]\):]?|2F[SN][0-9IilT\]\):]?)\(([NS])\b(?!\))",
        r"\1(\2)",
        s,
        flags=re.I,
    )
    s = re.sub(r"\bCPEH\b", "CPFH", s, flags=re.I)
    s = re.sub(r"\bPS[1IilT\]\):]?\b", "PB1", s, flags=re.I)
    s = re.sub(r"\bPE[1IilT\]\):]?\s*\(N\)", "PF1(N)", s, flags=re.I)
    s = re.sub(r"\b(C?P[A-F]|[1-4]P[A-F]|2F[SN])[IilT\]\):](?=\b|\(|$|\s)", r"\g<1>1", s)
    # Düşük çözünürlükte direk tipi ile alt-seri rakamı arasına boşluk girmesi: "PB 1 26" → "PB1 26"
    s = re.sub(r"\b(C?P[A-F]|[1-4]P[A-F]|2F[SN])\s+([12])\s+(?=[1-5]\d\b)", r"\1\2 ", s, flags=re.I)
    return s


def normalize_crossing(raw: str) -> str:
    s = re.sub(r"[|]+", " ", raw or "")
    s = re.sub(r"\s+", " ", s).strip(" -.,;")
    if not s:
        return ""
    u = s.upper()
    # Özel isimli veya detaylı geçiş açıklamalarını (otoyol, katener, adlandırılmış EİH, doğal gaz boru hattı vb.) olduğu gibi koru
    if any(
        k in u
        for k in (
            "PLANLANAN",
            "OTOYOL",
            "OTO YOL",
            "KATENER",
            "BORU HATTI",
            "HABAŞ",
            "GES",
            "HES",
            "RES",
            "TM",
        )
    ):
        s = re.sub(r"\.\s*(?=(?:400|380|154)\s*kV\b)", ", ", s, flags=re.I)
        s = re.sub(r"M[İI]HAL[İIO]C?[ÇC]IK", "MİHALIÇÇIK", s, flags=re.I)
        s = re.sub(r"\bIZMIR\b", "İZMİR", s)
        return s
    items: list[str] = []
    if "400" in u and any(k in u for k in ("E.İ.H", "E.I.H", "E.LH", "E.L.H", "E I H", "E L H", "EİH", "EIH", "KV")):
        items.append("400 kV E.İ.H.")
    elif "380" in u and any(k in u for k in ("E.İ.H", "E.I.H", "E.LH", "E.L.H", "E I H", "E L H", "EİH", "EIH", "KV")):
        items.append("380 kV E.İ.H.")
    elif "154" in u and any(k in u for k in ("E.İ.H", "E.I.H", "E.LH", "E.L.H", "E I H", "E L H", "EİH", "EIH", "KV")):
        items.append("154 kV E.İ.H.")
    elif any(k in u for k in ("34.5", "34,5", "E.İ.H", "E.I.H", "E.LH", "E.L.H", "E I H", "E L H", "EİH", "EIH")):
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
    if (("ÖZEL" in u or "OZEL" in u or "ZEL" in u) and any(k in u for k in ("ASK", "ASL", "TAK", "TOK"))) or (
        "ASKI" in u and ("TAK" in u or "TOK" in u)
    ):
        items.append("Özel Askı Takımı")
    if "KATOD" in u or "KATAT" in u:
        items.append("Katodik Koruma")
    if "BRAN" in u and ("DİR" in u or "DIR" in u):
        items.append("Branşman Direği")
    if "BAĞLANTI" in u or "BAGLANTI" in u or "BABLANTI" in u:
        items.append("BAĞLANTI ANLAŞ.")
    if "KAP." in u and any(k in u for k in ("YAP", "GAP")):
        items.append("KAP. YAPILACAKTIR.")
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
    s = re.sub(r"\b(\d{1,3})\s*[*+]\s*(\d{3})[., ](\d{2})\b(?!\+)", r"\1+\2.\3", s)
    s = re.sub(r"\b(\d{1,3})-(\d{3})[., ](\d{2})\b(?!\+)", r"\1+\2.\3", s)
    s = re.sub(r"\b(\d{1,3}\+\d{3})(\d{2})\b(?!\.\d)", r"\1.\2", s)
    s = re.sub(r"\b(\d{1,3}\+\d{3})\s+(\d{2})\b(?!\.\d)", r"\1.\2", s)
    s = re.sub(r"\b(\d{6,7})\s+(\d{2})\b(?!\.\d)", r"\1.\2", s)
    # 4 ondalıklı grad açısında nokta yerine iki nokta veya boşluk: "215:0850" / "218 0686" → "215.0850"
    s = re.sub(r"\b([123]\d{2})[:\s](\d{4})\b", r"\1.\2", s)
    s = re.sub(r"\b([12]\d{3}|[5-9]\d{2})\s+(\d{2})\b(?!\.\d)(?!\+)", r"\1.\2", s)
    s = re.sub(r"\b([12]\d{3}|[5-9]\d{2})(\d{2})(?=\s+(?:[ÇC]?G|G/|[ÇC]?A\b|\d{1,2}(?:/\d{1,2})?\b|U\d{2,3}))", r"\1.\2", s, flags=re.I)
    s = re.sub(r"^(\s*(?:PORTAL\.?|\d{1,3}(?:\([A-Z0-9]+\))?)\s+\d{2,3})(?:\s+|)(\d{2})\b(?!\.\d)", r"\1.\2", s, flags=re.I)
    # İşaretsiz veya işaretli "0 00" (hook_diff_m) onarımı "10 50" kuralından ÖNCE çalışmalı ki (?<=\.\d{2}\s) tetiklensin
    s = re.sub(r"(?<!\S)([+-]?0)\s+([05]0)\b(?!\.\d)", r"\1.\2", s)
    s = re.sub(r"(?<![+\d.])\b(8|9|10|11|12|13)50\b(?!\.\d)", r"\1.50", s)
    s = re.sub(r"(?<=\.\d{2}\s)(8|9|10|11|12|13)\s+([05]0)\b(?!\.\d)", r"\1.\2", s)

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

    s = _normalize_ttype_tokens(s)
    m = DTL_CENTER_RE.search(s)
    if not m:
        return None
    left = s[: m.start()].strip()
    right = s[m.end() :].strip()

    func = (m.group("func") or "").upper()
    pole2 = re.sub(r"\s+", "", (m.group("pole2") or "").strip())
    raw_ttype = m.group("ttype").upper()
    if not func and ("(N)" in raw_ttype or "(S)" in raw_ttype):
        func = "N"
    ttype = re.sub(r"\([A-Z0-9]+\)$", "", raw_ttype)
    height = float(m.group("height"))
    body_ext = float(m.group("body_ext")) if m.group("body_ext") is not None else None

    m_p1 = re.match(
        r"^((?:(?:MEV\.?\s*)?(?:D|DP|PB|DM)[.-]?\s*)?\d{1,3}(?:\([A-Z0-9]+\))?)(?:\s+(.*)|$)",
        left,
        flags=re.I,
    )
    if m_p1:
        pole = re.sub(r"\s+", "", m_p1.group(1))
        left_rest = (m_p1.group(2) or "").strip()
    else:
        pole = pole2
        left_rest = left
    pole = re.sub(r"(?i)\(N\)", "(S)", pole)
    if not func and "(S)" in pole:
        func = "N"

    m_st = re.search(r"\b(\d{1,3})\+(\d{3}(?:\.\d{1,2})?)\b", left_rest)
    if not m_st:
        # Düşük çözünürlükte kilometraj "+" işaretinin "4" veya "1" okunması: "74085.26" → "7+085.26"
        left_rest_fixed = re.sub(r"\b(\d{1,2})[41](\d{3}\.\d{2})\b", r"\1+\2", left_rest, count=1)
        if left_rest_fixed != left_rest:
            left_rest = left_rest_fixed
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
    m_some = re.search(r"(?i)(?:^|\b)(ND\.?\s*[12]|[S85$][.\s]\s*\d{1,2}|S\.I)\b", after_st)
    if m_some:
        raw_some = re.sub(r"\s+", "", m_some.group(1).upper()).replace("S.I", "S.1")
        if raw_some in ("ND1", "ND2"):
            some_no = "ND." + raw_some[-1]
        elif raw_some[0] in ("S", "8", "5", "$"):
            digits = re.sub(r"\D+", "", raw_some[1:])
            some_no = f"S.{digits}" if digits else raw_some
        else:
            some_no = raw_some
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
    elif ins_count:
        ins_set = "A" if func == "T" else "ÇGÇG"
    else:
        ins_set = ""

    ext_nums = [float(x) for x in re.findall(r"[+-]?\d+(?:\.\d+)?", ext_part)]
    hook_diff = ext_nums[0] if len(ext_nums) >= 1 else None
    center_ext = ext_nums[1] if len(ext_nums) >= 2 else None
    legs: list[int | None] = [int(x) for x in ext_nums[2:6]]
    if legs:
        while len(legs) < 4:
            legs.append(legs[-1])
    else:
        legs = [None, None, None, None]

    tail_nums = re.findall(r"\b\d\b", tail_right)
    profile_no = int(tail_nums[-2]) if len(tail_nums) >= 2 else None
    ice_zone = int(tail_nums[-1]) if len(tail_nums) >= 2 else None
    remarks_raw = re.sub(r"(?i)(?:^|\s+)[1-9Iil]\.?(?:\s+[1-9Iil]\.?)?\s*$", "", tail_right).strip()
    remarks = normalize_remarks(remarks_raw)
    if func == "BD" and not remarks:
        remarks = "Branşman Direği"

    if not func:
        func = "T" if ins_set in ("A", "ÇA") else "KD"

    h0_default = 13.0 if ttype.startswith(("PD", "PE", "PF")) else 16.0
    if body_ext is not None and body_ext != 0 and height is not None:
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


def _find_valid_offset_runs(offsets: list[int | None], min_run: int = 3) -> list[tuple[int, int, int]]:
    """En az `min_run` uzunluğundaki tüm ardışık sabit-ofset koşularını (başlangıç, bitiş, ofset) döner."""
    runs: list[tuple[int, int, int]] = []
    cur_off: int | None = None
    cur_start = 0
    for idx, o in enumerate(offsets + [None]):
        if o is not None and o == cur_off:
            continue
        if cur_off is not None and idx - cur_start >= min_run:
            runs.append((cur_start, idx - 1, cur_off))
        cur_off = o
        cur_start = idx
    return runs


def _infer_pole_from_runs(t_idx: int, raw_pole: str, runs: list[tuple[int, int, int]], locked: bool = False) -> str | None:
    """Çok bölümlü DTL'lerde (ör. 1..28 + 12..64 + D.13..D.14) geçerli koşuları (>=3) ve
    ön-ekli direkleri (D.13, PORTAL vb.) korur; yalnız koşu içindeki/bitişiğindeki tekil OCR
    sapmalarını onarır."""
    if not runs:
        return None
    s = (raw_pole or "").strip()
    if s and not re.fullmatch(r"\d{1,3}(?:\([A-Z0-9]+\))?", s, flags=re.I):
        return None  # PORTAL, D.13, MEV.D.1 gibi özel adlara dokunma
    for a, b, _ in runs:
        if a <= t_idx <= b:
            return None  # Zaten >=3 uzunluklu geçerli bir ardışık dizinin parçası
    # İki aynı ofsetli koşunun arasında kalmış tekil/ardışık satır (kesinlikle aynı serinin parçasıdır, locked olsa bile onarılır)
    for idx in range(len(runs) - 1):
        _, b1, off1 = runs[idx]
        a2, _, off2 = runs[idx + 1]
        if b1 < t_idx < a2 and off1 == off2 and off1 + t_idx >= 1:
            return str(off1 + t_idx)
    if locked:
        return None
    # Tek bir koşunun hemen başında/sonunda (<=2 satır mesafede) kalmış satır
    best_off = None
    best_dist = 999
    for a, b, off in runs:
        dist = (a - t_idx) if t_idx < a else (t_idx - b)
        if dist <= 2 and dist < best_dist and off + t_idx >= 1:
            best_dist = dist
            best_off = off
    return str(best_off + t_idx) if best_off is not None else None


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
        pole_str = str(r.get("pole") or "").strip()
        m = re.fullmatch(r"(\d{1,3})(?:\([A-Z0-9]+\))?", pole_str, flags=re.I)
        offsets.append(int(m.group(1)) - t_idx if m else None)

    runs = _find_valid_offset_runs(offsets, min_run=3)
    if runs:
        for t_idx, row_idx in enumerate(tower_indices):
            r = out[row_idx]
            pole_str = str(r.get("pole") or "").strip()
            want = _infer_pole_from_runs(t_idx, pole_str, runs, locked=bool(r.get("pole_locked")))
            if want is not None:
                m_suf = re.search(r"(\([A-Z0-9]+\))$", pole_str, flags=re.I)
                suffix = m_suf.group(1).upper() if m_suf else ""
                r["pole"] = f"{want}{suffix}"

    # Tablodaki tüm P-serisi direkler 1 alt-serisiyse (PA1, PB1, PD1, PE1, PF1), hücre çizgisine
    # değdiği için "1"i düşmüş çıplak PA/PB/PC/PD/PE/PF tiplerini tamamla
    series_digits = [
        m.group(1)
        for r in out
        for m in [re.fullmatch(r"C?P[A-F](\d)", str(r.get("tower_type") or ""))]
        if m
    ]
    if len(series_digits) >= 5 and set(series_digits) == {"1"}:
        for r in out:
            tt = str(r.get("tower_type") or "")
            if re.fullmatch(r"P[A-F]", tt):
                r["tower_type"] = tt + "1"

    # İleri ve geri geçişle eksik istasyon (station_m) değerlerini ara mesafeden (span_m) tamamla
    for i in range(len(tower_indices) - 1):
        cur = out[tower_indices[i]]
        nxt = out[tower_indices[i + 1]]
        m_c = re.fullmatch(r"(\d{1,3})(?:\([A-Z0-9]+\))?", str(cur.get("pole") or "").strip(), flags=re.I)
        m_n = re.fullmatch(r"(\d{1,3})(?:\([A-Z0-9]+\))?", str(nxt.get("pole") or "").strip(), flags=re.I)
        if not (m_c and m_n and int(m_n.group(1)) == int(m_c.group(1)) + 1):
            continue
        cur_st, nxt_st, cur_sp = cur.get("station_m"), nxt.get("station_m"), cur.get("span_m")
        if cur_st is not None and cur_sp is not None and nxt_st is None:
            inferred = round(cur_st + cur_sp, 2)
            nxt["station_m"] = inferred
            nxt["station_text"] = _fmt_station(inferred)

    for i in range(len(tower_indices) - 2, -1, -1):
        cur = out[tower_indices[i]]
        nxt = out[tower_indices[i + 1]]
        m_c = re.fullmatch(r"(\d{1,3})(?:\([A-Z0-9]+\))?", str(cur.get("pole") or "").strip(), flags=re.I)
        m_n = re.fullmatch(r"(\d{1,3})(?:\([A-Z0-9]+\))?", str(nxt.get("pole") or "").strip(), flags=re.I)
        if not (m_c and m_n and int(m_n.group(1)) == int(m_c.group(1)) + 1):
            continue
        cur_st, nxt_st, cur_sp = cur.get("station_m"), nxt.get("station_m"), cur.get("span_m")
        if nxt_st is not None and cur_sp is not None and cur_st is None:
            inferred = round(nxt_st - cur_sp, 2)
            if inferred >= 0:
                cur["station_m"] = inferred
                cur["station_text"] = _fmt_station(inferred)

    for i in range(len(tower_indices) - 1):
        cur = out[tower_indices[i]]
        nxt = out[tower_indices[i + 1]]
        m_c = re.fullmatch(r"(\d{1,3})(?:\([A-Z0-9]+\))?", str(cur.get("pole") or "").strip(), flags=re.I)
        m_n = re.fullmatch(r"(\d{1,3})(?:\([A-Z0-9]+\))?", str(nxt.get("pole") or "").strip(), flags=re.I)
        if not (m_c and m_n and int(m_n.group(1)) == int(m_c.group(1)) + 1):
            continue
        cur_st, nxt_st, cur_sp = cur.get("station_m"), nxt.get("station_m"), cur.get("span_m")
        if cur_st is not None and nxt_st is not None and cur_sp is not None:
            expected_next = round(cur_st + cur_sp, 2)
            if abs(nxt_st - expected_next) > 1.0:
                fixed_cur_st = round(nxt_st - cur_sp, 2)
                # Sonraki direğin istasyonu da hatalıysa (ör. cur_st + cur_sp + nxt_sp == nxt2_st), nxt_st'yi onar
                nxt2_ok = False
                if i + 2 < len(tower_indices):
                    nxt2 = out[tower_indices[i + 2]]
                    nxt_sp, nxt2_st = nxt.get("span_m"), nxt2.get("station_m")
                    if nxt_sp is not None and nxt2_st is not None and abs(( expected_next + nxt_sp ) - nxt2_st) <= 1.5:
                        nxt["station_m"] = expected_next
                        nxt["station_text"] = _fmt_station(expected_next)
                        nxt2_ok = True
                if not nxt2_ok:
                    if fixed_cur_st >= 0 and abs(fixed_cur_st - cur_st) >= 900:
                        cur["station_m"] = fixed_cur_st
                        cur["station_text"] = _fmt_station(fixed_cur_st)
                    elif nxt_st > cur_st and (nxt_st - cur_st) < 1200:
                        wsp = cur.get("wind_span_m")
                        if cur_sp is None or wsp is None or abs((nxt_st - cur_st) - wsp) <= 85:
                            cur["span_m"] = round(nxt_st - cur_st, 2)

    return out


async def extract_dtl_header_from_page(prep: PreparedPage) -> dict:
    """Sayfanın üst başlık bloğundan gerilim, iletken ve hat adını okur."""
    h, w = prep.gray.shape
    top_crop = prep.gray[0 : int(h * 0.22), int(w * 0.05) : int(w * 0.75)]
    text = await glm_read([encode_b64(top_crop, max_w=1600, fmt=".png")], HEADER_TEXT_PROMPT, 160)
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


def _single_digit_variants(coord_str: str) -> list[tuple[str, float]]:
    """Koordinatın tam sayı kısmındaki tekil rakam hatalarını (0-9 değişimi) üretir."""
    s = str(coord_str).replace(",", ".").strip()
    parts = s.split(".", 1)
    int_p = parts[0]
    dec_p = "." + parts[1] if len(parts) > 1 else ""
    if not int_p.isdigit():
        return []
    out: list[tuple[str, float]] = []
    for idx in range(len(int_p)):
        orig_ch = int_p[idx]
        for d in "0123456789":
            if d == orig_ch:
                continue
            if idx == 0 and d == "0":
                continue
            cand_s = int_p[:idx] + d + int_p[idx + 1 :] + dec_p
            val = _num(cand_s)
            if val is not None:
                out.append((cand_s, val))
    return out


def _heal_coarse_prefix(coord_str: str, ref_val: float, max_dist: float = 2600.0) -> tuple[str, float] | None:
    """100k / 10k / 1k basamaklarındaki kaba OCR sapmalarını (ör. 414xxxx veya 434xxxx -> 424xxxx)
    veya tek basamak düşmesini (ör. 53058.47 -> 593058.47) komşu/medyan referansına göre düzeltir."""
    s = str(coord_str).replace(",", ".").strip()
    parts = s.split(".", 1)
    int_p = parts[0]
    dec_p = "." + parts[1] if len(parts) > 1 else ""
    ref_int = str(int(round(ref_val)))
    if not int_p.isdigit():
        return None
    best_s, best_v, best_d = None, 0.0, max_dist
    if len(int_p) == len(ref_int) - 1:
        for idx in range(len(int_p) + 1):
            for d in "0123456789":
                if idx == 0 and d == "0":
                    continue
                cand_s = int_p[:idx] + d + int_p[idx:] + dec_p
                v = _num(cand_s)
                if v is not None and abs(v - ref_val) < best_d:
                    best_s, best_v, best_d = cand_s, v, abs(v - ref_val)
        return (best_s, best_v) if best_s is not None else None
    if len(int_p) != len(ref_int):
        return None
    # Önce komşu önekinden 1..3 hane kopyalamayı dene
    for k in (1, 2, 3):
        if k < len(int_p):
            cand_s = ref_int[:k] + int_p[k:] + dec_p
            v = _num(cand_s)
            if v is not None and abs(v - ref_val) < best_d:
                best_s, best_v, best_d = cand_s, v, abs(v - ref_val)
    # Tek basamak değişimlerini dene
    for cand_s, v in _single_digit_variants(s):
        if abs(v - ref_val) < best_d:
            best_s, best_v, best_d = cand_s, v, abs(v - ref_val)
    if best_s is not None:
        return best_s, best_v
    return None


def _finalize_rows(rows: list[list[dict]], dtl_rows: list[dict] | None = None) -> list[list[dict]]:
    """DTL tablolarında direkler sıralıdır (1'er artar) ve güzergah tekdüze
    ilerler. Adımlar:
      1. Ters okunmuş (X|Y) satırları düzelt (Easting 6 hane / Northing 7 hane)
      2. Aynı koordinatlı tekrar satırları at (bölünen bant / model tekrarı)
      3. Direk numarasını çoğunluk (mod) çapasıyla tamamla
      4. Kaba önek (100k/10k) ve tek-basamaklı koordinat hatalarını ara mesafe (span_m)
         ve güzergah doğrusallığı (kolineerlik) ile matematiksel olarak onar
      5. Onarılamayan aykırı/zigzag koordinatları düşük güvenle (0.4) işaretle."""
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

    # 3. Direk numarası — geçerli ardışık koşuları (>=3) ve ön-ekli adları (D.13, PORTAL) koru;
    # yalnız koşu içindeki/bitişiğindeki tekil OCR sapmalarını onar
    offsets: list[int | None] = []
    for i, r in enumerate(valid):
        t = r[0]["text"].strip()
        m = re.fullmatch(r"(\d{1,3})(?:\([A-Z0-9]+\))?", t, flags=re.I)
        offsets.append(int(m.group(1)) - i if m else None)
    runs = _find_valid_offset_runs(offsets, min_run=3)
    if runs:
        for i, r in enumerate(valid):
            t = r[0]["text"].strip()
            want = _infer_pole_from_runs(i, t, runs, locked=bool(r[0].get("locked")))
            if want is not None and t != want:
                r[0]["text"] = want
                r[0]["conf"] = 0.7  # sıradan tamamlandı (belirsiz sayılmaz)

    # 3b. DTL satırlarından direk bazlı ara mesafe (span_m) eşlemesi
    span_by_pole: dict[str, float] = {}
    dtl_by_pole: dict[str, dict] = {}
    if dtl_rows:
        for d in dtl_rows:
            pk = re.sub(r"\(.*\)", "", str(d.get("pole") or "")).strip()
            if pk:
                dtl_by_pole[pk] = d
                sp = d.get("span_m")
                if isinstance(sp, (int, float)) and 5.0 <= float(sp) <= 1500.0:
                    span_by_pole[pk] = float(sp)

    def _pole_int(idx: int) -> int | None:
        t = re.sub(r"\(.*\)", "", valid[idx][0]["text"].strip()).strip()
        return int(t) if t.isdigit() else None

    def _expected_span(idx: int) -> float | None:
        if idx < 0 or idx + 1 >= len(valid):
            return None
        p_cur, p_nxt = _pole_int(idx), _pole_int(idx + 1)
        if p_cur is not None and p_nxt is not None and p_nxt == p_cur + 1:
            return span_by_pole.get(str(p_cur))
        return None

    def _sync_dtl_coord(idx: int, e_val: float, n_val: float) -> None:
        pk = re.sub(r"\(.*\)", "", valid[idx][0]["text"].strip()).strip()
        if pk in dtl_by_pole:
            dtl_by_pole[pk]["easting"] = round(e_val, 2)
            dtl_by_pole[pk]["northing"] = round(n_val, 2)

    # 4a. Kaba önek (100k / 10k) sapmalarını komşu/medyan referansıyla onar
    es = np.array([_num(r[1]["text"]) or 0.0 for r in valid])
    ns = np.array([_num(r[2]["text"]) or 0.0 for r in valid])
    me, mn = float(np.median(es)), float(np.median(ns))
    for i, r in enumerate(valid):
        ei, ni = float(es[i]), float(ns[i])
        if abs(ei - me) > 8000.0 or abs(ni - mn) > 8000.0:
            # En yakın güvenilir komşuyu bul
            ref_e, ref_n = me, mn
            for j in (i - 1, i + 1, i - 2, i + 2):
                if 0 <= j < len(valid) and abs(es[j] - me) <= 8000.0 and abs(ns[j] - mn) <= 8000.0:
                    ref_e, ref_n = float(es[j]), float(ns[j])
                    break
            if abs(ei - ref_e) > 8000.0:
                healed_e = _heal_coarse_prefix(r[1]["text"], ref_e)
                if healed_e is not None:
                    r[1]["text"], es[i] = healed_e[0], healed_e[1]
            if abs(ni - ref_n) > 8000.0:
                healed_n = _heal_coarse_prefix(r[2]["text"], ref_n)
                if healed_n is not None:
                    r[2]["text"], ns[i] = healed_n[0], healed_n[1]
            _sync_dtl_coord(i, float(es[i]), float(ns[i]))

    # 4b. Tek-basamaklı koordinat hatalarını (1000m / 100m / 10m sıçramaları) ara mesafe (span_m)
    # ve güzergah doğrusallığıyla matematiksel olarak onar
    if len(valid) >= 3:
        pts = [(float(es[k]), float(ns[k])) for k in range(len(valid))]
        dists = [float(np.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1])) for k in range(len(pts) - 1)]
        pos_d = [d for d in dists if 5.0 < d < 1500.0]
        med_span = float(np.median(pos_d)) if pos_d else 300.0

        for i in range(1, len(pts) - 1):
            p_prev, p_cur, p_next = pts[i - 1], pts[i], pts[i + 1]
            d_prev = float(np.hypot(p_cur[0] - p_prev[0], p_cur[1] - p_prev[1]))
            d_next = float(np.hypot(p_next[0] - p_cur[0], p_next[1] - p_cur[1]))
            d_bridge = float(np.hypot(p_next[0] - p_prev[0], p_next[1] - p_prev[1]))
            detour = (d_prev + d_next) - d_bridge
            dot = (p_cur[0] - p_prev[0]) * (p_next[0] - p_cur[0]) + (p_cur[1] - p_prev[1]) * (p_next[1] - p_cur[1])
            s_prev = _expected_span(i - 1)
            s_curr = _expected_span(i)

            bad_span = (s_prev is not None and abs(d_prev - s_prev) > 5.5) or (
                s_curr is not None and abs(d_next - s_curr) > 5.5
            )
            bad_geom = (
                detour > max(60.0, 0.16 * d_bridge)
                or (dot < 0 and min(d_prev, d_next) > 55.0)
                or max(d_prev, d_next) > max(1150.0, med_span * 3.4)
            )
            if not (bad_span or bad_geom):
                continue

            e_str, n_str = valid[i][1]["text"], valid[i][2]["text"]
            cands: list[tuple[str, str, float, float]] = []
            for ce_s, ce_v in _single_digit_variants(e_str):
                cands.append((ce_s, n_str, ce_v, p_cur[1]))
            for cn_s, cn_v in _single_digit_variants(n_str):
                cands.append((e_str, cn_s, p_cur[0], cn_v))

            old_sp_err = (abs(d_prev - s_prev) if s_prev is not None else 0.0) + (
                abs(d_next - s_curr) if s_curr is not None else 0.0
            )
            best_cand = None
            best_score = float("inf")
            for ce_s, cn_s, ce_v, cn_v in cands:
                dp = float(np.hypot(ce_v - p_prev[0], cn_v - p_prev[1]))
                dn = float(np.hypot(p_next[0] - ce_v, p_next[1] - cn_v))
                det_new = (dp + dn) - d_bridge
                dot_new = (ce_v - p_prev[0]) * (p_next[0] - ce_v) + (cn_v - p_prev[1]) * (p_next[1] - cn_v)

                # 1. Kriter: Ara mesafe (span_m) uyumu
                if s_prev is not None or s_curr is not None:
                    sp_err = (abs(dp - s_prev) if s_prev is not None else 0.0) + (
                        abs(dn - s_curr) if s_curr is not None else 0.0
                    )
                    max_single_err = max(
                        abs(dp - s_prev) if s_prev is not None else 0.0,
                        abs(dn - s_curr) if s_curr is not None else 0.0,
                    )
                    if (
                        (max_single_err <= 5.5 and (old_sp_err - sp_err) >= 14.0 and det_new <= max(25.0, detour + 5.0))
                        or (
                            s_prev is not None
                            and s_curr is not None
                            and max_single_err <= 1.8
                            and sp_err <= 2.5
                            and (old_sp_err - sp_err) >= 6.0
                            and det_new <= max(12.0, detour + 2.0)
                        )
                    ):
                        score = sp_err + 0.15 * max(0.0, det_new)
                        if score < best_score:
                            best_score = score
                            best_cand = (ce_s, cn_s, ce_v, cn_v)
                            continue
                    if (
                        s_prev is not None
                        and abs(d_prev - s_prev) >= 200.0
                        and abs(dp - s_prev) <= 3.5
                        and i >= 2
                    ):
                        v_prev = (p_prev[0] - pts[i - 2][0], p_prev[1] - pts[i - 2][1])
                        v_cur = (ce_v - p_prev[0], cn_v - p_prev[1])
                        n1 = float(np.hypot(v_prev[0], v_prev[1]))
                        n2 = float(np.hypot(v_cur[0], v_cur[1]))
                        cos_a = (v_prev[0] * v_cur[0] + v_prev[1] * v_cur[1]) / (n1 * n2) if (n1 > 10 and n2 > 10) else 0.0
                        if cos_a >= 0.80:
                            score = abs(dp - s_prev) + (1.0 - cos_a) * 5.0
                            if score < best_score:
                                best_score = score
                                best_cand = (ce_s, cn_s, ce_v, cn_v)
                                continue

                # 2. Kriter: Saf geometrik üçgen sapma (zigzag/detour) giderimi (span_m hatalı/eksik olsa bile)
                if (
                    d_bridge < max(1400.0, med_span * 4.2)
                    and min(d_prev, d_next) > max(180.0, d_bridge * 0.62)
                    and dot_new > 0
                    and dp <= d_prev - 50.0
                    and dn <= d_next - 50.0
                    and det_new <= max(22.0, 0.055 * d_bridge)
                    and (detour - det_new) >= 140.0
                    and 0.12 * d_bridge <= dp <= 0.88 * d_bridge
                ):
                    score = 10.0 + det_new + 0.08 * abs(dp - 0.5 * d_bridge)
                    if score < best_score:
                        best_score = score
                        best_cand = (ce_s, cn_s, ce_v, cn_v)
                        continue

            if best_cand is not None:
                ce_s, cn_s, ce_v, cn_v = best_cand
                valid[i][1]["text"] = ce_s
                valid[i][2]["text"] = cn_s
                valid[i][1]["conf"] = max(float(valid[i][1].get("conf") or 0.0), 0.86)
                valid[i][2]["conf"] = max(float(valid[i][2].get("conf") or 0.0), 0.86)
                pts[i] = (ce_v, cn_v)
                es[i], ns[i] = ce_v, cn_v
                _sync_dtl_coord(i, ce_v, cn_v)

        # Uç noktalar (i=0 ve i=n-1) için span_m kontrolü
        for end_i, nbr_i, nxt_i, sp_idx in ((0, 1, 2, 0), (len(pts) - 1, len(pts) - 2, len(pts) - 3, len(pts) - 2)):
            if not (0 <= nxt_i < len(pts)):
                continue
            sp_exp = _expected_span(sp_idx)
            if sp_exp is None:
                continue
            p_end, p_nbr, p_nxt = pts[end_i], pts[nbr_i], pts[nxt_i]
            d_cur = float(np.hypot(p_end[0] - p_nbr[0], p_end[1] - p_nbr[1]))
            if abs(d_cur - sp_exp) <= 16.0:
                continue
            e_str, n_str = valid[end_i][1]["text"], valid[end_i][2]["text"]
            cands = [(ce_s, n_str, ce_v, p_end[1]) for ce_s, ce_v in _single_digit_variants(e_str)] + [
                (e_str, cn_s, p_end[0], cn_v) for cn_s, cn_v in _single_digit_variants(n_str)
            ]
            best_cand, best_err = None, 4.5
            for ce_s, cn_s, ce_v, cn_v in cands:
                d_new = float(np.hypot(ce_v - p_nbr[0], cn_v - p_nbr[1]))
                err = abs(d_new - sp_exp)
                # Komşu vektörle aynı yönde ilerlemeli
                v1 = (p_nbr[0] - p_nxt[0], p_nbr[1] - p_nxt[1])
                v2 = (ce_v - p_nbr[0], cn_v - p_nbr[1])
                if err < best_err and (v1[0] * v2[0] + v1[1] * v2[1]) > 0:
                    best_err = err
                    best_cand = (ce_s, cn_s, ce_v, cn_v)
            if best_cand is not None:
                ce_s, cn_s, ce_v, cn_v = best_cand
                valid[end_i][1]["text"] = ce_s
                valid[end_i][2]["text"] = cn_s
                valid[end_i][1]["conf"] = max(float(valid[end_i][1].get("conf") or 0.0), 0.86)
                valid[end_i][2]["conf"] = max(float(valid[end_i][2].get("conf") or 0.0), 0.86)
                pts[end_i] = (ce_v, cn_v)
                es[end_i], ns[end_i] = ce_v, cn_v
                _sync_dtl_coord(end_i, ce_v, cn_v)

    # 5. Aykırı değerler ve kalan zigzag tespiti
    ys = np.array([_num(r[1]["text"]) or 0.0 for r in valid])
    xs = np.array([_num(r[2]["text"]) or 0.0 for r in valid])
    my, mx = float(np.median(ys)), float(np.median(xs))
    inlier = []
    for r, y, x in zip(valid, ys, xs):
        bad = abs(y - my) > OUTLIER_M or abs(x - mx) > OUTLIER_M
        if bad:
            r[1]["conf"] = r[2]["conf"] = 0.4
        inlier.append(not bad)

    if len(valid) >= 4:
        pts = [(_num(r[1]["text"]) or 0.0, _num(r[2]["text"]) or 0.0) for r in valid]
        dists = [float(np.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1])) for k in range(len(pts) - 1)]
        pos_d = [d for d in dists if d > 0]
        med_span = float(np.median(pos_d)) if pos_d else 300.0
        thr = max(1200.0, med_span * 4.0)
        for i in range(1, len(pts) - 1):
            d_prev = dists[i - 1]
            d_next = dists[i]
            d_bridge = float(np.hypot(pts[i + 1][0] - pts[i - 1][0], pts[i + 1][1] - pts[i - 1][1]))
            if min(d_prev, d_next) > thr and d_bridge < 0.7 * min(d_prev, d_next):
                valid[i][1]["conf"] = valid[i][2]["conf"] = 0.4

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
    s = _normalize_ttype_tokens(joined)
    # İstasyon (km+metre)
    m_st = re.search(r"\b(\d{1,3})\+(\d{3})(?:[.,](\d{1,2}))?\b", s)
    station_text = m_st.group(0).replace(",", ".") if m_st else ""
    station_m: float | None = None
    if m_st:
        dec = f".{m_st.group(3)}" if m_st.group(3) else ""
        station_m = round(int(m_st.group(1)) * 1000 + float(f"{m_st.group(2)}{dec}"), 2)
    # Ara mesafe (span_m): istasyon öncesindeki sol bölgede 15..1100 m aralığındaki ilk ondalıklı sayı
    span_m: float | None = None
    left_zone = s[: m_st.start()] if m_st else s[:80]
    for m_sp in re.finditer(r"\b(\d{2,3}[.,]\d{1,2})\b", left_zone):
        v = float(m_sp.group(1).replace(",", "."))
        if 15.0 <= v <= 1100.0:
            span_m = round(v, 2)
            break
    # Fonksiyon: T | KD | KT | BD | N | D (istasyondan sonraki ilk uygun kısa token)
    func = ""
    func_pos = -1
    search_start = m_st.end() if m_st else 0
    m_f = re.search(r"\b(KD|KT|BD|[TND])\b", s[search_start:])
    if m_f:
        func = m_f.group(1).upper()
        func_pos = search_start + m_f.end()
    # Direk tipi: fonksiyondan sonraki direk tipi tokenı (PA1, PB1, 2FN1, 3PB1, CPFH vb.)
    ttype = ""
    if func and func_pos >= 0:
        m_t = re.search(
            r"\b(C?P[A-F][0-9Iil\]\):H]*(?:\([A-Za-z0-9]+\))?|[1-4]P[A-F][0-9Iil\]\):]*|2F[SN][0-9Iil\]\):]*)",
            s[func_pos:],
        )
        if m_t:
            raw_t = (
                m_t.group(1)
                .upper()
                .replace("I", "1")
                .replace(")", "1")
                .replace("l", "1")
                .replace("]", "1")
            )
            ttype = re.sub(r"\([A-Z0-9]+\)$", "", raw_t)
    # Geçişler (bilinen anahtar sözcükler, tüm satırda aranır)
    CROSS_RE = re.compile(
        r"(TOPRAK YOL|ASFALT YOL|PLANLANAN[^|]+OTOYOLU|PLANLANAN[^|]+OTO YOLU|"
        r"DEMİRYOLU(?:\s+KATENER)?|DEMIRYOLU(?:\s+KATENER)?|"
        r"DOĞAL\s*GAZ(?:\s+BORU\s+HATTI)?|DOGAL\s*GAZ(?:\s+BORU\s+HATTI)?|"
        r"O\.?\s?G\.?\s?HAT(?:TI)?|О\.?\s?G\.?\s?HAT(?:TI)?|A\.?\s?G\.?\s?HAT(?:TI)?|"
        r"DERE|KANAL|BATAKLIK|MEYVELIK|MEYVELİK|DSI KANAL|(?:400|380|154)\s*KV[^|]*|BORU HATTI)",
        re.I,
    )
    crossings: list[str] = []
    for w in CROSS_RE.findall(s):
        w = normalize_crossing(w)
        if w and w not in crossings:
            crossings.append(w)
    return {
        "pole": pole,
        "span_m": span_m,
        "tower_type": ttype,
        "function": func,
        "station_m": station_m,
        "station_text": station_text,
        "easting": float(easting) if easting else None,
        "northing": float(northing) if northing else None,
        "crossing": ", ".join(crossings),
    }


def _indra_rows_from_page(
    page: dict,
) -> tuple[list[tuple[int, list[dict]]], list[tuple[int, int]], list[dict], list[tuple[int, int, str]], list[tuple[int, list[dict]]]]:
    """Indra sayfa JSON'undan satırları kutu (box) y-koordinatıyla gruplayıp
    soldan sağa birleştirir; metin mevcut parse'tan geçer. Belge sırası korunur.
    Döner: ([(y, cells)], zayıf_bantlar, dtl_satırlar, eksik_dtl_bantlar, zayıf_satırlar)."""
    raw_lines = [l for l in (page.get("lines") or []) if l.get("text", "").strip()]
    if not raw_lines:
        return [], [], [], [], []
    # Tablo üst başlığı, alt imza bloğu ve tam genişlikli bölüm başlıklarını (GİRDİ/ÇIKTI/EİH) ayıkla
    FOOTER_RE = re.compile(
        r"(?i)(?:HAZIRLAYAN|KONTROL\s+EDEN|KONTORL\s+EDEN|AD\s+SOYAD|TÜRKIYE\s+ELEKTR|ILETIM\s+HATLAR|"
        r"HEAD\s+OFFICE|TRANSMISSION\s+LINES|SURVEY\s+OFFICE|DIPLOMA\s+NO|ODA\s+SICIL|ETÜT\s+MÜDÜR)"
    )
    lines = [
        l
        for l in raw_lines
        if not DTL_HEADER_PAT.search(l["text"]) and not FOOTER_RE.search(l["text"])
    ]
    if not lines:
        return [], [], [], [], []

    # Çözünürlükten bağımsız (oransal) ölçek katsayısı:
    # Düşük çözünürlüklü (ör. 1300-1800px genişlik) belgelerde sabit piksel eşikleri
    # sol direk sütunu ile ARA MESAFE sütununu birbirine zincirlediği için tüm yatay
    # eşikler sayfa genişliğine (referans 3312px) göre ölçeklenir.
    page_w = max((float(l["box"][2]) for l in lines), default=3312.0)
    sx = max(0.35, min(1.5, page_w / 3312.0))
    left_limit = 380.0 * sx

    lines.sort(key=lambda l: float(l["box"][1]))
    ANCHOR_RE = re.compile(
        r"(?i)^\s*(?:portal\.?|(?:mev\.?\s*)?(?:pb|dp|dm|d)[.-]?\s*\d{1,3}|-?\d{1,3}(?:\s*\([a-z0-9]+\))?\.?)\s*$"
    )
    left_cands = [l for l in lines if float(l["box"][0]) < left_limit and ANCHOR_RE.fullmatch(l["text"].strip())]
    left_xcl: list[list[dict]] = []
    for l in sorted(left_cands, key=lambda l: float(l["box"][0])):
        if (
            left_xcl
            and float(l["box"][0]) - float(left_xcl[-1][-1]["box"][0]) <= 18.0 * sx
            and float(l["box"][0]) - float(left_xcl[-1][0]["box"][0]) <= 32.0 * sx
        ):
            left_xcl[-1].append(l)
        else:
            left_xcl.append([l])
    left_col_clusters = [c for c in left_xcl if len(c) >= 2]
    if left_col_clusters:
        left_col = left_col_clusters[0]
        left_max_x = max(float(l["box"][0]) for l in left_col) + 22.0 * sx
        raw_anchors = [l for l in left_cands if float(l["box"][0]) <= left_max_x]
    else:
        left_max_x = left_limit
        raw_anchors = left_cands

    # Aynı satırda birden fazla sol aday varsa en soldakini tut (dikey eşik kutu yüksekliğine oransal)
    med_box_h = (
        float(np.median([float(l["box"][3]) - float(l["box"][1]) for l in raw_anchors]))
        if raw_anchors
        else 16.0 * sx
    )
    same_row_dy = max(4.5, min(10.0, med_box_h * 0.6))
    anchors: list[dict] = []
    for a in sorted(raw_anchors, key=lambda l: (float(l["box"][1]), float(l["box"][0]))):
        ay = float(a["box"][1])
        if anchors and abs(ay - float(anchors[-1]["box"][1])) <= same_row_dy:
            if float(a["box"][0]) < float(anchors[-1]["box"][0]):
                anchors[-1] = a
        else:
            anchors.append(a)

    anchor_is_mid: dict[int, bool] = {}
    anchor_locked: dict[int, bool] = {}
    if len(anchors) >= 2:
        anchors.sort(key=lambda l: float(l["box"][1]))
        tops = [float(a["box"][1]) for a in anchors]
        med = float(np.median(np.diff(tops))) if len(tops) > 1 else 0.0
        if med > 0:
            # Sol direk hücresi okunamayan satır komşu satıra yapışır (D-8 vakası:
            # easting/northing okunmuş ama sol direk no BOŞ). DTL'de direk no ikinci
            # kez orta D.NO sütununda yazılır; o sütunu SOL DİREK SÜTUNUYLA DEĞER
            # UYUMUNDAN tanı ve boşluklara çapa olarak ekle.
            cands = [
                l
                for l in lines
                if float(l["box"][0]) > left_max_x and ANCHOR_RE.fullmatch(l["text"].strip())
            ]
            xcl: list[list[dict]] = []
            for l in sorted(cands, key=lambda l: float(l["box"][0])):
                if (
                    xcl
                    and float(l["box"][0]) - float(xcl[-1][-1]["box"][0]) <= 22.0 * sx
                    and float(l["box"][0]) - float(xcl[-1][0]["box"][0]) <= 40.0 * sx
                ):
                    xcl[-1].append(l)
                else:
                    xcl.append([l])
            left_nums = [
                (a, float(a["box"][1]), a["text"].strip().rstrip("."))
                for a in anchors
                if not re.match(r"(?i)^portal", a["text"].strip())
            ]
            agree_dy = max(5.5, min(12.0, med * 0.34))
            best_mid, best_agree = None, 0
            for c in xcl:
                if len(c) < 3:
                    continue
                agree = 0
                for _, lt, txt in left_nums:
                    if any(abs(float(l["box"][1]) - lt) <= agree_dy and l["text"].strip().rstrip(".") == txt for l in c):
                        agree += 1
                if agree > best_agree:
                    best_mid, best_agree = c, agree
            if best_mid is not None and best_agree >= 3:
                for a, lt, txt in left_nums:
                    if any(abs(float(l["box"][1]) - lt) <= agree_dy and l["text"].strip().rstrip(".") == txt for l in best_mid):
                        anchor_locked[id(a)] = True
                for m in best_mid:
                    mt = float(m["box"][1])
                    mtxt = m["text"].strip()
                    if not re.match(r"(?i)^portal", mtxt) and min(abs(mt - t) for t in tops) > med * 0.58:
                        anchors.append(m)
                        anchor_is_mid[id(m)] = True
                anchors.sort(key=lambda l: float(l["box"][1]))
                tops = [float(a["box"][1]) for a in anchors]

            # Düşük çözünürlükte hem sol hem orta direk numarası silik çıkıp atlanmışsa,
            # ardışık çapalar arasındaki >1.65*med boşluklarda koordinat/veri kutusu var mı kontrol et
            # ve sanal çapa ekleyerek satırın komşu satıra yutulmasını önle.
            med = float(np.median(np.diff(tops))) if len(tops) > 1 else med
            synth_anchors: list[dict] = []
            for k in range(len(anchors) - 1):
                a_cur, a_nxt = anchors[k], anchors[k + 1]
                t_cur, t_nxt = float(a_cur["box"][1]), float(a_nxt["box"][1])
                gap = t_nxt - t_cur
                if not (1.68 * med <= gap <= 4.4 * med):
                    continue
                p_cur_m = re.fullmatch(r"(\d{1,3})", a_cur["text"].strip().rstrip("."))
                p_nxt_m = re.fullmatch(r"(\d{1,3})", a_nxt["text"].strip().rstrip("."))
                if p_cur_m and p_nxt_m and 1 < int(p_nxt_m.group(1)) - int(p_cur_m.group(1)) <= 4:
                    n_steps = int(p_nxt_m.group(1)) - int(p_cur_m.group(1))
                    base_pole = int(p_cur_m.group(1))
                else:
                    n_steps = int(round(gap / med))
                    base_pole = None
                if n_steps < 2 or n_steps > 4:
                    continue
                h_cur = float(a_cur["box"][3]) - float(a_cur["box"][1])
                for s_idx in range(1, n_steps):
                    exp_top = t_cur + s_idx * (gap / n_steps)
                    exp_cy = exp_top + 0.5 * h_cur
                    band_items = [
                        l
                        for l in lines
                        if abs(0.5 * (float(l["box"][1]) + float(l["box"][3])) - exp_cy) <= 0.36 * med
                    ]
                    has_coord_like = any(
                        float(l["box"][0]) >= 0.55 * page_w
                        and re.search(r"\d{5,7}", _normalize_coord_str(l["text"]))
                        for l in band_items
                    )
                    if len(band_items) >= 3 and has_coord_like:
                        y0_s = float(np.median([float(l["box"][1]) for l in band_items]))
                        y1_s = float(np.median([float(l["box"][3]) for l in band_items]))
                        pole_txt = str(base_pole + s_idx) if base_pole is not None else ""
                        va = {
                            "text": pole_txt,
                            "box": [float(a_cur["box"][0]), y0_s, float(a_cur["box"][2]), y1_s],
                            "conf": 0.75,
                        }
                        synth_anchors.append(va)
                        if pole_txt:
                            anchor_is_mid[id(va)] = True
            if synth_anchors:
                anchors.extend(synth_anchors)
                anchors.sort(key=lambda l: float(l["box"][1]))
                tops = [float(a["box"][1]) for a in anchors]
                med = float(np.median(np.diff(tops))) if len(tops) > 1 else med

        # Her metin kutusunu dikey merkezine (cy) en yakın çapa satırına ata;
        # düşük çözünürlükte sabit 18px komşu satırı yuttuğu için eşik med ile oransaldır.
        acys = [0.5 * (float(a["box"][1]) + float(a["box"][3])) for a in anchors]
        max_dy = max(7.0, (med if med > 0 else 28.0 * sx) * 0.54)
        clusters: list[list[dict]] = [[] for _ in anchors]
        for l in lines:
            lcy = 0.5 * (float(l["box"][1]) + float(l["box"][3]))
            best_i = int(np.argmin([abs(lcy - acy) for acy in acys]))
            if abs(lcy - acys[best_i]) <= max_dy:
                clusters[best_i].append(l)
        mids = [anchor_is_mid.get(id(a), False) for a in anchors]
        locks = [anchor_locked.get(id(a), False) for a in anchors]
    else:
        clusters = []
        row_gap_dy = max(7.0, 16.0 * sx)
        for l in lines:
            y = float(l["box"][1])
            if clusters and y - float(clusters[-1][-1]["box"][1]) <= row_gap_dy:
                clusters[-1].append(l)
            else:
                clusters.append([l])
        mids = [False] * len(clusters)
        locks = [False] * len(clusters)
    rows: list[tuple[int, list[dict]]] = []
    weak_ranges: list[tuple[int, int]] = []
    dtl_rows: list[dict] = []
    dtl_weak: list[tuple[int, int, str]] = []
    weak_rows: list[tuple[int, list[dict]]] = []
    col_bucket_w = max(15.0, 42.0 * sx)
    for i, (is_mid, is_locked, items) in enumerate(zip(mids, locks, clusters)):
        if not items:
            continue
        # Aynı sütun içindeki çok satırlı hücreleri yukarıdan aşağıya, farklı sütunları soldan sağa sırala
        items.sort(key=lambda l: (round(float(l["box"][0]) / col_bucket_w), float(l["box"][1])))
        joined = " | ".join(l["text"].strip() for l in items)
        parsed = parse_glm_line(joined)
        if parsed is None or _is_noise_line(parsed):
            continue
        anchor_pole = anchors[i]["text"].strip().rstrip(".") if i < len(anchors) else ""
        if is_mid or is_locked or (anchor_pole and re.match(r"(?i)^(?:d|dp|pb|dm)[.-]\d+", anchor_pole)):
            parsed["pole"] = "PORTAL" if anchor_pole.upper() == "PORTAL" else anchor_pole
        # Düşük çözünürlükte koordinatlardan biri 5 haneye düşmüşse (ör. 593058.47 -> 53058.47)
        # ve sağ bölgede tek 6-7 haneli koordinat kalmışsa, 5 haneli adayı zayıf koordinat olarak kurtar
        cds_raw = parsed.get("coords") or []
        if len(cds_raw) == 1 and page_w > 0:
            c0_v = _num(cds_raw[0])
            right_txt = " | ".join(_normalize_coord_str(l["text"]) for l in items if float(l["box"][0]) >= 0.55 * page_w)
            if c0_v is not None and c0_v >= 3_000_000:
                m5 = re.search(r"\b(\d{5}\.\d{1,3})\b", right_txt)
                if m5:
                    parsed["coords"] = [m5.group(1), cds_raw[0]]
                    parsed["weak"] = True
            elif c0_v is not None and 100_000 <= c0_v <= 900_000:
                m6 = re.search(r"\b([345]\d{5}\.\d{1,3})\b", right_txt)
                if m6:
                    parsed["coords"] = [cds_raw[0], m6.group(1)]
                    parsed["weak"] = True
        cells = cells_from_parsed(parsed)
        if cells and is_locked:
            cells[0]["locked"] = True
        y0 = int(min(float(l["box"][1]) for l in items))
        y1 = int(max(float(l["box"][3]) for l in items))
        # İstasyon tuzağı: easting adayı sol bölgeden (istasyon sütunu) geliyorsa VE
        # sağdaki koordinat sütunlarında COORD_RE'nin kaçırdığı rakam benzeri hücre
        # varsa satırı zayıf say → GLM dolgusu gerçek easting'i okusun (D-65 sınıfı).
        e_core, n_core = "", ""
        if len(cells) >= 3:
            def _core(t: str) -> str:
                norm = _normalize_coord_str(t).strip()
                m = COORD_RE.search(norm)
                return m.group(0) if m else norm

            e_core = _core(cells[1]["text"])
            n_core = _core(cells[2]["text"])
            if not parsed.get("weak"):
                w = max((float(l["box"][2]) for l in lines), default=0.0)
                if w > 0:
                    src_x = min(
                        (float(l["box"][0]) for l in items if _core(l["text"]) == e_core),
                        default=float("inf"),
                    )
                    right_missed = any(
                        float(l["box"][0]) >= 0.6 * w
                        and _core(l["text"]) not in (e_core, n_core)
                        and re.search(r"\d{4,8}(?:[.,]\d{1,4})?", _normalize_coord_str(l["text"]))
                        for l in items
                    )
                    if src_x < 0.45 * w and right_missed:
                        parsed["weak"] = True
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
            if is_locked or is_mid:
                dtl["pole"] = parsed.get("pole") or dtl["pole"]
            if is_locked:
                dtl["pole_locked"] = True
            dtl_idx = len(dtl_rows)
            dtl_rows.append(dtl)
            # Direk özellikleri eksikse GLM ikinci geçişine gönder (özel D.13/D.14 gibi istasyonsuz satırlar hariç)
            has_core = bool(dtl.get("tower_type") and dtl.get("function"))
            need_st = not re.match(r"(?i)^(?:d|dp|pb|dm)[.-]\d+", str(dtl.get("pole") or ""))
            if not (has_core and (dtl.get("station_text") or not need_st)):
                dtl_weak.append((max(0, y0 - 4), y1 + 4, f"{dtl_idx}:{dtl.get('pole')}"))
        if len(cells) < 3 or parsed.get("weak"):
            # Direk benzeri başlangıcı olan eksik/çift-northing satır → GLM dolgusu
            if parsed.get("pole") or re.search(r"^\d{1,3}\b", joined):
                weak_ranges.append((max(0, y0 - 4), y1 + 4))
                # Dolgu başarısız olursa satır yok olmasın: belirsiz (0.4) olarak korunur
                kept = cells
                if len(kept) >= 3:
                    for c in kept[1:3]:
                        c["conf"] = 0.4
                weak_rows.append((y0, kept))
            continue
        coord_confs = [
            float(l.get("conf") or 0.0)
            for l in items
            if (l.get("conf") or 0) > 0 and _core(l["text"]) in (e_core, n_core)
        ]
        confs = coord_confs or [float(l.get("conf") or 0.0) for l in items if (l.get("conf") or 0) > 0]
        avg = sum(confs) / len(confs) if confs else 0.0
        for c in cells[1:3]:
            c["conf"] = round(avg, 4) if avg >= 0.85 else 0.4
        rows.append((y0, cells))
    return rows, weak_ranges, dtl_rows, dtl_weak, weak_rows


async def ocr_page_indra(
    original: np.ndarray,
    deskew: bool = True,
) -> tuple[list[tuple[int, list[dict]]], list[tuple[int, int]], list[dict], list[tuple[int, int, str]], list[tuple[int, list[dict]]], int]:
    """Indra OCR: tam sayfayı CPU'da okur (genelde 2-6 sn).
    Döner: ([(y, cells)], zayıf_bantlar, dtl_satırlar, eksik_dtl_bantlar, zayıf_satırlar, ms)."""
    binp = await asyncio.to_thread(_indra_bin)
    if not binp:
        log.warning("indra ikili dosyası bulunamadı → VLM yoluna düşülür")
        return [], [], [], [], [], 0
    t0 = time.time()
    tmp = ""
    try:
        work_img = await asyncio.to_thread(deskew_for_ocr, original) if deskew else original
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            tmp = f.name
        bgr = cv2.cvtColor(work_img, cv2.COLOR_RGB2BGR)
        if not await asyncio.to_thread(cv2.imwrite, tmp, bgr):
            return [], [], [], [], [], 0

        def _run() -> subprocess.CompletedProcess:
            env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
            return subprocess.run(
                [binp, tmp, "--format", "json", "--mode", "ocr", "--cores", str(INDRA_CORES)],
                capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=600,
            )

        proc = await asyncio.to_thread(_run)
        if proc.returncode != 0:
            log.warning("indra çalışmadı (rc=%d): %s", proc.returncode, (proc.stderr or "")[-200:])
            return [], [], [], [], [], 0
        rows: list[tuple[int, list[dict]]] = []
        weak_ranges: list[tuple[int, int]] = []
        dtl_rows: list[dict] = []
        dtl_weak: list[tuple[int, int, str]] = []
        weak_rows: list[tuple[int, list[dict]]] = []
        for line in proc.stdout.splitlines():
            try:
                rs, ws, ds, dws, wrs = _indra_rows_from_page(json.loads(line))
                rows.extend(rs)
                weak_ranges.extend(ws)
                dtl_rows.extend(ds)
                dtl_weak.extend(dws)
                weak_rows.extend(wrs)
            except Exception:
                continue
        valid = sum(1 for _, r in rows if len(r) >= 3)
        ms = int((time.time() - t0) * 1000)
        log.info(
            "indra: %d satır (%d geçerli, %d zayıf, %d dtl, %d eksik-dtl) %.0fms",
            len(rows), valid, len(weak_ranges), len(dtl_rows), len(dtl_weak), ms,
        )
        return rows, weak_ranges, dtl_rows, dtl_weak, weak_rows, ms
    except Exception as e:
        log.warning("indra hatası (%s) → GLM yoluna düşülür", e)
        return [], [], [], [], [], 0
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

    # 1. Geçiş: tam genişlikli şeridi VLM ile oku (hem tüm DTL sütunları hem koordinatlar çıkar)
    for idx, (y0, y1) in enumerate(plan):
        if request is not None and await request.is_disconnected():
            raise RuntimeError("İstemci bağlantıyı kapattı")
        full_band = compose_full_band(prep.gray[y0:y1, :])
        line = await glm_read([encode_b64(full_band, max_w=3400, fmt=".png")], BAND_TEXT_PROMPT, 160)
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
                    line2b = await glm_read([b64_narrow], BAND_TEXT_PROMPT, 96)
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
    final_page_dtl = finalize_dtl_rows(dtl_rows)
    return _finalize_rows(rows, final_page_dtl), final_page_dtl, header_info, len(bands), band_reads


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


@app.post("/ocr/preview")
async def ocr_preview(file: UploadFile):
    buf = await file.read()
    name = (file.filename or "").lower()
    try:
        if name.endswith(".pdf"):
            import pypdfium2 as pdfium

            def _pdf_first(b: bytes):
                pdf = pdfium.PdfDocument(b)
                try:
                    cnt = len(pdf)
                    if cnt == 0:
                        return None, 0
                    page = pdf[0]
                    bitmap = page.render(scale=1.25, grayscale=False)
                    arr = np.array(bitmap.to_pil().convert("RGB"))
                    page.close()
                    return arr, cnt
                finally:
                    pdf.close()

            first_page, pages_count = await asyncio.to_thread(_pdf_first, buf)
        elif name.endswith((".tif", ".tiff")):
            def _tiff_first(b: bytes):
                img = Image.open(io.BytesIO(b))
                cnt = getattr(img, "n_frames", 1)
                img.seek(0)
                return np.array(img.convert("RGB")), cnt

            first_page, pages_count = await asyncio.to_thread(_tiff_first, buf)
        elif name.endswith((".png", ".jpg", ".jpeg")):
            first_page = np.array(Image.open(io.BytesIO(buf)).convert("RGB"))
            pages_count = 1
        else:
            return JSONResponse(status_code=400, content={"error": "Desteklenmeyen biçim"})
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": f"Önizleme oluşturulamadı: {e}"})

    if first_page is None:
        return JSONResponse(status_code=400, content={"error": "Görüntü bulunamadı"})

    auto_rot = await asyncio.to_thread(detect_auto_rotation, first_page)
    b64 = await asyncio.to_thread(jpeg_b64, first_page, 1100)
    h, w = first_page.shape[:2]
    return {
        "preview": "data:image/jpeg;base64," + b64,
        "width": w,
        "height": h,
        "pages_count": pages_count,
        "auto_rotation": auto_rot,
    }


@app.post("/ocr/document")
@app.post("/ocr/dtl")
async def ocr_document(request: Request, file: UploadFile, rotate: str = "auto"):
    t0 = time.time()
    buf = await file.read()
    name = (file.filename or "").lower()
    rot_arg = (rotate or request.query_params.get("rotate") or "auto").strip().lower()
    log.info("istek: dosya=%s boyut=%d bayt yön=%s", file.filename, len(buf), rot_arg)
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
    log.info("sayfalar: %d (%dx%d) — akıllı OCR (%s)", len(images), images[0].shape[1], images[0].shape[0], VISION_MODEL)

    async with _ocr_lock:
        out_pages = []
        all_dtl_rows: list[dict] = []
        dtl_header: dict = {"title": "", "voltage_kv": "", "conductor": "", "line_name": "", "notes": ""}

        for page_idx, raw_page in enumerate(images):
            if await request.is_disconnected():
                log.warning("istemci bağlantıyı kapattı: %s (sayfa %d/%d)", file.filename, page_idx + 1, len(images))
                return JSONResponse(status_code=499, content={"error": "İstemci bağlantıyı kapattı"})
            try:
                if rot_arg in ("0", "90", "180", "270"):
                    oriented = await asyncio.to_thread(rotate_page_orthogonal, raw_page, int(rot_arg))
                else:
                    oriented = await asyncio.to_thread(auto_orient_page, raw_page)
                original = await asyncio.to_thread(deskew_for_ocr, oriented)
                need_hdr = page_idx == 0 or not dtl_header.get("line_name")
                indra_rows, indra_weak, indra_dtl, indra_dtl_weak, indra_weak_rows, indra_ms = (
                    await ocr_page_indra(original, deskew=False)
                ) if INDRA_ENABLED else ([], [], [], [], [], 0)
                indra_valid = sum(1 for _, r in indra_rows if len(r) >= 3)
                if indra_valid >= INDRA_MIN_ROWS:
                    # VLM dolgusu: Indra'nın eksik bıraktığı bantları tek tek okut
                    filled_y: set[int] = set()
                    for fy0, fy1 in indra_weak[:8]:
                        try:
                            band_img = original[fy0:fy1]
                            if band_img.shape[0] < 12:
                                continue
                            composed = await asyncio.to_thread(compose_band, band_img)
                            line = await glm_read([encode_b64(composed, fmt=".png")], ROW_PROMPT, 160)
                            p2 = parse_glm_line(line or "")
                            if p2 and not p2.get("weak") and len(p2.get("coords") or []) >= 2:
                                c2 = cells_from_parsed(p2)
                                if len(c2) >= 3:
                                    indra_rows.append((fy0, c2))
                                    filled_y.add(fy0)
                        except Exception:
                            continue
                    # Dolgusu başarısız zayıf satırları belirsiz (0.4) olarak geri ekle:
                    # düzeltme tablosunda görünsün, KMZ'de asla sessiz boşluk kalmasın
                    for fy0, wr in indra_weak_rows:
                        if fy0 not in filled_y and len(wr) >= 3:
                            indra_rows.append((fy0, wr))
                    # VLM ikinci geçiş: direk özellikleri eksik satırları tam genişlikte okut
                    for gy0, gy1, gpole in indra_dtl_weak[:12]:
                        try:
                            band_img = cv2.cvtColor(original[gy0:gy1], cv2.COLOR_RGB2GRAY)
                            fullb = await asyncio.to_thread(compose_full_band, band_img)
                            line = await glm_read([encode_b64(fullb, max_w=3400, fmt=".png")], BAND_TEXT_PROMPT, 160)
                            gdtl = parse_dtl_line(line or "")
                            if not gdtl:
                                continue
                            if ":" in gpole and gpole.split(":", 1)[0].isdigit():
                                d_idx = int(gpole.split(":", 1)[0])
                                if 0 <= d_idx < len(indra_dtl):
                                    d = indra_dtl[d_idx]
                                    for k in ("tower_type", "function", "station_text", "crossing", "remarks"):
                                        if not d.get(k) and gdtl.get(k):
                                            d[k] = gdtl[k]
                                continue
                            key = re.sub(r"\(.*\)", "", gpole).strip()
                            for d in indra_dtl:
                                if re.sub(r"\(.*\)", "", str(d.get("pole") or "")).strip() == key:
                                    for k in ("tower_type", "function", "station_text", "crossing", "remarks"):
                                        if not d.get(k) and gdtl.get(k):
                                            d[k] = gdtl[k]
                                    break
                        except Exception:
                            continue
                    indra_rows.sort(key=lambda t: t[0])
                    page_dtl_rows = finalize_dtl_rows(indra_dtl)
                    rows = _finalize_rows([cells for _, cells in indra_rows], page_dtl_rows)
                    hdr = {}
                    band_count, band_reads = 0, 0
                    log.info(
                        "indra kullanıldı: sayfa %d (%dms, %d zayıf, %d eksik-dtl)",
                        page_idx + 1, indra_ms, len(indra_weak), len(indra_dtl_weak),
                    )
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


# ---------- %100 Lokal Saha Fotoğrafı Doğrulama & Görsel Öznitelik Çıkarımı ----------

def _compute_dhash_hex(gray: np.ndarray) -> str:
    """Alt %12 filigran bandını hariç tutarak 64-bit dHash (16 karakter hex) üretir.
    Böylece aynı fotoğraf farklı direk etiketiyle tekrar yüklense bile yakalanır."""
    h, w = gray.shape
    core = gray[: max(8, int(h * 0.88)), :]
    resized = cv2.resize(core, (9, 8), interpolation=cv2.INTER_AREA)
    diff = resized[:, 1:] > resized[:, :-1]
    bits = 0
    for b in diff.flatten():
        bits = (bits << 1) | int(bool(b))
    return f"{bits:016x}"


def analyze_pole_photo_bytes(buf: bytes, claimed_stage: str = "") -> dict:
    """Saha direk fotoğrafını dış buluta çıkmadan tamamen lokal OpenCV ile analiz eder."""
    pil_img = Image.open(io.BytesIO(buf)).convert("RGB")
    rgb = np.array(pil_img)
    h, w, _ = rgb.shape
    # Analiz hızı için maksimum 960px boyuta ölçekle (alt %12 filigran bandını hariç tut)
    core_rgb = rgb[: max(32, int(h * 0.88)), :]
    ch, cw, _ = core_rgb.shape
    scale = min(1.0, 960.0 / max(ch, cw, 1))
    if scale < 1.0:
        core_rgb = cv2.resize(core_rgb, (int(cw * scale), int(ch * scale)), interpolation=cv2.INTER_AREA)

    gray = cv2.cvtColor(core_rgb, cv2.COLOR_RGB2GRAY)
    dhash = _compute_dhash_hex(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY))

    # 1. Bulanıklık (Laplacian varyansı) ve parlaklık/kontrast
    lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    blur_score = int(round(min(100.0, max(0.0, (np.log1p(lap_var) / np.log1p(350.0)) * 100.0))))
    brightness = float(gray.mean())
    contrast = float(gray.std())

    # 2. Renk ve doku oranları (HSV)
    hsv = cv2.cvtColor(core_rgb, cv2.COLOR_RGB2HSV)
    H_ch, S_ch, V_ch = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]

    # Toprak / kazı dokusu (turuncu-kahverengi-sarımsı, orta doygunluk)
    soil_mask = (H_ch >= 6) & (H_ch <= 28) & (S_ch >= 35) & (S_ch <= 210) & (V_ch >= 35) & (V_ch <= 220)
    soil_ratio = float(soil_mask.mean())

    # Beton / çakıl / galvanizli gri yüzey (düşük doygunluk, orta parlaklık)
    gray_surface_mask = (S_ch <= 42) & (V_ch >= 55) & (V_ch <= 205)
    concrete_gray_ratio = float(gray_surface_mask.mean())

    # Gökyüzü (üst %60'ta mavi veya parlak açık gökyüzü)
    upper_h = max(1, int(gray.shape[0] * 0.65))
    sky_mask = (
        ((H_ch[:upper_h, :] >= 90) & (H_ch[:upper_h, :] <= 135) & (S_ch[:upper_h, :] >= 25) & (V_ch[:upper_h, :] >= 110))
        | ((S_ch[:upper_h, :] <= 35) & (V_ch[:upper_h, :] >= 195))
    )
    sky_ratio = float(sky_mask.mean())

    # 3. Yapısal / çelik kafes ve iletken çizgi yoğunluğu (Canny + HoughLinesP)
    edges = cv2.Canny(gray, 65, 175)
    edge_density = float((edges > 0).mean())
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180.0, threshold=38, minLineLength=24, maxLineGap=8)
    line_count = len(lines) if lines is not None else 0
    structural_line_score = round(min(1.0, (line_count / 65.0) * 0.7 + min(1.0, edge_density / 0.12) * 0.3), 3)

    # 4. Aşama uyumluluk skorları (0.0 .. 1.0)
    # Dış mekan / saha ortamı doğrulaması (aşırı düz tek renk ekran/duvar çekimlerini ayıklar)
    is_blank_or_uniform = contrast < 16.0 or edge_density < 0.008
    if is_blank_or_uniform:
        affinities = {k: 0.15 for k in ("excavation", "foundation", "erection", "fittings", "stringing", "completed", "issue")}
    else:
        affinities = {
            "excavation": round(min(1.0, 0.45 + soil_ratio * 1.4 + concrete_gray_ratio * 0.5 + edge_density * 1.8), 3),
            "foundation": round(min(1.0, 0.45 + concrete_gray_ratio * 1.1 + soil_ratio * 0.8 + structural_line_score * 0.45), 3),
            "erection": round(min(1.0, 0.42 + structural_line_score * 0.65 + sky_ratio * 0.45 + concrete_gray_ratio * 0.3), 3),
            "fittings": round(min(1.0, 0.42 + structural_line_score * 0.65 + sky_ratio * 0.45), 3),
            "stringing": round(min(1.0, 0.42 + structural_line_score * 0.60 + sky_ratio * 0.50), 3),
            "completed": round(min(1.0, 0.48 + structural_line_score * 0.55 + sky_ratio * 0.35 + concrete_gray_ratio * 0.25), 3),
            "issue": 0.85,
        }

    st_key = (claimed_stage or "").strip().lower()
    claimed_affinity = affinities.get(st_key, 0.75)

    return {
        "dhash": dhash,
        "width": w,
        "height": h,
        "blur_laplacian": round(lap_var, 1),
        "blur_score": blur_score,
        "brightness": round(brightness, 1),
        "contrast": round(contrast, 1),
        "soil_ratio": round(soil_ratio, 3),
        "concrete_gray_ratio": round(concrete_gray_ratio, 3),
        "sky_ratio": round(sky_ratio, 3),
        "edge_density": round(edge_density, 4),
        "line_count": line_count,
        "structural_line_score": structural_line_score,
        "is_blank_or_uniform": bool(is_blank_or_uniform),
        "claimed_stage": st_key,
        "claimed_affinity": claimed_affinity,
        "affinities": affinities,
    }


@app.post("/verify-pole-photo")
async def verify_pole_photo_endpoint(file: UploadFile = File(...), stage: str = ""):
    try:
        buf = await file.read()
        if not buf:
            return JSONResponse(status_code=400, content={"error": "Boş görsel"})
        res = await asyncio.to_thread(analyze_pole_photo_bytes, buf, stage)
        return res
    except Exception as e:
        log.exception("Fotoğraf doğrulama hatası")
        return JSONResponse(status_code=500, content={"error": f"Görsel analiz hatası: {e}"})


