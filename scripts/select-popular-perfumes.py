"""Select 1,000 catalog identities using documented community popularity signals.

Reads originals only; writes separate selection, audit and excluded lists.
Run: python scripts/select-popular-perfumes.py
"""
import collections
import csv
import gzip
import hashlib
import json
import math
import pathlib
import re
import unicodedata
from urllib.parse import unquote, urlparse
from build_cloudflare_catalog import build_catalog

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / 'decantx'
CACHE = DATA / 'notes-source-cache'


def norm(value):
    text = unicodedata.normalize('NFKD', str(value or '')).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', ' ', text.replace('&', ' and ').replace("'", '').replace('’', '')).strip()


ALIASES = {
    'christian dior': 'dior', 'giorgio armani': 'armani', 'emporio armani': 'armani',
    'dolce and gabbana': 'dolce gabbana', 'by kilian': 'kilian', 'kilian paris': 'kilian',
    'roja dove': 'roja parfums', 'thierry mugler': 'mugler',
    'editions de parfums frederic malle': 'frederic malle',
    'casamorati': 'xerjoff', 'casamorati 1888': 'xerjoff',
    'lattafa perfumes': 'lattafa', 'lacoste fragrances': 'lacoste',
    'viktor and rolf': 'viktor rolf', 'paco rabanne': 'rabanne',
    'ds and durga': 'd s and durga', 'hugo boss': 'hugo boss',
}


def brand(value):
    n = norm(value)
    return ALIASES.get(n, n)


CONC = [
    ('Extrait', r'\b(?:extrait|extract)(?: de parfum| de perfume)?\b'),
    ('EDP', r'\beau (?:de|the) parf[ua]m\b|\bedp\b'),
    ('EDT', r'\beau de toilette\b|\bedt\b'),
    ('Cologne', r'\beau de cologne\b|\bedc\b|\bcologne absolue\b'),
    ('Parfum', r'\bparfum\b|\bpure perfume\b'),
]


def concentration(text):
    for label, pattern in CONC:
        if re.search(pattern, norm(text)):
            return label
    return None


def identity(text, house):
    n = norm(text)
    labels = {norm(house), brand(house)} | {a for a, b in ALIASES.items() if b == brand(house)}
    for label in sorted(labels, key=len, reverse=True):
        if label and n.startswith(label + ' '):
            n = n[len(label):].strip()
    for _, pattern in CONC:
        n = re.sub(pattern, ' ', n)
    # Keep Intense, Elixir, Absolu, Sport, flankers and edition names distinct.
    if n.strip() not in ('pour homme', 'pour femme', 'for men', 'for women'):
        n = re.sub(r'\b(?:for men|for man|for women|for woman|pour homme|pour femme|unisex)\b', ' ', n)
    n = re.sub(r'\b(?:19\d\d|20\d\d)\b', ' ', n)
    if brand(house) == 'armani':
        n = re.sub(r'^(?:emporio armani|armani prive|prive)\b', ' ', n)
    if brand(house) == 'xerjoff':
        n = re.sub(r'^(?:casamorati|1861|1888)\b', ' ', n)
    return re.sub(r'\s+', ' ', n).strip()


def gender(text):
    s = norm(text)
    if re.search(r'\bfor wom[ae]n\b|\bpour femme\b', s): return 'women'
    if re.search(r'\bfor m[ae]n\b|\bpour homme\b', s): return 'men'
    return None


def count(value):
    try: return int(float(str(value or '0').replace(',', '')))
    except ValueError: return 0


