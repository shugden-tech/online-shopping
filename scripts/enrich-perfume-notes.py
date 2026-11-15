"""Resumeable public-source retrieval; conservative note extraction with audit trail."""
import concurrent.futures, collections, datetime, hashlib, html, json, pathlib, re, shutil, sys, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
DIR = ROOT / 'decantx'
CACHE = DIR / 'notes-source-cache'
CACHE.mkdir(exist_ok=True)
backups=sorted(DIR.glob('merged.backup-*.json'))
if not backups:
    backup_name='merged.backup-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.json'
    shutil.copy2(DIR/'merged.json',DIR/backup_name)
    backups=[DIR/backup_name]
BACKUP=backups[0]
DATA = json.loads(BACKUP.read_text(encoding='utf-8-sig'))
TIERS = ('top', 'middle', 'base', 'key')

def fetch(item):
    i, p = item
    u = (p.get('product_urls') or [None])[0]
    if not u: return i, None
    dest = CACHE / (hashlib.sha256(u.encode()).hexdigest() + '.json')
    if dest.exists(): return i, json.loads(dest.read_text(encoding='utf-8'))
    for attempt in range(3):
        try:
            req = urllib.request.Request(u.split('?')[0].rstrip('/') + '.json', headers={'User-Agent': 'Mozilla/5.0'})
            obj = json.load(urllib.request.urlopen(req, timeout=25))['product']
            raw = obj.get('body_html') or ''
            text = html.unescape(re.sub('<[^>]+>', ' ', re.sub(r'</(?:p|div|li)>|<br\s*/?>', '\n', raw)))
            result = {'url': u, 'retrieved_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'title': obj['title'], 'text': text, 'html': raw}
            dest.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
            return i, result
        except Exception as e:
            if attempt == 2: return i, {'url': u, 'error': str(e)}
            time.sleep(1 + attempt)

def download():
    report = DIR/'notes-enrichment-report.json'
    wanted = {p['index'] for p in json.loads(report.read_text(encoding='utf-8'))['unresolved']} if report.exists() else set(range(len(DATA)))
    work = [(i,p) for i,p in enumerate(DATA) if i in wanted]
    errors = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for n, (i, source) in enumerate(pool.map(fetch, work), 1):
            errors += bool(source and source.get('error'))
            if n % 100 == 0: print(f'fetched {n}/{len(work)}, errors {errors}', flush=True)
    print('download complete', len(work), errors, flush=True)

def extract_setup():
    counts = collections.Counter(n.lower().strip() for p in DATA for k in TIERS for n in p['notes'].get(k, []))
    vocab = {n for n,c in counts.items() if c >= 2 and 3 <= len(n) <= 38 and not re.search(r'\b(and|with|the|of|is|a|notes?:|top|base|middle)\b', n)}
    vocab.update('elderflower|black elder|black orchid|pink molecules|mahogany|blackwood|cream accord|champagne|white woods|white wood|red berries|sea water|white flowers|wildflowers|wheat|buddha wood|australian sandalwood|spearmint|mandarin leaf|wild lavender|lemon zest|lemon meringue|lemon cake|butter|vanilla cream|rum absolute|ink|birch tar|verbena|lily-of-the-valley|cypriol oil or nagarmotha|ambrette (musk mallow)'.split('|'))
    vocab.update('lentisc|sea breeze accord|rock rose|white florals|bulgarian rose|turkish rose|flower prism|stardust|cypriol|frozen musk'.split('|'))
    mp=DIR/'notes-matched-sources.json'
    if mp.exists():
        for row in json.loads(mp.read_text(encoding='utf-8')):
            for ns in row['source']['notes'].values():
                vocab.update(n.lower().strip() for n in ns if 3<=len(n)<=45 and not re.search(r'\b(?:while|and|with|the|a|is)\b',n,re.I))
    vocab.difference_update('fresh|sweet|warm|spicy|aromatic|floral|fruity|woody|powdery|green|oriental|citrus|leather scent|amber fragrance|water|red|black|white|man|men|women|heart|middle|base|top|opening|notes|perfume|parfum|fragrance|scent|unisex'.split('|'))
    vocab.difference_update('adding depth|atlas|dark|earthy aroma|fresh spicy|pink|sicilian|tropical|turkish|woodsy|while virginia cedar'.split('|'))
    vocab.update(['citrus','citrus accord','powdery elements','woods','Australian Kunzea','kunzea','ginger flower','habanolide','dewy accord','snow accord','woodsmoke','bonfire accord','orange blossom absolute','longoza'])
    pattern = re.compile(r'(?<![\w-])(?:' + '|'.join(re.escape(n) for n in sorted(vocab, key=len, reverse=True)) + r')(?![\w-])', re.I)
    return pattern

def extract(text, pattern):
    text = re.sub(r'\s+', ' ', html.unescape(text or '').replace('\u00a0', ' '))
    text=re.sub(r'Bulgarian and Turkish roses','Bulgarian rose and Turkish rose',text,flags=re.I)
    text=re.sub(r',\s*(?:and )?moves into\s+', '; heart notes: ',text,flags=re.I)
    text=re.sub(r',?\s+and settles into\s+', '; base notes: ',text,flags=re.I)
    text=re.sub(r',\s*settles into\s+', '; base notes: ',text,flags=re.I)
    result = {k: [] for k in TIERS}
    def notes(s):
        return list(dict.fromkeys(m.group().lower() for m in pattern.finditer(s)))
    # Split coordinated tier clauses, while retaining commas within ingredient lists.
    text=re.sub(r',\s+and\s+(?=[^.;]+?\b(?:give|gives|leave|leaves|form|forms|bring|brings|provide|provides)\b[^.;]{0,65}\b(?:heart|base|finish|depth|warmth|sweetness|trail)\b)', '; ', text, flags=re.I)
    # Explicitly labelled lists terminate at another label or a sentence boundary.
    label = re.compile(r'\b(top|head|opening|middle|heart|base|bottom|key)(?:\s+notes?\s*(?:are|is|includes?|of|:|\-|features?|featuring)|\s*[:\-])', re.I)
    matches = list(label.finditer(text))
    for pos, m in enumerate(matches):
        end = matches[pos+1].start() if pos+1 < len(matches) else len(text)
        chunk = re.split(r'[.;\n]', text[m.end():end])[0]
        chunk=re.split(r',?\s*(?:complemented by|leading into|followed by|evolving into|while|progresses into|and finishes|finishes with)',chunk,flags=re.I)[0]
        k = {'head':'top','opening':'top','heart':'middle','bottom':'base'}.get(m[1].lower(),m[1].lower())
        result[k].extend(notes(chunk))
    # Prefix and suffix grammar: never assign a whole multi-tier sentence to one tier.
    prose = re.sub(r'\s+', ' ', text)
    opening_words='bright|fresh|juicy|soft|sweet|crisp|spicy|zesty|citrusy|fruity|warm|green|rich|musky|herbal|sparkling|lush|bold|aromatic|tangy|bitter|creamy|floral|powdery|peppery|dark|resinous|salty|woody|smoky|dry|cool|golden|clean|icy|breezy|hot|boozy|and'
    boundary = r'(?=[.;]|,?\s+(?:and |while |leading into |complemented by )?(?:the |its |a )?(?:heart|middle|base|foundation)\b|$)'
    rules = {
        'top': [r'\b(?:opens? with|opening with|starts? with|at first[^,]*,?\s*(?:it carries with it )?(?:a blend of )?)(.+?)'+boundary,
                r'(?:^|[.;])\s*([^.;]+?)\s+open(?:s)?\s+(?:bright|fresh|juicy|soft|sweet|crisp|spicy|zesty|citrusy|fruity|the fragrance)'],
        'middle': [r'\b(?:heart|middle)(?:\s+(?:of the fragrance|of this fragrance))?\s+(?:notes?\s+)?(?:are|is|reveals?|includes?|features?|blends?|combines?|contains?|of|:|blooms with|forms? with)\s+(.+?)'+boundary,
                   r'(?:^|[.;]|,\s*(?:and\s+)?)([^.;]+?)\s+(?:form|forms|create|creates|make up)\s+(?:a|the|its)\s+(?:\w+\s+){0,3}heart\b'],
        'base': [r'\b(?:base|foundation)(?:\s+(?:of the fragrance|of this fragrance))?\s+(?:notes?\s+)?(?:are|is|includes?|features?|contains?|of|:|is crafted from|is composed of)\s+(.+?)(?=[.;]|$)',
                 r'(?:^|[.;]|,\s*(?:and\s+)?)([^.;]+?)\s+(?:give|gives|provide|provides)\s+it\s+(?:a|an)\s+[^.;]{0,60}?(?:finish|base)\b',
                 r'(?:^|[.;])\s*([^.;]+?)\s+at the base\b']}
    for k, patterns in rules.items():
        if result[k]: continue
        for rule in patterns:
            for m in re.finditer(rule, prose, re.I):
                segment=m[1]
                # Keep the final coordinated clause, excluding preceding tier clauses.
                segment=re.split(r'\b(?:heart|top notes|middle notes)\b,?\s*(?:and|while)?\s*',segment,flags=re.I)[-1]
                result[k].extend(notes(segment))
    for sentence in re.split(r'[.;]+',prose):
        suffix=re.compile(r'\b(?P<top>open(?:s)?\s+(?:(?:bright|fresh|juicy|soft|sweet|crisp|spicy|zesty|citrusy|fruity|and)\s*){1,4})\b|\b(?P<middle>(?:form|forms|create|creates|shape|shapes|deepen|deepens|carry|carries|bring|brings)\s+(?:an? |the |its )?(?:[\w,-]+\s+){0,3}heart)\b|\b(?P<base>(?:give|gives|leave|leaves|provide|provides|create|creates)\s+(?:it )?(?:an? |the |its )?(?:[\w,-]+\s+){0,4}(?:finish|base))\b',re.I)
        suffix=re.compile(suffix.pattern.replace('bright|fresh|juicy|soft|sweet|crisp|spicy|zesty|citrusy|fruity|and',opening_words).replace('carry|carries|bring|brings','carry|carries|bring|brings|add|adds|warm|warms|take|takes').replace('(?:finish|base)','(?:finish|base|depth|warmth|sweetness|trail)'),re.I)
        start=0
        for m in suffix.finditer(sentence):
            k=m.lastgroup
            segment=sentence[start:m.start()].strip(' ,')
            # Lists following a preceding tier's verb are separate clauses.
            if start: segment=re.sub(r'^and\s+','',segment,flags=re.I)
            if segment:
                ns=notes(segment)
                if ns: result[k]=ns
            start=m.end()
        for k,rule in [
            ('middle',r'\b(?:at (?:its|the) heart|in the heart|heart that features)\s*,?\s*(.+?)(?=,?\s*(?:and|while)\s+(?:the |its )?base\b|$)'),
            ('middle',r'\bcomplemented by (.+?) as its middle note'),
            ('middle',r'\bheart\s+(?:(?:that|which)\s+)?(?:(?:seamlessly|gently)\s+)?(?:blends|features|comprised of|composed of|includes|of|with)\s+(.+?)$'),
            ('middle',r'\bcomplemented by (.+?) in the heart'),
            ('middle',r'\b(?:followed by|blending into) (.+?) (?:as its middle notes|at the heart)'),
            ('middle',r'\bmiddle ones (.+?)$'),
            ('middle',r'\ba core of (.+?)(?=,|$)'),
            ('middle',r'\bheart\s+(?:unveils|revolves around)\s+(.+?)$'),
            ('top',r'^(.+?) opens (?:the scent|this fragrance)(?=,|$)'),
            ('top',r'\bbegin with (.+?)(?= and be followed|$)'),
            ('base',r'\bbase\s+(?:envelops|reveals|unfolds with|that includes|that combines|where|is crafted from|is composed of|composed of|consists of|combines|includes)\s+(.+?)$'),
            ('base',r'\bbase\s+(?:settles into|concludes with|voluptuous)\s+(.+?)$'),
            ('base',r'\bat the base,? (.+?)$'),
            ('base',r'\bin the base,? (.+?)$'),
            ('base',r'\banchored by (.+?) in its base'),
            ('base',r'\bconcludes with (?:the warm notes of )?(.+?)$'),
            ('base',r'\brounding out with (.+?) at its base'),
            ('base',r'\brounded off with (?:warm )?notes of (.+?)$')]:
            m=re.search(rule,sentence,re.I)
            if m and not result[k]: result[k].extend(notes(m[1]))
    # Unclassified ingredients stay unclassified; do not invent a pyramid.
    ingredient_sentences = [s for s in re.split(r'[.;]+',prose) if re.search(r'\b(?:blend|blends|notes|with|combines|combination|accord|ingredients|features|composed|composition|essence of)\b',s,re.I) and not re.search(r'\b(?:fragrance for|fragrance meant|created by|nose behind)\b',s,re.I)]
    result['key'] = notes(' '.join(ingredient_sentences))
    for k in TIERS: result[k] = list(dict.fromkeys(result[k]))
    classified = set(sum((result[k] for k in TIERS[:3]), []))
    result['key'] = [n for n in result['key'] if n not in classified]
    return result

def enrich(write=False):
    pattern = extract_setup()
    mp=DIR/'notes-matched-sources.json'
    matched={x['index']:x['source'] for x in json.loads(mp.read_text(encoding='utf-8'))} if mp.exists() else {}
    op=DIR/'notes-researched-overrides.json'
    overrides={x['index']:x for x in json.loads(op.read_text(encoding='utf-8'))} if op.exists() else {}
    extra=DIR/'notes-additional-research.json'
    if extra.exists(): overrides.update({x['index']:x for x in json.loads(extra.read_text(encoding='utf-8'))})
    audit, unresolved, remaining_tiers = [], [], []
    for i,p in enumerate(DATA):
        before = {k:list(p['notes'].get(k,[])) for k in TIERS}
        before_text=p['notes'].get('source_text')
        u=(p.get('product_urls') or [''])[0]
        cp=CACHE/(hashlib.sha256(u.encode()).hexdigest()+'.json')
        source=json.loads(cp.read_text(encoding='utf-8')) if cp.exists() else None
        sources=[{'url':u,'text':p['notes'].get('source_text') or '', 'kind':'existing_description'}]
        if source and source.get('text'): sources.append({**source,'kind':'live_product_description'})
        evidence=[]
        malformed={k:bool(re.search(r'\b(?:followed by|leading into|complemented by|while|featur(?:e|es|ing)|a base of|base notes|middle notes|top notes|heart of|in the heart|progresses into|finishes with|evolving into|creating a|leave an|create a|comprised|followed by a|at the heart)\b',' '.join(before[k]),re.I)) for k in TIERS}
        repaired=set()
        locked=bool(overrides.get(i,{}).get('replace_all'))
        if locked:
            p['notes'].update({k:list(overrides[i]['notes'].get(k,[])) for k in TIERS})
            evidence.append({'url':overrides[i]['url'],'kind':'corrected_wrong_product_identity','added':overrides[i]['notes']})
            sources=[]
        for structured in ([] if locked else [overrides.get(i),matched.get(i)]):
            if not structured: continue
            added={}
            for k in TIERS:
                if (not p['notes'].get(k) or (malformed[k] and k not in repaired)) and structured['notes'].get(k):
                    p['notes'][k]=structured['notes'][k]; added[k]=structured['notes'][k]
                    if malformed[k]: repaired.add(k)
            if added: evidence.append({'url':structured['url'],'kind':structured.get('dataset','researched_source'),'added':added})
        for s in sources:
            found=extract(s['text'],pattern)
            added={}
            for k in TIERS:
                if (not p['notes'].get(k) or (malformed[k] and k not in repaired)) and found[k]:
                    p['notes'][k]=found[k]; added[k]=found[k]
                    if malformed[k]: repaired.add(k)
            if added: evidence.append({'url':s['url'],'kind':s['kind'],'added':added})
        after={k:p['notes'].get(k,[]) for k in TIERS}
        if not before['key'] and any(after.values()):
            unique={}
            for k in TIERS:
                for n in after[k]: unique.setdefault(n.casefold(),n)
            after['key']=list(unique.values())
            p['notes']['key']=after['key']
            evidence.append({'kind':'union_of_sourced_notes','added':{'key':after['key']}})
        if locked or not before_text or str(before_text).strip().lower() in ('n/a','na','none','null','"') or i==104 or 'empty paragraph' in str(before_text):
            p['notes']['source_text']='Verified fragrance notes for '+p['name']+': '+', '.join(after['key'])+'.'
        if before != after or before_text!=p['notes'].get('source_text'):
            entry={'index':i,'name':p['name'],'before':before,'after':after,'evidence':evidence}
            if before_text!=p['notes'].get('source_text'): entry.update({'before_source_text':before_text,'after_source_text':p['notes']['source_text']})
            audit.append(entry)
        if not any(after.values()): unresolved.append({'index':i,'name':p['name'],'url':u,'source_text':p['notes'].get('source_text')})
        missing=[k for k in TIERS[:3] if not after[k]]
        if missing:
            remaining_tiers.append({'index':i,'name':p['name'],'empty_tiers':missing,'known_notes':after['key'],'status':'flat_note_list_available' if len(missing)==3 else 'partial_pyramid_available','reason':'No verified assignment for these tiers; notes have not been duplicated or assigned by ingredient volatility.','source_urls':list(dict.fromkeys(e['url'] for e in evidence if e.get('url'))) or [u]})
    report={'generated_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'backup':str(BACKUP.relative_to(ROOT)),'backup_sha256':hashlib.sha256(BACKUP.read_bytes()).hexdigest(),'products':len(DATA),'changed':len(audit),'still_without_notes':len(unresolved),'empty_tiers':{k:sum(not p['notes'].get(k) for p in DATA) for k in TIERS},'complete_pyramids':sum(all(p['notes'].get(k) for k in TIERS[:3]) for p in DATA),'flat_only':sum(not any(p['notes'].get(k) for k in TIERS[:3]) for p in DATA),'partial_pyramids':sum(0<sum(bool(p['notes'].get(k)) for k in TIERS[:3])<3 for p in DATA),'changes':audit,'unresolved':unresolved,'remaining_tiers':remaining_tiers}
    (DIR/'notes-enrichment-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    if write:
        current=json.loads((DIR/'merged.json').read_text(encoding='utf-8-sig'))
        assert len(current)==len(DATA)
        for old,new in zip(current,DATA):
            assert {k:v for k,v in old.items() if k!='notes'}=={k:v for k,v in new.items() if k!='notes'}, 'Non-note data changed; refusing overwrite'
        assert not unresolved, 'Unresolved perfumes remain'
        temp=DIR/'merged.enriched.tmp.json'
        temp.write_text(json.dumps(DATA,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        json.loads(temp.read_text(encoding='utf-8'))
        temp.replace(DIR/'merged.json')
    print(json.dumps({k:v for k,v in report.items() if k not in ('changes','unresolved','remaining_tiers')}),flush=True)

if __name__ == '__main__':
    if '--datasets' in sys.argv:
        for url, name in [('https://raw.githubusercontent.com/JennyIseev/fragrance-analysis/main/data/02_Parfumo_Perfumes.csv.gz','parfumo.csv.gz'),('https://raw.githubusercontent.com/Scento-com/perfume-dataset/main/perfumes.jsonl','scento.jsonl'),('https://raw.githubusercontent.com/prthm-rt/FragRec/main/fragrances_clean.csv','fragrantica.csv')]:
            target=CACHE/name
            if not target.exists():
                urllib.request.urlretrieve(url,target)
            print(name,target.stat().st_size,flush=True)
    elif '--extract' in sys.argv: enrich('--write' in sys.argv)
    else: download()

