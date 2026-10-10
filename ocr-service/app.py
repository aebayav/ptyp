# PTYP OCR Servisi — taranmış PDF / TIFF belgelerden tablo ve rakam okuma
# OpenCV ön işleme + PaddleOCR + zor hücreler için Ollama (Qwen2.5-VL) fallback
#
# Çalıştırma (Ubuntu):
#   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
#   OLLAMA_URL=http://127.0.0.1:11434 VISION_MODEL=qwen2.5vl:7b \
#     .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8787
import base64
import io
import os

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image

app = FastAPI(title="PTYP OCR Servisi", version="1.0.0")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
VISION_MODEL = os.environ.get("VISION_MODEL", "qwen2.5vl:7b")
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.55"))
# Ollama çağrısı kaç kez denenir / kaç sn beklenir (0 = devre dışı)
OLLAMA_ATTEMPTS = int(os.environ.get("OLLAMA_ATTEMPTS", "1"))
OLLAMA_TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT", "60"))

_ocr = None


def get_ocr():
    global _ocr
    if _ocr is None:
        from paddleocr import PaddleOCR

        # Rakam/tablo ağırlıklı belgeler: açı sınıflandırıcı + en
        _ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
    return _ocr


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


def preprocess(img: np.ndarray) -> np.ndarray:
    """Küçük/tarama gürültülü görüntüleri OCR'a hazırla."""
    h, w = img.shape[:2]
    if max(h, w) < 2000:
        scale = min(3.0, 2000 / max(h, w))
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    return gray


def jpeg_b64(img: np.ndarray, max_w: int = 900) -> str:
    h, w = img.shape[:2]
    if w > max_w:
        img = cv2.resize(img, (max_w, int(h * max_w / w)))
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 70])
    return base64.b64encode(buf.tobytes()).decode() if ok else ""


# ---------- Satır gruplama ----------

def group_lines(items):
    """PaddleOCR çıktısını y-ekseninde satırlara kümele, her satırı x'e göre sırala."""
    if not items:
        return []
    data = []
    for bbox, (text, conf) in items:
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        data.append(
            {
                "bbox": bbox,
                "text": text,
                "conf": float(conf),
                "cx": (min(xs) + max(xs)) / 2,
                "cy": (min(ys) + max(ys)) / 2,
                "h": max(ys) - min(ys),
            }
        )
    data.sort(key=lambda d: d["cy"])
    lines: list[list[dict]] = []
    cur = [data[0]]
    for d in data[1:]:
        avg_h = np.mean([x["h"] for x in cur])
        if abs(d["cy"] - cur[-1]["cy"]) <= 0.6 * avg_h:
            cur.append(d)
        else:
            lines.append(sorted(cur, key=lambda x: x["cx"]))
            cur = [d]
    lines.append(sorted(cur, key=lambda x: x["cx"]))
    return lines


# ---------- Ollama fallback (zor hücreler) ----------

async def ollama_read_cell(crop_rgb: np.ndarray) -> str | None:
    """Hücre kırpığını Qwen2.5-VL'ye sor: sadece değeri döndür."""
    if OLLAMA_ATTEMPTS <= 0:
        return None
    h, w = crop_rgb.shape[:2]
    if h < 8 or w < 8:
        return None
    # Kırpığa kenar payı ekle (küçük kırpıklar modeli zorlar)
    pad = 12
    h, w = crop_rgb.shape[:2]
    canvas = np.full((h + 2 * pad, w + 2 * pad, 3), 255, dtype=np.uint8)
    canvas[pad : pad + h, pad : pad + w] = crop_rgb
    img = Image.fromarray(canvas).resize((w * 3, h * 3), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    prompt = (
        "Bu görüntüde bir tablo hücresi var. İçindeki metni veya sayıyı yaz. "
        "Sadece değeri döndür, başka açıklama ekleme."
    )
    for attempt in range(OLLAMA_ATTEMPTS):
        try:
            async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT) as client:
                r = await client.post(
                    f"{OLLAMA_URL}/api/generate",
                    json={"model": VISION_MODEL, "prompt": prompt, "images": [b64], "stream": False},
                )
            if r.status_code == 200:
                text = r.json().get("response", "").strip()
                text = text.splitlines()[0].strip() if text else ""
                return text[:80] or None
            if r.status_code == 404:  # model yok → boşuna tekrar deneme
                return None
        except Exception:
            continue
    return None


# ---------- Uç noktalar ----------

@app.get("/health")
def health():
    return {"status": "ok", "ollama": OLLAMA_URL, "vision_model": VISION_MODEL}


@app.post("/ocr/document")
async def ocr_document(file: UploadFile):
    buf = await file.read()
    name = (file.filename or "").lower()
    if name.endswith(".pdf"):
        images = pages_from_pdf(buf)
    elif name.endswith((".tif", ".tiff")):
        images = pages_from_tiff(buf)
    elif name.endswith((".png", ".jpg", ".jpeg")):
        images = [np.array(Image.open(io.BytesIO(buf)).convert("RGB"))]
    else:
        return JSONResponse(status_code=400, content={"error": "Desteklenmeyen biçim"})

    if not images:
        return JSONResponse(status_code=400, content={"error": "Görüntü bulunamadı"})

    ocr = get_ocr()
    out_pages = []
    for page_idx, original in enumerate(images):
        prep = preprocess(original)
        try:
            result = ocr.ocr(prep, cls=True)
        except Exception as e:
            return JSONResponse(status_code=500, content={"error": f"OCR hatası: {e}"})

        items = []
        for block in result or []:
            for bbox, (text, conf) in block:
                items.append((bbox, (text, conf)))

        rows = []
        for line in group_lines(items):
            cells = []
            for d in line:
                cell = {"text": d["text"], "conf": round(d["conf"], 3)}
                if d["conf"] < CONF_THRESHOLD:
                    # Zor hücre → Ollama vision modeline sor
                    xs = [int(p[0]) for p in d["bbox"]]
                    ys = [int(p[1]) for p in d["bbox"]]
                    x0, x1 = max(0, min(xs)), min(original.shape[1], max(xs))
                    y0, y1 = max(0, min(ys)), min(original.shape[0], max(ys))
                    fb = await ollama_read_cell(original[y0:y1, x0:x1])
                    if fb:
                        cell["text"] = fb
                        cell["conf"] = None
                        cell["fallback"] = "ollama"
                cells.append(cell)
            rows.append(cells)

        out_pages.append(
            {
                "page": page_idx + 1,
                "preview": "data:image/jpeg;base64," + jpeg_b64(original),
                "rows": rows,
            }
        )
    return {"pages": out_pages, "pages_count": len(out_pages)}
