"""Resolve the reviewed catalog selection; no product files are changed."""
import csv, json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parents[1]
raw = json.loads((ROOT/'decantx/merged.json').read_text(encoding='utf-8-sig'))
indices = json.loads((ROOT/'scripts/curated-indices.json').read_text())
indices[34] = None  # The requested classic EDP is 2015, not the different 2025 release.
targets = [line.split('|') for line in (ROOT/'scripts/curated-targets.txt').read_text().splitlines()]
assert len(indices) == len(targets) == 108
rows = list(csv.DictReader((ROOT/'decantx/notes-source-cache/fragrantica.csv').open(encoding='cp1252'), delimiter=';'))
# Explicit IDs distinguish concentrations and similarly named releases.
ids = {9:25967,10:49912,11:14669,27:3747,34:39029,55:611,56:52359,61:55795,
       81:67370,82:53947,83:49755,91:75805,92:88175,93:72821,94:76880,95:93628,
       96:84302,98:70839,106:11043,108:10190,35:31909}
manual = {
  82: {'top':['Orange','Bergamot','Mandarin Orange'],'middle':[],'base':[],'key':[]},
  83: {'top':[],'middle':[],'base':[],'key':['Oud','Incense','Rose','Raspberry','Saffron','Amberwood','Benzoin','Birch']},
}
out=[]
for order, ((brand,name,conc), index) in enumerate(zip(targets,indices),1):
    if index is not None:
        m=raw[index]
        if order in (30,102):
            m=dict(m)
            m['front_image']=f'https://fimgs.net/mdimg/perfume/375x500.{81927 if order==30 else 26358}.jpg'
        out.append({'order':order,'target':name,'brand':brand,'name':name,'requested_concentration':conc,'merged_index':index,'source_name':m['name'],'source_urls':m['product_urls'],'raw':m})
        continue
    id=ids[order]
    matches=[r for r in rows if r['url'].endswith('-'+str(id)+'.html')]
    r=matches[0] if matches else None
    if not r and order not in manual:
        raise ValueError(f'Missing dataset for {order} {name} ({id})')
    notes={k:[n.strip().title() for n in (r[col] if r else '').split(',') if n.strip() and n.strip().lower()!='unknown'] for k,col in [('top','Top'),('middle','Middle'),('base','Base')]}
    notes['key']=[]
    if order in manual: notes=manual[order]
    gender=(r['Gender'] if r else ('men' if order==81 else 'unisex'))
    if gender not in ('men','women','unisex'):raise ValueError(gender)
    url=r['url'] if r else f'https://www.fragrantica.com/perfume/Louis-Vuitton/{name.replace(" ","-")}-{id}.html'
    m={'name':f'{brand} {name}', 'brand':brand,'tags':[r['mainaccord1'].title()] if r else ['Fresh' if order==82 else 'Woody'], 'notes':notes,'variants':[], 'front_image':f'https://fimgs.net/mdimg/perfume/375x500.{id}.jpg','back_image':None,'product_urls':[url]}
    out.append({'order':order,'target':name,'brand':brand,'name':name,'concentration':conc,'gender':gender,'source_urls':[url],'dataset':'FragRec/Fragrantica public snapshot','raw':m})
(ROOT/'decantx/curated-catalog-sources.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'targets':len(out),'from_merged':sum('merged_index' in x for x in out),'supplementary':sum('merged_index' not in x for x in out)}))
