"""
One-off font builder (already run; output is committed in src/assets/fonts).

Fontsource ships each face split by unicode subset. Mongolian needs glyphs from
three of them (basic Cyrillic, Cyrillic-ext for Ө/Ү, Latin-ext for ₮), which
would mean 3-4 requests per weight. This merges the subsets and keeps only the
characters the site uses, so every face is ONE small woff2 file.

Run:  python scripts/build-fonts.py   (needs: pip install fonttools brotli)
"""
import io, os
from fontTools.ttLib import TTFont
from fontTools.merge import Merger
from fontTools.subset import Subsetter, Options

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "src", "assets", "fonts")

UNICODES = set(range(0x20, 0x7F)) | set(range(0xA0, 0x100)) | {
    0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2032, 0x2033,
    0x20AE,  # ₮
    0x2116,  # №
    0x0152, 0x0153,
} | set(range(0x0400, 0x0460)) | {0x04AE, 0x04AF, 0x04E8, 0x04E9}

FACES = [
    ("cormorant-garamond", "300", "normal"),
    ("cormorant-garamond", "300", "italic"),
    ("cormorant-garamond", "500", "normal"),
    ("montserrat", "300", "normal"),
    ("montserrat", "400", "normal"),
    ("montserrat", "500", "normal"),
]
SUBSETS = ["latin", "latin-ext", "cyrillic", "cyrillic-ext"]

def subset(path):
    font = TTFont(path)
    opts = Options()
    opts.layout_features = ["kern", "liga", "locl", "mark", "mkmk", "ccmp"]
    opts.notdef_outline = True
    opts.name_IDs = [1, 2, 3, 4, 6]
    s = Subsetter(opts)
    s.populate(unicodes=UNICODES)
    s.subset(font)
    buf = io.BytesIO()
    font.flavor = None
    font.save(buf)
    buf.seek(0)
    return buf

os.makedirs(OUT, exist_ok=True)
for fam, weight, style in FACES:
    parts = []
    for sub in SUBSETS:
        p = os.path.join(ROOT, "node_modules", "@fontsource", fam, "files", f"{fam}-{sub}-{weight}-{style}.woff2")
        tmp = os.path.join(OUT, f"_tmp-{sub}.ttf")
        with open(tmp, "wb") as fh:
            fh.write(subset(p).read())
        parts.append(tmp)
    merged = Merger().merge(parts)
    merged.flavor = "woff2"
    out = os.path.join(OUT, f"{fam}-{weight}-{style}.woff2")
    merged.save(out)
    for tmp in parts:
        os.remove(tmp)
    cm = TTFont(out).getBestCmap()
    missing = [hex(u) for u in (0x41, 0x410, 0x4E8, 0x4AE, 0x4E9, 0x4AF, 0x20AE, 0xE9) if u not in cm]
    print(f"{os.path.basename(out)}: {os.path.getsize(out)} bytes, {len(cm)} chars, missing={missing}")
