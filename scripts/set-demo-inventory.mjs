// Deterministic demo quantities and placeholder prices; never represents real inventory.
import {readFile,writeFile,readdir,mkdir,copyFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const dir=path.join(root,"src/content/products");
const files=(await readdir(dir)).filter(f=>f.endsWith(".json")).sort();
const backup=path.join(root,"decantx","demo-inventory-backup-"+new Date().toISOString().replace(/[:.]/g,"-"));
await mkdir(backup,{recursive:true});
let available=0,soldOut=0,priced=0;const counts={};
const prices={2:20000,5:45000,10:80000,30:200000};
for(const [index,file] of files.entries()){
  await copyFile(path.join(dir,file),path.join(backup,file));
  const p=JSON.parse((await readFile(path.join(dir,file),"utf8")).replace(/^\uFEFF/,""));
  const out=index%12===11&&!p.featured;
  for(const s of p.sizes){
    const hash=createHash("sha256").update(p.slug+":"+s.ml).digest().readUInt32BE(0);
    s.stock=out?0:1+hash%5;s.inStock=s.stock>0;
    if(!(s.price>0)){s.price=prices[s.ml]??Math.ceil(s.ml*3000/500)*500;priced++;}
    counts[s.stock]=(counts[s.stock]??0)+1;
  }
  if(out)soldOut++;else available++;
  await writeFile(path.join(dir,file),JSON.stringify(p,null,2)+"\n");
}
const report={mode:"demo",products:files.length,available,soldOut,sizeQuantities:counts,placeholderPricesAdded:priced,demoPricesMnt:prices,backup:path.relative(root,backup),note:"Stock is a static per-size demo quantity. Orders do not decrement it. Existing positive reference prices are preserved; missing prices are demo placeholders."};
await writeFile(path.join(root,"decantx/demo-inventory-report.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
