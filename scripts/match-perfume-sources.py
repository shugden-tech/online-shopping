"""Match only exact normalized house/name and compatible concentration."""
import collections, csv, gzip, json, pathlib, re, unicodedata

ROOT=pathlib.Path(__file__).resolve().parents[1]
DIR=ROOT/'decantx'
CACHE=DIR/'notes-source-cache'

def norm(s):
    s=unicodedata.normalize('NFKD',s.lower()).encode('ascii','ignore').decode()
    return re.sub(r'[^a-z0-9]+',' ',s.replace('&',' and ').replace("'",'').replace('’','')).strip()

ALIASES={'by kilian':'kilian','kilian paris':'kilian','christian dior':'dior','ds and durga':'d s and durga','dolce and gabbana':'dolce gabbana','giorgio armani':'armani','bond no 9':'bond no 9','the house of oud':'the house of oud','maison martin margiela':'maison margiela','parfums de marly':'parfums de marly','roja parfums':'roja dove','zarkoperfume':'zarkoperfume'}
def brand(s):
    n=norm(s)
    return ALIASES.get(n,n)

def conc(s):
    s=norm(s)
    for k,pat in [('extrait',r'extrait|extract'),('edp',r'eau (?:de|the) parfum|\bedp\b'),('edt',r'eau de toilette|\bedt\b'),('edc',r'eau de cologne|cologne absolue|\bedc\b'),('parfum',r'\bparfum\b|pure perfume')]:
        if re.search(pat,s): return k
    return ''

def name(s,b=''):
    s=norm(s)
    options=sorted({norm(b),brand(b),'christian dior','giorgio armani','by kilian'},key=len,reverse=True)
    for prefix in options:
        if prefix and s.startswith(prefix+' '): s=s[len(prefix):].strip(); break
    s=re.sub(r'\b(?:eau de parfum|eau the parfum|eau de toilette|eau de cologne|extrait de parfum|extrait de perfume|parfum extrait|parfum intense|cologne absolue|pure perfume|eau de perfume|extrait|parfum|edp|edt|edc)\b',' ',s)
    s=re.sub(r'\b(?:for men|for man|for women|for woman|unisex|limited edition|collection notes de fond|collection notes de tete)\b',' ',s)
    s=s.replace('noble collection','noble')
    s=re.sub(r'\s+',' ',s).strip()
    return s

def load():
    rows=[]
    fp=CACHE/'fragrantica.csv'
    if fp.exists():
        with fp.open(encoding='cp1252',newline='') as f:
            for r in csv.DictReader(f,delimiter=';'):
                if not r.get('Brand') or not r.get('Perfume'): continue
                notes={k:[x.strip() for x in (r.get(col) or '').split(',') if x.strip() and x.strip().lower() not in ('nan','unknown','none','n/a')] for k,col in [('top','Top'),('middle','Middle'),('base','Base')]}
                if notes['top'] and not notes['middle'] and not notes['base']:
                    notes={'key':notes['top']}
                if any(notes.values()): rows.append({'brand':r['Brand'],'name':r['Perfume'],'concentration':r['Perfume'],'gender':r.get('Gender',''),'year':r.get('Year',''),'url':r['url'],'notes':notes,'dataset':'Fragrantica public snapshot via FragRec'})
    with gzip.open(CACHE/'parfumo.csv.gz','rt',encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            notes={k:[x.strip() for x in r[col].split(',') if x.strip() and x.strip().lower()!='nan'] for k,col in [('top','Top_Notes'),('middle','Middle_Notes'),('base','Base_Notes')]}
            if any(notes.values()): rows.append({'brand':r['Brand'],'name':r['Name'],'concentration':r['Concentration'],'year':r['Release_Year'],'url':r['URL'],'notes':notes,'dataset':'Parfumo snapshot'})
    p=CACHE/'scento.jsonl'
    if p.exists():
        for line in p.read_text(encoding='utf-8').splitlines():
            try: r=json.loads(line)
            except json.JSONDecodeError: continue
            notes={k:r.get(col) or [] for k,col in [('top','top_notes'),('middle','heart_notes'),('base','base_notes'),('key','notes')]}
            if any(notes.values()): rows.append({'brand':r['house'],'name':r['name'],'concentration':r.get('concentration',''),'year':str(r.get('year') or ''),'url':r['url'],'notes':notes,'dataset':'Scento (CC BY 4.0)'})
    return rows

def main():
    data=json.loads((DIR/'merged.json').read_text(encoding='utf-8-sig'))
    index=collections.defaultdict(list)
    rows=load()
    for r in rows: index[(brand(r['brand']),name(r['name'],r['brand']))].append(r)
    matched=[]
    for i,p in enumerate(data):
        candidates=index.get((brand(p['brand']),name(p['name'],p['brand'])),[])
        pg='women' if re.search(r'for wom[ae]n|feminine|pour femme',p['name'],re.I) else 'men' if re.search(r'for m[ae]n|masculine|pour homme',p['name'],re.I) else ''
        if pg:
            def rg(r):
                if r.get('gender'): return r['gender']
                if re.search(r'for wom[ae]n|feminine|pour femme',r['name'],re.I): return 'women'
                if re.search(r'for m[ae]n|masculine|pour homme',r['name'],re.I): return 'men'
                return ''
            candidates=[r for r in candidates if rg(r) in ('',pg,'unisex')]
        c=conc(p['name'])
        candidates=[r for r in candidates if not conc(r['concentration']) or not c or conc(r['concentration'])==c]
        year=re.search(r'\b(19\d\d|20\d\d)\b',p['name'])
        if year: candidates=[r for r in candidates if r['year'].startswith(year[1])]
        if not candidates: continue
        # Reject ambiguous identities (reformulations / multiple variants).
        # Prefer Fragrantica snapshot, then Parfumo, then Scento; differences
        # between databases are not evidence that two identities differ.
        order={'Fragrantica public snapshot via FragRec':0,'Parfumo snapshot':1,'Scento (CC BY 4.0)':2}
        priority=min(order[r['dataset']] for r in candidates)
        candidates=[r for r in candidates if order[r['dataset']]==priority]
        unique={json.dumps(r['notes'],sort_keys=True) for r in candidates}
        if len(unique)>1:
            exact=[r for r in candidates if c and conc(r['concentration'])==c]
            if len(exact)==1: candidates=exact
            else: continue
        r=candidates[0]
        matched.append({'index':i,'name':p['name'],'source':r})
    (DIR/'notes-matched-sources.json').write_text(json.dumps(matched,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('source rows',len(rows),'exact compatible matches',len(matched))
    report=json.loads((DIR/'notes-enrichment-report.json').read_text(encoding='utf-8'))
    ids={x['index'] for x in matched}
    print('unresolved covered',sum(x['index'] in ids for x in report['unresolved']))
    print(json.dumps([{'index':x['index'],'name':x['name']} for x in report['unresolved'] if x['index'] not in ids],ensure_ascii=True,indent=2))

if __name__=='__main__': main()
