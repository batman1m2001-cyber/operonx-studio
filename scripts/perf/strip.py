"""Paste screenshots side by side: strip.py <out.png> <in.png> ... (needs pillow)."""
import sys
from PIL import Image
out_path, paths = sys.argv[1], sys.argv[2:]
ims = [Image.open(p).convert("RGB") for p in paths]
scale = 0.5 if ims[0].width > 700 else 0.45
ims = [i.resize((int(i.width * scale), int(i.height * scale))) for i in ims]
w = sum(i.width for i in ims) + 10 * (len(ims) - 1); h = max(i.height for i in ims)
out = Image.new("RGB", (w, h), "white"); x = 0
for i in ims:
    out.paste(i, (x, 0)); x += i.width + 10
out.save(out_path)
