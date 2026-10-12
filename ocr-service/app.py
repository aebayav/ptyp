# PTYP OCR Servisi — taranmış PDF / TIFF belgelerden tablo ve rakam okuma
# Akıllı OCR: GLM-OCR (Ollama) tüm sayfayı tek seferde okur (direk no + Y + X),
# yetersiz kalırsa OpenCV ile tespit edilen satır bantları bant bant tekrar okunur.
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

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse, StreamingResponse
from pydantic import BaseModel
from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(asctime)s [OCR] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("ocr")

app = FastAPI(title="PTYP OCR Servisi", version="2.0.0")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
VISION_MODEL = os.environ.get("VISION_MODEL", "glm-ocr")
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.55"))
# Ollama çağrısı kaç kez denenir / kaç sn beklenir (0 = devre dışı)
OLLAMA_ATTEMPTS = int(os.environ.get("OLLAMA_ATTEMPTS", "1"))
OLLAMA_TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT", "240"))


# ---------- Görüntü hazırlama ----------

def pages_from_pdf(buf: bytes) -> list[np.ndarray]:
    """PDF'ten sayfa görüntüleri (pypdfium2 — sistem bağımlılığı yok)."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(buf)
    pages = []
    for i in range(len(pdf)):
        bitmap = pdf[i].render(scale=2.0)
        img = bitmap.to_pil().convert("RGB")
        pages.append(np.array(img))
    return pages


def pages_from_tiff(buf: bytes) -> list[np.ndarray]:
    """Çok sayfalı TIFF dahil."""
    img = Image.open(io.BytesIO(buf))
    pages = []
    for frame in range(getattr(img, "n_frames", 1)):
        img.seek(frame)
        pages.append(np.array(img.convert("RGB")))
    return pages


def preprocess_gray(img: np.ndarray) -> np.ndarray:
    """Satır bandı tespiti için gri + kontrast."""
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    return gray


def jpeg_b64(img: np.ndarray, max_w: int = 1200) -> str:
    """GLM-OCR'a gönderilecek JPEG (base64)."""
    h, w = img.shape[:2]
    if w > max_w:
        img = cv2.resize(img, (max_w, int(h * max_w / w)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 85])
    return base64.b64encode(buf.tobytes()).decode() if ok else ""


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
    "DIR direk numarası (ör. D-14, P3, PB1, 5, Portal), Y ve X 6-7 haneli koordinat sayıları. "
    "Sayıları dikkatle, aynen koru; uydurma. Başka bir şey yazma."
)

COORD_RE = re.compile(r"\b\d{6,7}(?:[.,]\d{1,4})?\b")
# Direk kalıbı: PB1, D-14, P3, DP-2, Direk 5, Portal
POLE_PAT_RE = re.compile(r"(?i)(?:direk\s*)?(?:portal|(?:d|p|dp|pb|dm)[-./]?\d{1,4})")
# Prompt yankısı sayılan kalıplar (boş bantta model prompt'u tekrar eder)
ECHO_WORDS = ("yalnızca", "formatta", "başka bir şey", "uydurma", "aynen koru")


def parse_glm_line(line: str) -> dict | None:
    """GLM çıktı satırını {pole, coords: [y, x], text} biçimine çevirir."""
    text = (line or "").strip().strip("|").strip()
    if not text:
        return None
    # Rakamsal OCR karışıklıkları: < → 4, O/o → 0 (yalnız rakam bağlamında)
    norm = re.sub(r"(?<=[\d\s])<(?=\d)", "4", text)
    norm = re.sub(r"(?<=[\d.])[Oo](?=[\d.])", "0", norm)
    norm = norm.replace(",", ".")
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
    if len(coords) >= 2:
        return {"pole": pole, "coords": [coords[-2], coords[-1]], "text": text}
    return {"pole": pole, "coords": coords, "text": text, "weak": True}


