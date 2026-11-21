"""Download and validate the approved catalog's source images as local WebP files."""
import concurrent.futures, datetime, hashlib, io, json, pathlib, time, urllib.request
from PIL import Image, ImageOps

ROOT=pathlib.Path(__file__).resolve().parents[1]
DEST=ROOT/'public/product-photos'
DEST.mkdir(parents=True,exist_ok=True)
items=json.loads((ROOT/'decantx/curated-catalog-sources.json').read_text(encoding='utf-8'))
previous_path=ROOT/'decantx/curated-photo-report.json'
previous=json.loads(previous_path.read_text(encoding='utf-8')) if previous_path.exists() else []

def fetch(task):
    order,kind,url=task
    target=DEST/f'curated-{order:03}-{kind}.webp'
    if target.exists() and any(r.get('order')==order and r.get('kind')==kind and r.get('url')==url and r.get('local') for r in previous):
        with Image.open(target) as im: width,height=im.size
        return {'order':order,'kind':kind,'url':url,'local':'/product-photos/'+target.name,'width':width,'height':height,'cached':True}
    error=''
    for attempt in range(3):
        try:
            req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
            with urllib.request.urlopen(req,timeout=35) as response: raw=response.read(20_000_000)
            with Image.open(io.BytesIO(raw)) as im:
                im=ImageOps.exif_transpose(im).convert('RGBA')
                canvas=Image.new('RGB',im.size,'white');canvas.paste(im,mask=im.getchannel('A'))
                canvas.thumbnail((1200,1200));width,height=canvas.size
                if min(width,height)<100:raise ValueError('Image too small')
                canvas.save(target,'WEBP',quality=86,method=6)
            return {'order':order,'kind':kind,'url':url,'local':'/product-photos/'+target.name,'width':width,'height':height,'source_sha256':hashlib.sha256(raw).hexdigest(),'downloaded_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
        except Exception as e:
            error=str(e)
            if attempt<2:time.sleep(1)
    return {'order':order,'kind':kind,'url':url,'error':error}

tasks=[(x['order'],kind,x['raw'][field]) for x in items for kind,field in [('front','front_image'),('back','back_image')] if x['raw'].get(field)]
results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    for n,r in enumerate(pool.map(fetch,tasks),1):
        results.append(r)
        if n%20==0 or 'error' in r:print(json.dumps({'progress':n,'total':len(tasks),**({'failed':r} if 'error' in r else {})}),flush=True)
(ROOT/'decantx/curated-photo-report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'attempted':len(results),'downloaded':sum('local' in x for x in results),'errors':[x for x in results if 'error' in x]}),flush=True)
