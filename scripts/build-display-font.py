"""
Builds src/assets/fonts/unbounded-mn-700-normal.woff2 from the owner's assets/fonts/UnboundedMN-Bold.ttf.

- Fixes lowercase ү (U+04AF): in the source it sits on the baseline and stands taller than the other
  lowercase letters, so it reads as a capital Y. Here its arms are lined up with the x-height (571, as х)
  and its stem goes down to the descender (-181, as y). The source file is left untouched.
- Subsets to the characters the site uses (Latin, Mongolian Cyrillic incl. Ө ө Ү ү, punctuation).
  The font has no ₮; the CSS stack falls back to Montserrat for it.

Run:  python scripts/build-display-font.py   (needs: pip install fonttools brotli)
"""
import io, os
from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.subset import Subsetter, Options

ROOT = os.path.join(os.path.dirname(__file__), "..")
SRC = os.path.join(ROOT, "assets", "fonts", "UnboundedMN-Bold.ttf")
OUT = os.path.join(ROOT, "src", "assets", "fonts", "unbounded-mn-700-normal.woff2")
UNICODES = set(range(0x20, 0x7F)) | set(range(0xA0, 0x100)) | {
    0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2116,
} | set(range(0x0400, 0x0460)) | {0x04AE, 0x04AF, 0x04E8, 0x04E9}

font = TTFont(SRC)
gs = font.getGlyphSet()
bp = BoundsPen(gs)
gs["uni04AF"].draw(bp)
y0, y1 = bp.bounds[1], bp.bounds[3]
top, bottom = 571, -181
pen = TTGlyphPen(gs)
gs["uni04AF"].draw(TransformPen(pen, (1, 0, 0, (top - bottom) / (y1 - y0), 0, bottom - y0 * (top - bottom) / (y1 - y0))))
font["glyf"]["uni04AF"] = pen.glyph()

buf = io.BytesIO()
font.save(buf)
buf.seek(0)
font = TTFont(buf)
opts = Options()
opts.layout_features = ["kern", "liga", "locl", "mark", "mkmk", "ccmp"]
opts.flavor = "woff2"
opts.notdef_outline = True
opts.name_IDs = ["*"]
sub = Subsetter(opts)
sub.populate(unicodes=UNICODES)
sub.subset(font)
font.flavor = "woff2"
font.save(OUT)
print("wrote", OUT, os.path.getsize(OUT), "bytes")