async def glm_read(images_b64: list[str], prompt: str, num_predict: int, timeout: int | None = None) -> str | None:
    """GLM-OCR'a tek seferlik soru. Başarısızsa None."""
    if OLLAMA_ATTEMPTS <= 0:
        return None
    last_err = ""
    for attempt in range(max(1, OLLAMA_ATTEMPTS)):
        try:
            async with httpx.AsyncClient(timeout=timeout or OLLAMA_TIMEOUT) as client:
                r = await client.post(
                    f"{OLLAMA_URL}/api/generate",
                    json={
                        "model": VISION_MODEL,
                        "prompt": prompt,
                        "images": images_b64,
                        "stream": False,
                        "think": False,
                        "options": {"num_predict": num_predict, "temperature": 0.1},
                    },
                )
            if r.status_code == 200:
                return (r.json().get("response") or "").strip() or None
            if r.status_code == 404:  # model yok → boşuna tekrar deneme
                return None
            last_err = f"HTTP {r.status_code}"
        except Exception as e:
            last_err = str(e)
            if attempt + 1 < max(1, OLLAMA_ATTEMPTS):
                await asyncio.sleep(2 * (attempt + 1))  # geçici bağlantı kesintileri için geri çekilme
    log.warning("glm_read başarısız (%d): %s", max(1, OLLAMA_ATTEMPTS), last_err)
    return None


def _bands_from_gaps(proj_frac: np.ndarray, min_h: int) -> list[tuple[int, int]]:
    """Genişliğin %2'sinden az mürekkep = boşluk (seyrek belgelerde çalışır)."""
    h = len(proj_frac)
    bands = []
    start = None
    for y in range(h):
        if proj_frac[y] > 0.02 and start is None:
            start = y
        elif proj_frac[y] <= 0.02 and start is not None:
            if y - start >= min_h:
                bands.append((max(0, start - 4), min(h, y + 4)))
            start = None
    if start is not None and h - start >= min_h:
        bands.append((max(0, start - 4), h))
    return bands


def _bands_from_local_min(proj_frac: np.ndarray, min_h: int) -> list[tuple[int, int]]:
    """Yoğun tablolarda boşluklar mutlak sıfıra inmez; satır araları göreli
    çukurdur → yerel minimumlar satır sınırıdır."""
    n = len(proj_frac)
    win = 12
    kernel = np.ones(2 * win + 1) / (2 * win + 1)
    sm = np.convolve(proj_frac, kernel, "same")
    local_min = (proj_frac <= sm) & (proj_frac < 0.04)
    idx = [int(y) for y in np.where(local_min)[0]]
    bounds = [0]
    for y in idx:
        if y - bounds[-1] >= 14:
            bounds.append(y)
    bounds.append(n)
    bands = []
    for a, b in zip(bounds, bounds[1:]):
        if b - a >= min_h:
            bands.append((a + 1, b - 1))
    return bands


