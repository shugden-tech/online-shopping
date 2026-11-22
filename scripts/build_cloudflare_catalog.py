"""Build the strict public catalog from the selected identities, never decant variants.

Run directly to rebuild from the selection audit and original source records.
No source/research URLs or commercial fields are emitted in public records.
"""
import collections
import csv
import gzip
import hashlib
import json
import pathlib
import re
import unicodedata
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / 'decantx'
PUBLIC_KEYS = {'id', 'brand', 'name', 'concentration', 'bottle_sizes_ml', 'release_year', 'notes', 'images'}
BRANDS = {'AMOUAGE': 'Amouage', 'Armani': 'Giorgio Armani', 'Dolce&Gabbana': 'Dolce & Gabbana',
          'HUGO BOSS': 'Hugo Boss', 'ESCENTRIC MOLECULES': 'Escentric Molecules',
          'Lancome': 'Lancôme', 'By Kilian': 'Kilian', 'D.S. & DURGA': 'D.S. & Durga', 'DS&Durga': 'D.S. & Durga'}
TAG_CONCENTRATIONS = {'EDP': 'EDP', 'Eau de Parfum': 'EDP', 'EDT': 'EDT', 'Eau de Toilette': 'EDT',
                      'Parfum': 'Parfum', 'Extrait': 'Extrait', 'Extrait de Parfum': 'Extrait',
                      'Extrait De Parfum': 'Extrait', 'Eau de Cologne': 'Cologne', 'Cologne': 'Cologne'}


def slug(value):
    value = unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', value).strip('-')


def display_name(p):
    value = p['name'].strip()
    houses = {p['brand'], BRANDS.get(p['brand'], p['brand'])}
    if p['brand'] == 'Dior': houses.add('Christian Dior')
    if p['brand'] in ('Armani', 'Giorgio Armani'): houses.add('Giorgio Armani')
    if p['brand'] == 'By Kilian': houses |= {'Kilian', 'Kilian Paris'}
    for house in sorted(houses, key=len, reverse=True):
        if value.casefold().startswith(house.casefold() + ' '):
            if house == 'Dior' and re.match(r'^Dior Homme\b', value, flags=re.I):
                break
            value = value[len(house):].strip()
            break
    value = re.sub(r'\s+(?:for men|for man|for women|for woman|unisex|pour homme|pour femme)\s*$', '', value, flags=re.I)
    # Only remove concentration at the end; preserve model names such as Le Parfum.
    suffix = r'\s+(?:extrait de parf(?:um|ume)|extrait|eau (?:de|the) parf(?:um|ume)|eau de toilette|eau de cologne|cologne absolue|pure perfume|parfum)\s*$'
    while re.search(suffix, value, flags=re.I):
        value = re.sub(suffix, '', value, flags=re.I).strip()
    return value or p['name'].strip()


def valid_year(value):
    if value is None: return None
    text = str(value).strip()
    if not re.fullmatch(r'(?:18|19|20)\d{2}(?:\.0)?', text): return None
    result = int(float(text))
    return result if 1800 <= result <= 2026 else None


def safe_note(value):
    if not isinstance(value, str): return None
    value = re.sub(r'\s+', ' ', value).strip(' .,;:')
    if not value or value.lower() in ('nan', 'none', 'unknown', 'n/a', 'not specified'): return None
    if len(value) > 65 or len(value.split()) > 8: return None
    if re.search(r'https?://|[<>\n]|\b(?:fragrance|perfume|cologne|opens|concludes|features|introduced|launched|such as|make this|well being|enrichment|top notes|middle notes|base notes|heart notes)\b', value, flags=re.I): return None
    return value.title().replace('Iso E Super', 'Iso E Super')


def clean_notes(notes):
    result, rejected = {}, []
    for source_key, target_key in [('top', 'top'), ('middle', 'heart'), ('base', 'base')]:
        values = notes.get(source_key, notes.get(target_key, [])) or []
        clean = []
        for value in values:
            n = safe_note(value)
            if n and n.casefold() not in {v.casefold() for v in clean}: clean.append(n)
            elif not n: rejected.append(value)
        result[target_key] = clean
    return result, rejected


