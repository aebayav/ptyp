# OCR testi için direk listesi görüntüsü üretir (taranmış belge simülasyonu)
# Kullanım: .venv/bin/python make-ocr-test-image.py /tmp/direkler.png
import sys

from PIL import Image, ImageDraw, ImageFont

lines = [
    "KALYON ENH DIREK LISTESI",
    "No        Enlem          Boylam",
    "D-14    39.801234     32.500123",
    "D-15    39.812345     32.511234",
    "D-16    39.823456     32.522345",
    "D-17    39.834567     32.533456",
    "D-18    39.845678     32.544567",
]

W, H = 900, 340
img = Image.new("RGB", (W, H), (255, 255, 255))
d = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 26)
except Exception:
    font = ImageFont.load_default()

y = 20
for line in lines:
    d.text((24, y), line, fill=(0, 0, 0), font=font)
    y += 44

# Hafif tarama gürültüsü
import random

random.seed(7)
for _ in range(2200):
    d.point((random.randint(0, W - 1), random.randint(0, H - 1)), fill=(235, 235, 235))

img.save(sys.argv[1] if len(sys.argv) > 1 else "/tmp/direkler.png")
print("yazildi:", sys.argv[1] if len(sys.argv) > 1 else "/tmp/direkler.png")
