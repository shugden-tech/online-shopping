"""Render research previews in memory only; never save downloaded photo files."""
import argparse, base64, concurrent.futures, hashlib, io, json, pathlib, urllib.request
from PIL import Image, ImageDraw, ImageOps

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--start', type=int, default=0)
parser.add_argument('--count', type=int, default=10)
parser.add_argument('--choices', default='')
parser.add_argument('--indices', default='')
args = parser.parse_args()
choices = {int(x.split(':')[0]): int(x.split(':')[1]) for x in args.choices.split(',') if x}
rows = json.loads((ROOT / 'output/back-photo-research/searches.json').read_text(encoding='utf-8'))
report_path = ROOT / 'output/back-photo-research/previews.json'
report = json.loads(report_path.read_text(encoding='utf-8')) if report_path.exists() else {}


def preview(task):
    index, row = task
    errors = []
    candidates = list(enumerate(row['candidates']))
    if index in choices: candidates = [(choices[index], row['candidates'][choices[index]])]
    for candidate_index, c in candidates:
        try:
            request = urllib.request.Request(c['image'], headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*'})
            with urllib.request.urlopen(request, timeout=16) as response:
                raw = response.read(10_000_001)
            if len(raw) > 10_000_000: raise ValueError('Over 10 MB')
            image = Image.open(io.BytesIO(raw))
            image.load()
            if min(image.size) < 250: raise ValueError('Image too small')
            image = ImageOps.exif_transpose(image).convert('RGBA')
            canvas = Image.new('RGBA', image.size, 'white')
            canvas.alpha_composite(image)
            tile = ImageOps.contain(canvas.convert('RGB'), (300, 290))
            return index, row, c, candidate_index, tile, dict(width=image.width, height=image.height, sha256=hashlib.sha256(raw).hexdigest())
        except Exception as error: errors.append(str(error))
    return index, row, None, None, None, {'errors': errors}


tasks = list(enumerate(rows))[args.start:args.start + args.count]
if args.indices:
    indices = [int(n) for n in args.indices.split(',')]
    tasks = [(i, rows[i]) for i in indices]
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool: results = list(pool.map(preview, tasks))
sheet = Image.new('RGB', (1600, ((len(results) + 4) // 5) * 370), 'white')
draw = ImageDraw.Draw(sheet)
metadata = []
for n, (index, row, candidate, choice, tile, details) in enumerate(results):
    x, y = (n % 5) * 320, (n // 5) * 370
    draw.rectangle((x, y, x + 319, y + 369), outline='#cccccc')
    if tile: sheet.paste(tile, (x + (320 - tile.width) // 2, y + (295 - tile.height) // 2))
    label = f"{index + 1}. {row['brand']} {row['name']} ({row['concentration']})"
    ascii_label = label.encode('ascii', 'replace').decode()
    lines = [ascii_label[i:i+43] for i in range(0, len(ascii_label), 43)]
    draw.text((x + 7, y + 300), '\n'.join(lines[:3]), fill='black')
    draw.text((x + 7, y + 348), f"candidate {choice} | {details.get('width', 0)} x {details.get('height', 0)}", fill='black')
    entry = dict(id=row['id'], index=index, candidate_index=choice, **details)
    if candidate: entry.update(image=candidate['image'], page=candidate['page'], title=candidate['title'])
    report[row['id']] = entry
    metadata.append(entry)
report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
output = io.BytesIO()
sheet.save(output, 'JPEG', quality=87)
print(json.dumps({'image': base64.b64encode(output.getvalue()).decode(), 'metadata': metadata}))