def load_signals():
    rows = []
    with (CACHE / 'fragrantica.csv').open(encoding='cp1252', newline='') as f:
        for r in csv.DictReader(f, delimiter=';'):
            if count(r['Rating Count']) > 0:
                rows.append(dict(source='fragrantica_snapshot', brand=r['Brand'], name=r['Perfume'],
                                 concentration=concentration(r['Perfume']), votes=count(r['Rating Count']),
                                 url=r['url'], year=r['Year'], gender=r['Gender']))
    with gzip.open(CACHE / 'parfumo.csv.gz', 'rt', encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            if count(r['Rating_Count']) <= 0: continue
            # This export sometimes concatenates perfume + house + year in Name.
            # The product URL retains the actual product identity.
            url_name = unquote(urlparse(r['URL']).path.rsplit('/', 1)[-1]).replace('_', ' ')
            rows.append(dict(source='parfumo_snapshot', brand=r['Brand'], name=url_name,
                             concentration=concentration(r['Concentration']), votes=count(r['Rating_Count']),
                             url=r['URL'], year=r['Release_Year'], gender=gender(r['Name'])))
    live = json.loads((DATA / 'popularity-parfumo-20261116.json').read_text(encoding='utf-8'))
    for r in live['rows']:
        rows.append(dict(source='parfumo_live_20261116', brand=r['brand'], name=r['name'],
                         concentration=concentration(r['name']), votes=r['votes'],
                         url=r['source_url'], year=next(iter(re.findall(r'\b(?:19\d\d|20\d\d)\b', r['name'])), None), gender=gender(r['name']),
                         category=r['category'], category_rank=r['category_rank']))
    return rows


def main():
    original_bytes = (DATA / 'merged.json').read_bytes()
    original = json.loads(original_bytes.decode('utf-8-sig'))
    pool = [dict(origin='merged', index=i, raw=p) for i, p in enumerate(original)]
    curated = json.loads((DATA / 'curated-catalog-sources.json').read_text(encoding='utf-8'))
    for r in curated:
        if 'merged_index' in r: continue
        pool.append(dict(origin='previous_curated_supplement', index=r['order'], raw=r['raw'],
                         explicit_concentration=r.get('concentration'), explicit_urls=r['source_urls']))

    pool_variants = collections.defaultdict(set)
    for entry in pool:
        p = entry['raw']
        entry['key'] = (brand(p['brand']), identity(p['name'], p['brand']))
        entry['resolved_concentration'] = entry.get('explicit_concentration') or concentration(p['name'])
        pool_variants[entry['key']].add((entry['resolved_concentration'], gender(p['name'])))
    signals = load_signals()
    index = collections.defaultdict(list)
    url_index = collections.defaultdict(list)
    maxima = collections.defaultdict(int)
    for r in signals:
        index[(brand(r['brand']), identity(r['name'], r['brand']))].append(r)
        url_index[r['url'].lower()].append(r)
        maxima[r['source']] = max(maxima[r['source']], r['votes'])
    # Historical and current Parfumo counts share the same normalization scale.
    parfumo_max = max(v for k, v in maxima.items() if k.startswith('parfumo'))
    for source in maxima:
        if source.startswith('parfumo'): maxima[source] = parfumo_max
    eligible, excluded, ambiguous = [], [], []
    for entry in pool:
        p = entry['raw']
        key = entry['key']
        c = entry['resolved_concentration']
        g = gender(p['name'])
        explicit_years = re.findall(r'\b(?:19\d\d|20\d\d)\b', p['name'])
        candidates = index.get(key, [])[:]
        for url in entry.get('explicit_urls', []): candidates += url_index.get(url.lower(), [])
        compatible = []
        explicit_matches = sum((url_index.get(u.lower(), []) for u in entry.get('explicit_urls', [])), [])
        for r in candidates:
            if c and r['concentration'] and c != r['concentration']: continue
            if g and r['gender'] in ('men', 'women') and g != r['gender']: continue
            if explicit_years and r['year'] and str(r['year']).split('.')[0] not in explicit_years: continue
            if not r['gender'] and g and len({v[1] for v in pool_variants[key] if v[1]}) > 1 and r not in explicit_matches:
                continue
            # A concentration-free database label cannot be assigned to every
            # concentration of the same perfume. Accept only a unique variant.
            if not r['concentration']:
                variants = {v[0] for v in pool_variants[key]}
                if len(variants) > 1 and r not in explicit_matches:
                    continue
            compatible.append(r)
        if not compatible:
            excluded.append(dict(origin=entry['origin'], index=entry['index'], brand=p['brand'], name=p['name'], reason='no_unambiguous_popularity_signal'))
            continue
        # One strongest vote count per source; do not add overlapping communities.
        evidence = []
        for source in maxima:
            matches = [r for r in compatible if r['source'] == source]
            if not matches: continue
            strongest = max(matches, key=lambda r: r['votes'])
            # Multiple different snapshot identities for one catalog entry need review.
            if source != 'parfumo_live_20261116' and len({r['url'] for r in matches}) > 1:
                ambiguous.append(dict(brand=p['brand'], name=p['name'], source=source, urls=sorted({r['url'] for r in matches})))
                continue
            evidence.append(strongest)
        if not evidence:
            excluded.append(dict(origin=entry['origin'], index=entry['index'], brand=p['brand'], name=p['name'], reason='ambiguous_source_identity'))
            continue
        # Log counts normalized by the largest count in each source capture.
        # Taking the maximum avoids penalizing perfumes absent from one dataset.
        score = max(math.log1p(r['votes']) / math.log1p(maxima[r['source']]) for r in evidence)
        eligible.append(dict(**entry, identity=list(key) + [c, g], concentration=c,
                             popularity_score=round(score, 8), evidence=evidence))

    eligible.sort(key=lambda e: (-e['popularity_score'], -max(r['votes'] for r in e['evidence']), e['raw']['brand'], e['raw']['name']))
    unique, seen, seen_source_ids, duplicate_rows = [], set(), set(), []
    for e in eligible:
        k = tuple(e['identity'])
        source_ids = {(r['source'], r['url']) for r in e['evidence'] if r['source'] != 'parfumo_live_20261116'}
        if k in seen or source_ids & seen_source_ids:
            duplicate_rows.append(dict(origin=e['origin'], index=e['index'], brand=e['raw']['brand'], name=e['raw']['name'], reason='duplicate_identity_or_source_product_id'))
            continue
        seen.add(k)
        seen_source_ids.update(source_ids)
        unique.append(e)
    if len(unique) < 1000: raise ValueError(f'Only {len(unique)} evidence-backed unique products; do not pad with guesses')
    chosen = unique[:1000]
    for e in unique[1000:]:
        excluded.append(dict(origin=e['origin'], index=e['index'], brand=e['raw']['brand'], name=e['raw']['name'], reason='below_1000_cutoff', popularity_score=e['popularity_score']))
    excluded += duplicate_rows
    # Preserve chosen source identities, then emit only the strict public schema.
    selected = []
    audit = []
    for rank, e in enumerate(chosen, 1):
        p = e['raw']
        selected.append(p)
        audit.append(dict(selection_order=rank, origin=e['origin'], source_index=e['index'],
                          brand=p['brand'], name=p['name'], concentration=e['concentration'],
                          popularity_score=e['popularity_score'], evidence=e['evidence']))
    summary = dict(
        selected_count=len(selected), original_merged_count=len(original),
        original_sha256=hashlib.sha256(original_bytes).hexdigest(),
        candidate_count=len(pool), evidence_backed_unique_candidates=len(unique),
        selected_from_merged=sum(e['origin'] == 'merged' for e in chosen),
        selected_from_previous_supplement=sum(e['origin'] != 'merged' for e in chosen),
        excluded_count=len(excluded), brands=dict(collections.Counter(p['brand'] for p in selected).most_common()),
        evidence_coverage=dict(collections.Counter(r['source'] for e in chosen for r in e['evidence'])),
        front_url_count=sum(bool(p.get('front_image')) for p in selected),
        back_url_count=sum(bool(p.get('back_image')) for p in selected),
        source_max_vote_counts=dict(maxima),
        provenance={
            'fragrantica_snapshot': dict(path='decantx/notes-source-cache/fragrantica.csv',
                url='https://github.com/prthm-rt/FragRec/blob/main/fragrances_clean.csv',
                sha256=hashlib.sha256((CACHE / 'fragrantica.csv').read_bytes()).hexdigest(), capture_date=None),
            'parfumo_snapshot': dict(path='decantx/notes-source-cache/parfumo.csv.gz',
                url='https://github.com/JennyIseev/fragrance-analysis/blob/main/data/02_Parfumo_Perfumes.csv.gz',
                sha256=hashlib.sha256((CACHE / 'parfumo.csv.gz').read_bytes()).hexdigest(), capture_date=None),
            'parfumo_live_20261116': dict(path='decantx/popularity-parfumo-20261116.json', checked_at='2026-11-16'),
        },
        method='max(log(1+rating_count)/log(1+platform_max_count)); historical and current Parfumo share a denominator; rating scores, price, stock and image availability do not affect selection',
        limitations=[
            'A popularity-based selection from the available catalog plus 21 previously curated supplementary identities, not an official worldwide sales ranking.',
            'Fragrantica and Parfumo CSV capture dates are unknown; their counts are historical. Current Parfumo Top 500 category pages checked 2026-11-16 supplement those snapshots.',
            'Current Parfumo category lists are community overall rankings, not a worldwide sales census. Different pages may shift during capture.',
            'Exact normalized brand/name matching; explicit concentration, gender and year compatibility. No fuzzy automatic matches.',
            'Selection is complete; bottle sizes, note accuracy, release years and image identity/availability still require a separate content audit before R2 upload.',
        ],
    )
    catalog, cleanup = build_catalog(selected, audit)
    for filename, value in [('selected-1000.json', catalog), ('catalog-cleanup-report.json', cleanup), ('selected-1000-audit.json', dict(summary=summary, products=audit)),
                            ('selection-excluded.json', excluded), ('selection-ambiguous.json', ambiguous)]:
        (DATA / filename).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    lines = ['# Popularity-based perfume selection (1,000)', '',
             'This is a catalog shortlist, not an official worldwide sales ranking.', '',
             '| Order | Brand | Product |', '|---|---|---|']
    lines += [f"| {i} | {p['brand'].replace('|', '/')} | {p['name'].replace('|', '/')} |" for i, p in enumerate(catalog, 1)]
    (DATA / 'selected-1000-list.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    assert original_bytes == (DATA / 'merged.json').read_bytes(), 'Original changed'
    print(json.dumps({k: v for k, v in summary.items() if k not in ('brands', 'limitations')}, indent=2))
    print('Top 15:', json.dumps([p['name'] for p in selected[:15]], ensure_ascii=True))


if __name__ == '__main__':
    main()