def row_bands(gray: np.ndarray, min_h: int = 8) -> list[tuple[int, int]]:
    """Satır bantları: kural çizgilerini sök; önce mutlak boşluk,
    dev bant kalırsa yerel minimum segmentasyonu."""
    h, w = gray.shape
    _, bin_img = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    horiz = cv2.morphologyEx(bin_img, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(16, w // 4), 1)))
    vert = cv2.morphologyEx(bin_img, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(16, h // 4))))
    cleaned = cv2.subtract(cv2.subtract(bin_img, horiz), vert)
    proj_frac = (cleaned > 0).sum(axis=1) / max(w, 1)

    bands = _bands_from_gaps(proj_frac, min_h)
    # Yoğun tablo: dev bantlar birleşik satır demektir → yerel minimum yöntemi
    if not bands or len(bands) < 4 or max(b[1] - b[0] for b in bands) > 200:
        alt = _bands_from_local_min(proj_frac, min_h)
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
    Küçük yazıyı büyüt: yükseklik hedefi 96px (eski 64px'in 1.5 katı),
    büyütme katsayısı en çok 3x, genişlik en çok 2400px."""
    h, w = band_img.shape[:2]
    pole_crop = band_img[:, 0 : max(1, int(w * 0.20))]
    coord_crop = band_img[:, int(w * 0.55) :]
    gap = np.full((h, 30, 3), 255, np.uint8)
    composed = np.hstack([pole_crop, gap, coord_crop])
    scale = 1.0
    if composed.shape[0] < 96:
        scale = max(scale, 96 / composed.shape[0])
    if composed.shape[1] * scale > 2400:
        scale = min(scale, 2400 / composed.shape[1])
    scale = min(scale, 3.0)
    if scale > 1.0:
        composed = cv2.resize(composed, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return composed


async def _read_band(original: np.ndarray, y0: int, y1: int, rows: list[list[dict]]) -> None:
    """Tek bantı kompozit görüntü olarak GLM'e okutup satır listesine ekle."""
    band_img = original[y0:y1]
    if band_img.shape[0] < 8:
        return
    # Gürültü/boş bantları atla (mürekkep yoğunluğu çok düşükse okunacak şey yoktur)
    band_gray = cv2.cvtColor(band_img, cv2.COLOR_RGB2GRAY)
    _, bbin = cv2.threshold(band_gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if (bbin > 0).mean() < 0.004:
        return
    # Direk + koordinat sütunlarını odaklı kompozit görüntüde GLM'e sor
    composed = compose_band(band_img)
    line = await glm_read([jpeg_b64(composed, max_w=2000)], ROW_PROMPT, 160)
    parsed = parse_glm_line(line or "")
    if parsed is None:
        return
    if parsed.get("weak"):
        # Yalnızca koordinat kanıtı içeren zayıf satırları tut;
        # prompt yankısı/başlık gürültüsünü at
        t = parsed["text"].lower()
        if not COORD_RE.search(parsed["text"]) or any(k in t for k in ECHO_WORDS):
            return
    cells = cells_from_parsed(parsed)
    if cells:
        rows.append(cells)


async def ocr_page_glm(original: np.ndarray) -> tuple[list[list[dict]], int, int]:
    """Bir sayfayı GLM-OCR ile oku.
    - Seyrek sayfa (≤12 bant): önce tüm sayfa, gerekirse bant bant.
    - Yoğun sayfa (>12 bant): doğrudan bant bant (1.3B model tam sayfada kararsız).
    Döner: (rows, band_sayısı, bant_okuma_sayısı)"""
    gray = preprocess_gray(original)
    bands = row_bands(gray)
    rows: list[list[dict]] = []
    band_reads = 0

    if len(bands) <= 12:
        page_b64 = jpeg_b64(original)
        text = await glm_read([page_b64], PAGE_PROMPT, 2048)
        lines = [l for l in (text or "").splitlines() if l.strip()]
        for l in lines:
            parsed = parse_glm_line(l)
            if parsed is None:
                continue
            rows.append(cells_from_parsed(parsed))
        valid = sum(1 for r in rows if len(r) >= 3)
        if valid >= max(2, len(bands) - 2):
            return rows, len(bands), 0
        log.info("sayfa okuması zayıf (geçerli=%d, bant=%d) → bant bant oku", valid, len(bands))
        rows = []

    for y0, y1 in bands:
        # Birleşik bantları ikiye böl (2 katından uzunsa 2 satır demektir)
        y0, y1 = int(y0), int(y1)
        if y1 - y0 > 2 * min(60, max(20, int(np.median([b[1] - b[0] for b in bands])))):
            mid = (y0 + y1) // 2
            for a0, a1 in ((y0, mid), (mid, y1)):
                await _read_band(original, a0, a1, rows)
                band_reads += 1
            continue
        await _read_band(original, y0, y1, rows)
        band_reads += 1
    return rows, len(bands), band_reads


# ---------- Uç noktalar ----------

@app.get("/health")
def health():
    return {"status": "ok", "ollama": OLLAMA_URL, "vision_model": VISION_MODEL}


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
    if name.endswith(".pdf"):
        images = pages_from_pdf(buf)
    elif name.endswith((".tif", ".tiff")):
        images = pages_from_tiff(buf)
    elif name.endswith((".png", ".jpg", ".jpeg")):
        images = [np.array(Image.open(io.BytesIO(buf)).convert("RGB"))]
    else:
        log.warning("desteklenmeyen biçim: %s", file.filename)
        return JSONResponse(status_code=400, content={"error": "Desteklenmeyen biçim"})

    if not images:
        log.warning("görüntü bulunamadı: %s", file.filename)
        return JSONResponse(status_code=400, content={"error": "Görüntü bulunamadı"})
    log.info("sayfalar: %d (%dx%d) — akıllı OCR (glm-ocr)", len(images), images[0].shape[1], images[0].shape[0])

    out_pages = []
    for page_idx, original in enumerate(images):
        try:
            rows, band_count, band_reads = await ocr_page_glm(original)
        except Exception as e:
            return JSONResponse(status_code=500, content={"error": f"OCR hatası: {e}"})

        low_conf = sum(1 for r in rows for c in r if c["conf"] < CONF_THRESHOLD)
        log.info(
            "sayfa %d/%d: satır=%d bant=%d bant_okuma=%d düşük_güven=%d",
            page_idx + 1, len(images), len(rows), band_count, band_reads, low_conf,
        )

        out_pages.append(
            {
                "page": page_idx + 1,
                "preview": "data:image/jpeg;base64," + jpeg_b64(original),
                "rows": rows,
            }
        )
    log.info("bitti: %s sayfa=%d süre=%.1fs", file.filename, len(out_pages), time.time() - t0)
    return {"pages": out_pages, "pages_count": len(out_pages)}
