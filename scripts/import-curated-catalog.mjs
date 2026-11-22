// Add the reviewed popular selection and all logo brands without replacing the current catalog.
import { readFile, writeFile, readdir, mkdir, copyFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { concentrationOf, genderOf, familyOf, sizesOf, noteIds, slugify, mongolianDescription } from "./import-merged-products.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const read=async p=>JSON.parse((await readFile(path.join(root,p),"utf8")).replace(/^\uFEFF/,""));
const write=process.argv.includes("--write");
const sources=await read("decantx/curated-catalog-sources.json");
const photos=await read("decantx/curated-photo-report.json");
const notes=await read("src/data/notes.json");
const mn=await read("src/i18n/mn.json");
const dir=path.join(root,"src/content/products");
const existing=await Promise.all((await readdir(dir)).filter(f=>f.endsWith(".json")).map(async f=>({file:f,data:await read("src/content/products/"+f)})));
const compact=s=>slugify(s).replaceAll("-","");
const canonicalBrand=b=>({Armani:"Giorgio Armani","Paco Rabanne":"Rabanne",Lancome:"Lancôme","By Kilian":"Kilian"}[b]??b);
const pendingNotes=[],products=[],audit=[];
const noteAliases={
  woodsy:"woods",woody:"woods","watery notes":"marine",salt:"sea-salt","sea water":"marine","aquatic accord":"marine",
  "haitian vetiver":"vetiver","black vanilla husk":"vanilla","madagascar vanilla":"vanilla","bourbon vanilla":"vanilla",
  "vanilla absolute":"vanilla","vanilla pod":"vanilla","vanilla caviar":"vanilla","tunisian orange blossom":"orange-blossom",
  "african orange flower":"orange-blossom","neroli essence":"neroli","tunisian neroli":"neroli","tunisian neroli essence":"neroli",
  "red cedar":"cedar","virginian cedar":"cedar","texas cedar":"cedar","madagascar pepper":"pepper",
  "rose de mai":"rose","blood mandarin":"mandarin","italian mandarin":"mandarin","spicy notes":"pepper",spice:"pepper",
  "indian patchouli":"patchouli","indonesian patchouli leaf":"patchouli","patchouli leaf":"patchouli",
  "cacao pod":"cacao","water jasmine":"jasmine","egyptian jasmine":"jasmine",litchi:"lychee",
  "oak moss":"oakmoss","sicilian orange":"orange","nigerian ginger":"ginger","ceylon cinnamon":"cinnamon",
  "frankincense":"incense","big strawberry":"strawberry","ambrox":"ambroxan",
};
const translations={
  "oriental-notes":"Дорно дахины ноот",caraway:"Гоньд",aldehydes:"Альдегид", "lemon-zest":"Нимбэгийн хальс",
  "iso-e-super":"Iso E Super",ambrofixtm:"Амброфикс",davana:"Давана",chestnut:"Туулайн бөөр", "mineral-notes":"Эрдсийн ноот",
  pepperwoodtm:"Пеппервүүд",papyrus:"Папирус",hyacinth:"Гиацинт", "tolu-balsam":"Толу бальзам",cistus:"Ладан бут",
  "metallic-notes":"Металллаг ноот",coal:"Нүүрс", "soil-tincture":"Хөрсний ханд",angelica:"Анжелика",coumarin:"Кумарин",
  "carrot-seeds":"Луувангийн үр",mate:"Мате цай",akigalawood:"Акигалавүүд",cashmeran:"Кашмеран",orchid:"Цахирмаа",
  "bitter-almond":"Гашуун бүйлс", "vanilla-orchid":"Ванилийн цахирмаа",blackberry:"Хар бөөрөлзгөнө",strawberry:"Гүзээлзгэнэ",
  "sour-cherry":"Исгэлэн интоор",serenolide:"Серенолид",gardenia:"Гардения",carnation:"Лиш цэцэг",apricot:"Чангаанз",
  "red-berries":"Улаан жимсгэнэ",frangipani:"Франжипани", "brown-sugar":"Бор сахар",pomegranate:"Анар",ice:"Мөс",
  mahogany:"Зандан мод", "floral-notes":"Цэцгийн ноот",petalia:"Петалиа", "chinese-black-tea":"Хятад хар цай",
  "tobacco-blossom":"Тамхины цэцэг", "black-cherry":"Хар интоор", "cherry-liqueur":"Интоорын ликёр", "peru-balsam":"Перу бальзам",
  dates:"Хасарваань",mahonial:"Махониал", "candied-fruits":"Чихэрлэсэн жимс", "gourmand-accord":"Амттаны аккорд",
  caramel:"Карамель",sugar:"Сахар",milk:"Сүү", "creme-brulee":"Крем брюле",turmeric:"Куркума", "wild-lavender":"Зэрлэг лаванда",
  buchu:"Бучу", "african-marigold":"Африк хилэн цэцэг",cucumber:"Өргөст хэмх",passionfruit:"Маракуйя",
};
for (const row of sources) {
  const m=row.raw;
  const concentration=row.concentration??concentrationOf(m)??row.requested_concentration;
  const gender=row.gender??genderOf(m)??([51,69].includes(row.order)?"women":undefined);
  const family=familyOf(m);
  if (!concentration||!gender||!family)throw Error(`Unmapped metadata ${row.order}: ${m.name} ${JSON.stringify({concentration,gender,family})}`);
  const brand=row.brand==="Armani" ? (/^Emporio/.test(m.name)?"Emporio Armani":"Giorgio Armani") : canonicalBrand(row.brand);
  let name=row.name;
  const slug=slugify(`${brand} ${name} ${concentration}`);
  const old=existing.find(x=>x.data.slug===slug||(compact(x.data.brand)===compact(m.brand)&&compact(x.data.name)===compact(name)&&x.data.concentration===concentration));
  if (old) {audit.push({order:row.order,slug:old.data.slug,status:"existing_product_preserved",source_urls:row.source_urls});continue;}
  const tier=k=>[...new Set((m.notes[k]??[]).flatMap(raw=>{
    raw=raw.replace(/\s+and\s*$/i,"").trim();
    if (/\b(?:fragrance|creating|sensuality|statement|skin-like)\b/i.test(raw))return [];
    const alias=noteAliases[raw.toLowerCase()];
    if(alias&&notes[alias])return [alias];
    const unknown=new Set(); const ids=noteIds(raw,notes,unknown);
    if(ids.length)return ids;
    if(!unknown.size)return [];
    const id=slugify(raw);
    if(!id||raw.length>55)return [];
    if(!notes[id]){notes[id]={en:raw,mn:translations[id]??raw};if(!translations[id])pendingNotes.push({id,en:raw});}
    return [id];
  }))].slice(0,8);
  const noteData={top:tier("top"),heart:tier("middle"),base:tier("base")};
  if(!noteData.top.length&&!noteData.heart.length&&!noteData.base.length)noteData.key=tier("key");
  if(!Object.values(noteData).some(a=>a.length))throw Error(`No notes: ${row.order}`);
  const sizes=sizesOf(m).map(s=>({...s,inStock:false}));
  if(!sizes.length)sizes.push({ml:5,price:0,inStock:false},{ml:10,price:0,inStock:false});
  const local={};
  for(const kind of ["front","back"]){const ph=photos.find(p=>p.order===row.order&&p.kind===kind&&p.local);if(ph){await access(path.join(root,"public",ph.local));local[kind]=ph.local;}}
  if(!local.front)throw Error(`Missing verified front image: ${row.order}`);
  const p={slug,brand,name,concentration,gender,family,notes:noteData,description:{mn:"",en:""},sizes,bottleShape:"classic",...(row.order<=8?{featured:true}:{}),intensity:({EDT:2,EDP:3,Parfum:4,Extrait:5,Cologne:1})[concentration],season:["spring","summer","autumn","winter"],occasion:["day"],photos:local};
  const labels=Object.values(noteData).flat().slice(0,5).map(id=>notes[id].en.toLowerCase());
  p.description.en=`${brand} ${name} is a ${family} fragrance in ${concentration} concentration. Its listed notes include ${labels.join(", ")}.`;
  p.description.mn=mongolianDescription(p,notes,mn);
  if(p.notes.key?.length)p.description.mn+=` Үндсэн ноотууд: ${p.notes.key.map(id=>notes[id].mn).join(", ")}.`;
  products.push(p);
  audit.push({order:row.order,slug,status:"added",source_urls:row.source_urls,source_name:m.name,merged_index:row.merged_index,pricing:sizes.some(s=>s.price>0)?"reference USD prices converted at existing 3500 MNT/USD, not owner confirmed":"price not set",inventory:"unconfirmed, not available for purchase",photos:local});
}
const collision=products.find(p=>existing.some(x=>x.data.slug===p.slug));
if(collision)throw Error(`Slug collision: ${collision.slug}`);
if(new Set(products.map(p=>p.slug)).size!==products.length)throw Error("Duplicate new slugs");
const report={targets:sources.length,added:products.length,existing_preserved:existing.length,existing_targets:audit.filter(x=>x.status!=="added").length,new_total:existing.length+products.length,pending_note_translations:pendingNotes,products:audit};
if(write){
  const backup=path.join(root,"decantx","catalog-backup-"+new Date().toISOString().replace(/[:.]/g,"-"));
  await mkdir(backup,{recursive:true});
  await copyFile(path.join(root,"src/data/notes.json"),path.join(backup,"notes.json"));
  for(const x of existing)await copyFile(path.join(dir,x.file),path.join(backup,x.file));
  report.backup=path.relative(root,backup);
  for(const p of products)await writeFile(path.join(dir,p.slug+".json"),JSON.stringify(p,null,2)+"\n");
  await writeFile(path.join(root,"src/data/notes.json"),JSON.stringify(notes,null,2)+"\n");
}
await writeFile(path.join(root,"decantx/curated-catalog-import-report.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({...report,products:undefined},null,2));