def reference_rows():
    rows = {}
    with (DATA / 'notes-source-cache/fragrantica.csv').open(encoding='cp1252', newline='') as f:
        for r in csv.DictReader(f, delimiter=';'):
            notes = {k: [v.strip() for v in (r.get(col) or '').split(',') if v.strip()]
                     for k, col in [('top', 'Top'), ('middle', 'Middle'), ('base', 'Base')]}
            # A single flat list is not evidence for a top/heart/base pyramid.
            flat = bool(notes['top']) and not notes['middle'] and not notes['base']
            rows[r['url']] = {'notes': {} if flat else notes, 'flat': flat, 'year': valid_year(r['Year'])}
    with gzip.open(DATA / 'notes-source-cache/parfumo.csv.gz', 'rt', encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            notes = {k: [v.strip() for v in (r.get(col) or '').split(',') if v.strip() and v.strip().lower() != 'nan']
                     for k, col in [('top', 'Top_Notes'), ('middle', 'Middle_Notes'), ('base', 'Base_Notes')]}
            rows[r['URL']] = {'notes': notes, 'flat': False, 'year': valid_year(r['Release_Year'])}
    return rows


def valid_image(value):
    if not isinstance(value, str): return None
    parsed = urlparse(value)
    if parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password:
        return value
    return None


def validate_catalog(products):
    assert len(products) == 1000, 'Catalog must contain exactly 1,000 products'
    assert len({p['id'] for p in products}) == len(products), 'Duplicate public IDs'
    for p in products:
        assert set(p) == PUBLIC_KEYS, f'Unexpected fields: {p.get("id")}'
        assert re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', p['id'])
        assert isinstance(p['brand'], str) and p['brand'].strip()
        assert isinstance(p['name'], str) and p['name'].strip()
        assert p['concentration'] in (None, 'EDP', 'EDT', 'Parfum', 'Extrait', 'Cologne')
        sizes = p['bottle_sizes_ml']
        assert sizes is None or (isinstance(sizes, list) and sizes and sizes == sorted(set(sizes))
                                 and all(type(s) is int and 15 <= s <= 2000 for s in sizes))
        assert p['release_year'] is None or (type(p['release_year']) is int and 1800 <= p['release_year'] <= 2026)
        assert set(p['notes']) == {'top', 'heart', 'base'}
        for values in p['notes'].values():
            assert isinstance(values, list) and all(safe_note(v) for v in values)
        assert set(p['images']) == {'front', 'back'}
        assert all(v is None or valid_image(v) for v in p['images'].values())


def build_catalog(raw_products, audit_products):
    assert len(raw_products) == len(audit_products) == 1000
    refs = reference_rows()
    overrides = json.loads((DATA / 'catalog-field-overrides.json').read_text(encoding='utf-8'))
    catalog, pending, decisions = [], [], []
    reference_note_count = 0
    for p, audit in zip(raw_products, audit_products):
        assert p['name'] == audit['name'] and p['brand'] == audit['brand'], 'Selection/audit identity mismatch'
        override = overrides.get(p['name'], {})
        house, name = BRANDS.get(p['brand'], p['brand']), display_name(p)
        c = audit['concentration']
        if not c:
            tagged = {TAG_CONCENTRATIONS[t] for t in p.get('tags', []) if t in TAG_CONCENTRATIONS}
            c = next(iter(tagged)) if len(tagged) == 1 else None
        # Only already matched, concentration-compatible source IDs are eligible.
        supported = [refs[e['url']] for e in audit['evidence'] if e['url'] in refs]
        note_source = next((r for r in supported if any(r['notes'].values())), None)
        if note_source: reference_note_count += 1
        selected_notes = note_source['notes'] if note_source else ({} if supported and all(r['flat'] for r in supported) else p.get('notes', {}))
        notes, rejected = clean_notes(selected_notes)
        if not note_source and notes['top'] and not notes['heart'] and not notes['base']:
            notes = {'top': [], 'heart': [], 'base': []}
        years = {valid_year(t) for t in p.get('tags', [])} | {r['year'] for r in supported}
        years.discard(None)
        year = next(iter(years)) if len(years) == 1 else None
        # Decant variants and untyped sizes are NEVER considered.
        sizes = sorted({int(v['size_ml']) for v in p.get('variants', [])
                        if v.get('bottle_type') == 'full_bottle' and isinstance(v.get('size_ml'), (int, float))
                        and v['size_ml'] == int(v['size_ml']) and 15 <= v['size_ml'] <= 2000}) or None
        if 'bottle_sizes_ml' in override: sizes = override['bottle_sizes_ml']
        image_front, image_back = valid_image(p.get('front_image')), valid_image(p.get('back_image'))
        if image_back == image_front: image_back = None
        product = dict(id=slug(f'{house} {name} {c or ""}'), brand=house, name=name, concentration=c,
                       bottle_sizes_ml=sizes, release_year=year, notes=notes,
                       images=dict(front=image_front, back=image_back))
        catalog.append(product)
        missing = []
        if sizes is None: missing.append('bottle_sizes_ml')
        if year is None: missing.append('release_year')
        if c is None: missing.append('concentration')
        if not any(notes.values()): missing.append('tiered_notes')
        elif not note_source: missing.append('notes_review')
        if not image_front: missing.append('images.front')
        if not image_back: missing.append('images.back')
        if missing: pending.append(dict(id=product['id'], brand=house, name=name, missing=missing))
        if rejected or len(years) > 1:
            decisions.append(dict(id=product['id'], discarded_note_fragments=rejected, conflicting_years=sorted(years) if len(years) > 1 else []))
    ids = collections.Counter(p['id'] for p in catalog)
    for p, audit in zip(catalog, audit_products):
        if ids[p['id']] > 1:
            old = p['id']
            suffix = hashlib.sha256(f"{audit['origin']}:{audit['source_index']}".encode()).hexdigest()[:8]
            p['id'] += '-' + suffix
            for item in pending:
                if item['id'] == old and item['brand'] == p['brand'] and item['name'] == p['name']:
                    item['id'] = p['id']
                    break
    map_file = DATA / 'catalog-r2-images.json'
    r2_images = json.loads(map_file.read_text(encoding='utf-8')) if map_file.exists() else {}
    override_file = DATA / 'back-photo-overrides.json'
    photo_overrides = json.loads(override_file.read_text(encoding='utf-8')) if override_file.exists() else {}
    uploaded_images = 0
    for p in catalog:
        for kind in ('front', 'back'):
            image_name = f"{p['id']}_{kind}"
            override = photo_overrides.get(image_name)
            if override and override.get('reviewed') and override.get('bottle_and_box'):
                p['images'][kind] = valid_image(override.get('image'))
            stored = r2_images.get(image_name, {})
            if stored.get('source') == p['images'][kind] and valid_image(stored.get('url')) and re.fullmatch(r'[a-f0-9]{64}', stored.get('sha256', '')):
                p['images'][kind] = stored['url']
                uploaded_images += 1
    validate_catalog(catalog)
    by_id = {p['id']: p for p in catalog}
    # Image overrides and stored mappings are resolved after the initial content audit.
    for item in pending:
        item['missing'] = [field for field in item['missing']
                           if not (field.startswith('images.') and by_id[item['id']]['images'][field.split('.')[1]])]
    pending = [item for item in pending if item['missing']]
    summary = dict(products=len(catalog), full_bottle_sizes_known=sum(p['bottle_sizes_ml'] is not None for p in catalog),
                   release_year_known=sum(p['release_year'] is not None for p in catalog),
                   concentration_known=sum(p['concentration'] is not None for p in catalog),
                   tiered_notes_present=sum(any(p['notes'].values()) for p in catalog),
                   notes_from_matched_reference=reference_note_count,
                   front_urls=sum(bool(p['images']['front']) for p in catalog), back_urls=sum(bool(p['images']['back']) for p in catalog),
                   note_and_year_decisions=len(decisions),
                   missing_counts=dict(collections.Counter(k for p in pending for k in p['missing'])),
                   images_uploaded_to_r2=uploaded_images > 0, images_uploaded_count=uploaded_images, image_identity_review_complete=False,
                   notes='Null means not confirmed; empty note arrays mean no confirmed tier. Verified R2 mappings replace matching source image URLs. This is a cleaned draft, not a fully researched catalog.')
    report = dict(summary=summary, pending=pending, cleanup_decisions=decisions)
    return catalog, report


def main():
    merged_bytes = (DATA / 'merged.json').read_bytes()
    merged = json.loads(merged_bytes.decode('utf-8-sig'))
    audit = json.loads((DATA / 'selected-1000-audit.json').read_text(encoding='utf-8'))
    assert hashlib.sha256(merged_bytes).hexdigest() == audit['summary']['original_sha256'], 'Original input changed; review selection first'
    supplementary = {r['order']: r['raw'] for r in json.loads((DATA / 'curated-catalog-sources.json').read_text(encoding='utf-8')) if 'merged_index' not in r}
    selected = [merged[r['source_index']] if r['origin'] == 'merged' else supplementary[r['source_index']] for r in audit['products']]
    catalog, report = build_catalog(selected, audit['products'])
    (DATA / 'selected-1000.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (DATA / 'catalog-cleanup-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    assert merged_bytes == (DATA / 'merged.json').read_bytes(), 'Original was changed'
    print(json.dumps(report['summary'], indent=2))


if __name__ == '__main__':
    main()
