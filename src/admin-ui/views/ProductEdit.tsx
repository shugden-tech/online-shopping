// Product editor: every AdminProduct field, front/back images (upload or URL), status + sale lock,
// SKU table (price empty = not for sale), inventory adjust + movement history.
import { useEffect, useState } from "preact/hooks";
import {
  GENDERS, PRODUCT_ID_RE, PRODUCT_STATUSES, SKU_KINDS, type AdminProduct, type AdminSku,
} from "../../lib/contracts";
import { api, enc, rows, pick } from "../api";
import { GENDER, PRODUCT_STATUS, SKU_KIND, STOCK_REASON, money, num, when } from "../labels";
import { ConfirmButton, Field, Loading, Msg, Table, go, intOrNull, useMsg, useSession } from "../ui";

const MAX_IMAGE = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

interface Form {
  id: string; brand: string; name: string; concentration: string; gender: string; family: string; releaseYear: string;
  top: string[]; heart: string[]; base: string[]; descriptionMn: string; descriptionEn: string;
  status: string; saleLocked: boolean; sort: string;
}

const toForm = (p: AdminProduct | null): Form => ({
  id: p?.id ?? "", brand: p?.brand ?? "", name: p?.name ?? "", concentration: p?.concentration ?? "",
  gender: p?.gender ?? "", family: p?.family ?? "", releaseYear: p?.releaseYear?.toString() ?? "",
  top: p?.notes.top ?? [], heart: p?.notes.heart ?? [], base: p?.notes.base ?? [],
  descriptionMn: p?.descriptionMn ?? "", descriptionEn: p?.descriptionEn ?? "",
  status: p?.status ?? "draft", saleLocked: p?.saleLocked ?? false, sort: String(p?.sort ?? 0),
});

const orNull = (s: string) => (s.trim() ? s.trim() : null);
const FAMILIES: Record<string, string> = {
  amber: "Амбер", woody: "Модлог", floral: "Цэцэгс", citrus: "Цитрус", chypre: "Шипр", fresh: "Сэргэг", gourmand: "Гурманд", aromatic: "Ароматик",
};

/** Mongolian / Russian Cyrillic -> Latin for URL ids. */
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o",
  ө: "u", п: "p", р: "r", с: "s", т: "t", у: "u", ү: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};
/** "Maison Francis Kurkdjian" + "Baccarat Rouge 540" -> "maison-francis-kurkdjian-baccarat-rouge-540" */
export function slugify(...parts: string[]): string {
  return parts.join(" ").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[а-яёөү]/g, (c) => TRANSLIT[c] ?? "").replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 110).replace(/-+$/, "");
}

/** Chip input for scent notes: Enter or comma adds, × removes, Backspace on empty removes the last one. */
function Chips({ label, value, onChange, disabled, hint }: { label: string; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; hint?: string }) {
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const items = raw.split(",").map((x) => x.trim()).filter(Boolean).filter((x) => !value.includes(x));
    if (items.length) onChange([...value, ...items].slice(0, 30));
    setText("");
  };
  return (
    <div class="a-field a-field--wide">
      <span class="a-field__label">{label}</span>
      <div class="a-chips" onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}>
        {value.map((v) => (
          <span class="a-chip">{v}{!disabled && <button type="button" aria-label={`${v} хасах`} onClick={() => onChange(value.filter((x) => x !== v))}>×</button>}</span>
        ))}
        {!disabled && (
          <input
            aria-label={label} value={text} placeholder={value.length ? "" : "ж: bergamot, Enter"}
            onInput={(e) => { const t = e.currentTarget.value; if (t.includes(",")) add(t); else setText(t); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); add(text); }
              else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
            }}
            onBlur={() => text.trim() && add(text)}
          />
        )}
      </div>
      {hint && <span class="a-field__hint">{hint}</span>}
    </div>
  );
}

/** Form -> AdminProduct-shaped editable fields, or an error message. */
function fromForm(f: Form): { value: Record<string, unknown> } | { error: string } {
  const year = intOrNull(f.releaseYear);
  if (Number.isNaN(year) || (year !== null && (year < 1700 || year > 2100))) return { error: "Он: 1700–2100 хооронд бүхэл тоо эсвэл хоосон." };
  const sort = intOrNull(f.sort);
  if (Number.isNaN(sort)) return { error: "Эрэмбэ: бүхэл тоо." };
  if (!f.brand.trim() || !f.name.trim()) return { error: "Брэнд ба нэрийг заавал бөглөнө үү." };
  return {
    value: {
      brand: f.brand.trim(), name: f.name.trim(), concentration: orNull(f.concentration), gender: f.gender || null,
      family: orNull(f.family), releaseYear: year, notes: { top: f.top, heart: f.heart, base: f.base },
      descriptionMn: orNull(f.descriptionMn), descriptionEn: orNull(f.descriptionEn),
      status: f.status, saleLocked: f.saleLocked, sort: sort ?? 0,
    },
  };
}

const productOf = (d: any): AdminProduct | null => (d?.product && typeof d.product === "object" ? d.product : d?.id ? d : null);

export default function ProductEdit({ id }: { id: string }) {
  const { can } = useSession();
  const isNew = !id;
  const canEdit = can("catalog.write");
  const [product, setProduct] = useState<AdminProduct | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [loading, setLoading] = useState(!isNew);
  const [form, setForm] = useState<Form>(toForm(null));
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ front?: Blob; back?: Blob }>({});
  const msg = useMsg();

  async function load() {
    const res = await api(`/api/admin/products/${enc(id)}`);
    setLoading(false);
    if (!res.ok) { setLoadErr(res.error); return; }
    const p = productOf(res.data);
    setProduct(p);
    setForm(toForm(p));
  }
  useEffect(() => { if (!isNew) load(); }, [id]);
  const [brands, setBrands] = useState<string[]>([]);
  useEffect(() => { api("/api/admin/products/facets").then((r) => r.ok && setBrands((r.data.brands ?? []).map((b: { value: string }) => b.value))); }, []);

  /** Apply a server response that may carry the updated product; otherwise reload. */
  async function applyProduct(d: any) {
    const p = productOf(d);
    if (p && Array.isArray(p.skus)) { setProduct(p); setForm(toForm(p)); } else await load();
  }

  async function save(e: Event) {
    e.preventDefault();
    if (!canEdit) return;
    const v = fromForm(form);
    if ("error" in v) { msg.err(v.error); return; }
    setBusy(true);
    if (isNew) {
      const base = form.id || slugify(form.brand, form.name, form.concentration);
      if (!PRODUCT_ID_RE.test(base)) { setBusy(false); msg.err("ID: зөвхөн жижиг латин үсэг, тоо, зураас (a-z, 0-9, -), 120 тэмдэгт хүртэл."); return; }
      // the id must be unique: when it is taken, try base-2, base-3, …
      let id = base;
      let res = await api("/api/admin/products", { method: "POST", body: { id, ...v.value }, conflict: "ийм ID-тай бараа аль хэдийн байна." });
      for (let n = 2; !res.ok && res.status === 409 && n <= 9; n++) {
        id = `${base}-${n}`;
        res = await api("/api/admin/products", { method: "POST", body: { id, ...v.value }, conflict: "ийм ID-тай бараа аль хэдийн байна." });
      }
      if (!res.ok) { setBusy(false); msg.err(res.error); return; }
      // photos chosen before the product existed are uploaded now
      for (const side of ["front", "back"] as const) {
        const file = pending[side];
        if (!file) continue;
        msg.info(`${side === "front" ? "Урд" : "Ар"} талын зургийг оруулж байна…`);
        const up = await uploadImage(id, side, file);
        if ("error" in up) { msg.err(up.error); continue; }
        await api(`/api/admin/products/${enc(id)}`, { method: "PATCH", body: { [side === "front" ? "imageFront" : "imageBack"]: up.url } });
      }
      setBusy(false);
      go(`#/products/${enc(id)}`);
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v.value)) {
      if (JSON.stringify(val) !== JSON.stringify((product as any)?.[k])) patch[k] = val;
    }
    if (!Object.keys(patch).length) { setBusy(false); msg.info("Өөрчлөлт алга."); return; }
    const res = await api(`/api/admin/products/${enc(id)}`, { method: "PATCH", body: patch });
    setBusy(false);
    if (res.ok) { await applyProduct(res.data); msg.ok("Хадгаллаа."); } else msg.err(res.error);
  }

  const set = <K extends keyof Form>(k: K) => (e: Event) => {
    const t = e.currentTarget as HTMLInputElement;
    setForm({ ...form, [k]: t.type === "checkbox" ? t.checked : t.value });
  };

  if (loading) return <Loading on />;
  if (loadErr) return <><p><a href="#/products">‹ Бараа</a></p><Msg kind="err" text={loadErr} /></>;

  return (
    <section aria-labelledby="pe-h" class="a-stack">
      <p><a href="#/products">‹ Бараа</a></p>
      <div class="a-row a-row--between">
        <h1 id="pe-h" class="a-title">{isNew ? "Шинэ бараа" : `${product!.brand} — ${product!.name}`}</h1>
        {!isNew && (
          <div class="a-row">
            {product!.status === "active" && <a class="a-btn a-btn--sm" href={`/delguur/p/${enc(id)}`} target="_blank" rel="noopener" data-testid="view-store">Дэлгүүрт харах ↗</a>}
            {can("audit.read") && <a class="a-btn a-btn--sm a-btn--ghost" href={`#/audit?entity=product&entityId=${enc(id)}`}>Түүх</a>}
          </div>
        )}
      </div>
      {!canEdit && <Msg kind="info" text="Таны эрхээр барааны мэдээлэл засах боломжгүй (зөвхөн харах). Үлдэгдлийг доороос тохируулна уу." />}

      <form onSubmit={save} data-testid="product-form" class="a-panel">
        <fieldset disabled={!canEdit || busy} class="a-grid">
          <legend class="a-h2">Үндсэн мэдээлэл</legend>
          <Field label="Брэнд"><input class="a-input" name="brand" required value={form.brand} onInput={set("brand")} list="a-brands" /></Field>
          <Field label="Нэр"><input class="a-input" name="name" required value={form.name} onInput={set("name")} /></Field>
          {isNew ? (
            <Field label="ID (хаягийн хэсэг)" hint={`Хоосон бол автоматаар: ${slugify(form.brand, form.name, form.concentration) || "brand-name"}. Давхардвал -2, -3 нэмнэ. Дараа нь өөрчлөгдөхгүй.`}>
              <input class="a-input a-mono" name="id" pattern="[a-z0-9][a-z0-9\-]{0,119}" value={form.id} placeholder={slugify(form.brand, form.name, form.concentration)} onInput={set("id")} />
            </Field>
          ) : (
            <Field label="ID"><input class="a-input a-mono" value={product!.id} readOnly /></Field>
          )}
          <Field label="Төрөл (концентраци)">
            <input class="a-input" name="concentration" list="a-conc" value={form.concentration} onInput={set("concentration")} />
            <datalist id="a-conc"><option value="EDP" /><option value="EDT" /><option value="Parfum" /><option value="Extrait" /><option value="Cologne" /></datalist>
          </Field>
          <Field label="Хүйс">
            <select class="a-input" name="gender" value={form.gender} onChange={set("gender")}>
              <option value="">—</option>
              {GENDERS.map((g) => <option value={g}>{GENDER[g]}</option>)}
            </select>
          </Field>
          <Field label="Үнэрийн бүл">
            <select class="a-input" name="family" value={form.family} onChange={set("family")}>
              <option value="">—</option>
              {Object.entries(FAMILIES).map(([k, v]) => <option value={k}>{v}</option>)}
              {form.family && !(form.family in FAMILIES) && <option value={form.family}>{form.family}</option>}
            </select>
          </Field>
          <Field label="Гарсан он"><input class="a-input" name="releaseYear" inputMode="numeric" value={form.releaseYear} onInput={set("releaseYear")} /></Field>
          <Field label="Эрэмбэ (sort)"><input class="a-input" name="sort" inputMode="numeric" value={form.sort} onInput={set("sort")} /></Field>
          <Chips label="Дээд ноот (top)" value={form.top} onChange={(v) => setForm({ ...form, top: v })} disabled={!canEdit} hint="Enter эсвэл таслалаар нэмнэ, × дарж хасна." />
          <Chips label="Зүрхэн ноот (heart)" value={form.heart} onChange={(v) => setForm({ ...form, heart: v })} disabled={!canEdit} />
          <Chips label="Суурь ноот (base)" value={form.base} onChange={(v) => setForm({ ...form, base: v })} disabled={!canEdit} />
          <Field label="Тайлбар (монгол)" wide><textarea class="a-input" name="descriptionMn" rows={4} value={form.descriptionMn} onInput={set("descriptionMn")} /></Field>
          <Field label="Тайлбар (англи)" wide><textarea class="a-input" name="descriptionEn" rows={4} value={form.descriptionEn} onInput={set("descriptionEn")} /></Field>
        </fieldset>

        <fieldset disabled={!canEdit || busy} class="a-grid">
          <legend class="a-h2">Харагдах байдал ба худалдаа</legend>
          <div class="a-field a-field--wide" role="radiogroup" aria-label="Барааны төлөв">
            <span class="a-field__label">Барааны төлөв — <b>бараа нуухыг</b> энд сонгоно</span>
            <div class="a-row">
              {PRODUCT_STATUSES.map((s) => (
                <label class="a-check"><input type="radio" name="status" value={s} checked={form.status === s} onChange={set("status")} /> {PRODUCT_STATUS[s]}</label>
              ))}
            </div>
            <span class="a-field__hint">Ноорог/Нуусан бараа дэлгүүрт харагдахгүй, худалдаалагдахгүй.</span>
          </div>
          <label class="a-check a-field--wide">
            <input type="checkbox" name="saleLocked" checked={form.saleLocked} onChange={set("saleLocked")} data-testid="sale-lock" />
            <span><b>Худалдаа түгжих</b> — бараа харагдана, гэхдээ худалдан авах боломжгүй.</span>
          </label>
        </fieldset>
        {isNew && canEdit && can("media.write") && (
          <fieldset class="a-grid" disabled={busy}>
            <legend class="a-h2">Зураг</legend>
            <div class="a-imgs a-field--wide">
              <PhotoPick side="front" label="Урд тал" file={pending.front} onFile={(b) => setPending({ ...pending, front: b })} onError={msg.err} />
              <PhotoPick side="back" label="Ар тал" file={pending.back} onFile={(b) => setPending({ ...pending, back: b })} onError={msg.err} />
            </div>
          </fieldset>
        )}
        {canEdit && (
          <div class="a-row">
            <button class="a-btn a-btn--primary" type="submit" disabled={busy} data-testid="save-product">{busy ? "Хадгалж байна…" : isNew ? "Бараа үүсгэх" : "Хадгалах"}</button>
          </div>
        )}
        {msg.node}
        <datalist id="a-brands">{brands.map((b) => <option value={b} />)}</datalist>
      </form>

      {!isNew && product && (
        <>
          <Images product={product} onProduct={applyProduct} />
          <Skus product={product} reload={load} />
          <Inventory product={product} reload={load} />
        </>
      )}
    </section>
  );
}

/* ---------------- images ---------------- */

const MAX_SIDE = 1600;

/** Shrinks a photo to at most 1600 px on its long side and re-encodes it as WebP (JPEG where WebP encoding is missing). */
export async function resizeImage(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const enc = (type: string, q: number) => new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, q));
  let out = await enc("image/webp", 0.86);
  if (!out || out.type !== "image/webp") out = await enc("image/jpeg", 0.88);
  if (!out) throw new Error("encode");
  return out;
}

/** Checks, resizes and uploads one photo to R2 (POST /api/admin/media). Does not change the product. */
async function uploadImage(productId: string, side: "front" | "back", blob: Blob): Promise<{ url: string } | { error: string }> {
  const fd = new FormData();
  fd.append("file", blob, `${side}.${blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : "jpg"}`);
  fd.append("productId", productId);
  fd.append("side", side);
  const res = await api<{ url: string }>("/api/admin/media", { method: "POST", form: fd });
  if (!res.ok || !res.data.url) return { error: res.error || "Серверийн хариунд зургийн хаяг алга." };
  return { url: res.data.url };
}

/** File -> resized blob, or a readable error. */
export async function prepare(file: File): Promise<Blob | string> {
  if (!IMAGE_TYPES.includes(file.type)) return "Зөвхөн JPEG, PNG, WebP зураг оруулна уу.";
  if (file.size > 25 * 1024 * 1024) return "Зураг хэт том байна (25 MB хүртэл).";
  let blob: Blob;
  try { blob = await resizeImage(file); } catch { blob = file; }
  if (blob.size > MAX_IMAGE) return "Багасгасны дараа ч 5 MB-аас том байна. Өөр зураг сонгоно уу.";
  return blob;
}

/** Drop zone + file picker with a preview. `onFiles` gets the first accepted file. */
export function DropZone({ label, src, disabled, onFile, testid }: { label: string; src: string | null; disabled?: boolean; onFile: (f: File) => void; testid: string }) {
  const [over, setOver] = useState(false);
  return (
    <label
      class="a-drop" data-over={over ? "" : undefined}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer?.files?.[0]; if (f && !disabled) onFile(f); }}
    >
      {src ? <img src={src} alt={`${label} зураг`} data-testid={`preview-${testid}`} /> : (
        <span class="a-drop__empty"><b>{label}</b><span>Зургаа энд чирж оруулна уу, эсвэл дарж сонгоно уу</span><span>JPEG / PNG / WebP · 1600 px хүртэл багасгаж WebP болгоно</span></span>
      )}
      <input type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled} aria-label={`${label} зураг сонгох`} data-testid={`upload-${testid}`}
        onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) onFile(f); }} />
    </label>
  );
}

/** Photo picker for a product that does not exist yet (uploaded right after it is created). */
function PhotoPick({ side, label, file, onFile, onError }: { side: "front" | "back"; label: string; file?: Blob; onFile: (b?: Blob) => void; onError: (t: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setUrl(null); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <div class="a-imgside" data-side={side}>
      <h3 class="a-h3">{label}</h3>
      <DropZone label={label} src={url} testid={side} onFile={async (f) => { const b = await prepare(f); if (typeof b === "string") onError(b); else onFile(b); }} />
      {file && <p class="a-small a-dim">{Math.round(file.size / 1024)} KB · бараа үүсэхэд оруулагдана. <button type="button" class="a-btn a-btn--sm a-btn--ghost" onClick={() => onFile(undefined)}>Болих</button></p>}
    </div>
  );
}

function Images({ product, onProduct }: { product: AdminProduct; onProduct: (d: any) => Promise<void> }) {
  return (
    <section class="a-panel" aria-labelledby="img-h">
      <h2 id="img-h" class="a-h2">Зураг</h2>
      <p class="a-dim a-small" style="margin-top:-6px">Дэлгүүрт урд талын зураг үндсэн болно. Ар талын зураг хулганаа авчрахад болон хоёр дахь слайдад харагдана.</p>
      <div class="a-imgs">
        <ImageSide product={product} side="front" label="Урд тал" onProduct={onProduct} />
        <ImageSide product={product} side="back" label="Ар тал" onProduct={onProduct} />
      </div>
    </section>
  );
}

function ImageSide({ product, side, label, onProduct }: { product: AdminProduct; side: "front" | "back"; label: string; onProduct: (d: any) => Promise<void> }) {
  const { can } = useSession();
  const field = side === "front" ? "imageFront" : "imageBack";
  const current = product[field];
  const canUpload = can("media.write") && can("catalog.write");
  const canPatch = can("catalog.write");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const msg = useMsg();

  async function patch(value: string | null) {
    const res = await api(`/api/admin/products/${enc(product.id)}`, { method: "PATCH", body: { [field]: value } });
    if (res.ok) { await onProduct(res.data); msg.ok(value ? "Зураг хадгалагдлаа." : "Зургийг хаслаа."); } else msg.err(res.error);
    return res.ok;
  }

  async function upload(file: File) {
    setBusy(true);
    msg.info("Зургийг багасгаж байна…");
    const blob = await prepare(file);
    if (typeof blob === "string") { setBusy(false); msg.err(blob); return; }
    msg.info(`Оруулж байна… (${Math.round(blob.size / 1024)} KB)`);
    const up = await uploadImage(product.id, side, blob);
    if ("error" in up) { setBusy(false); msg.err(up.error); return; }
    await patch(up.url);
    setBusy(false);
  }

  async function useUrl(e: Event) {
    e.preventDefault();
    const v = url.trim();
    if (!/^(https:\/\/|\/)/.test(v)) { msg.err("https:// эсвэл / -ээр эхэлсэн хаяг оруулна уу."); return; }
    setBusy(true);
    if (await patch(v)) setUrl("");
    setBusy(false);
  }

  return (
    <div class="a-imgside" data-side={side}>
      <h3 class="a-h3">{label}</h3>
      {canUpload ? <DropZone label={label} src={current} disabled={busy} testid={side} onFile={upload} /> : (
        <div class="a-preview">{current ? <img src={current} alt={`${label} зураг`} data-testid={`preview-${side}`} /> : <span class="a-dim">Зураг алга</span>}</div>
      )}
      {current && <p class="a-small a-mono a-break a-dim" style="margin:0">{current}</p>}
      {canPatch && (
        <>
          <form class="a-row" onSubmit={useUrl}>
            <label class="a-field a-grow">
              <span class="a-field__label">Эсвэл зургийн хаяг</span>
              <input class="a-input" type="url" inputMode="url" placeholder="https://…" value={url} onInput={(e) => setUrl(e.currentTarget.value)} disabled={busy} data-testid={`url-${side}`} />
            </label>
            <button class="a-btn" type="submit" disabled={busy || !url.trim()}>Хэрэглэх</button>
          </form>
          {current && <ConfirmButton label="Зургийг хасах" question="Энэ зургийг бараанаас хасах уу?" confirmLabel="Тийм, хасах" onConfirm={() => patch(null)} disabled={busy} danger />}
        </>
      )}
      {msg.node}
    </div>
  );
}
/* ---------------- SKUs ---------------- */

interface SkuForm { kind: string; price: string; compareAt: string; active: boolean }
const skuForm = (s: AdminSku): SkuForm => ({ kind: s.kind, price: s.price?.toString() ?? "", compareAt: s.compareAt?.toString() ?? "", active: s.active });

function skuBody(f: SkuForm): { value: { kind: string; price: number | null; compareAt: number | null; active: boolean } } | { error: string } {
  const price = intOrNull(f.price);
  const compareAt = intOrNull(f.compareAt);
  if (Number.isNaN(price) || (price !== null && price <= 0)) return { error: "Үнэ: эерэг бүхэл тоо (₮) эсвэл хоосон (= зарагдахгүй)." };
  if (Number.isNaN(compareAt) || (compareAt !== null && compareAt <= 0)) return { error: "Хуучин үнэ: эерэг бүхэл тоо эсвэл хоосон." };
  if (compareAt !== null && (price === null || compareAt <= price)) return { error: "Хуучин үнэ одоогийн үнээс их байх ёстой (үнэ хоосон бол хуучин үнэ ч хоосон)." };
  return { value: { kind: f.kind, price, compareAt, active: f.active } };
}

const NotForSale = () => <span class="a-badge" data-s="nosale" data-testid="not-for-sale">Зарагдахгүй — үнэ тавиагүй</span>;

function Skus({ product, reload }: { product: AdminProduct; reload: () => Promise<void> }) {
  const { can } = useSession();
  const canEdit = can("catalog.write");
  const msg = useMsg();
  const [adding, setAdding] = useState<SkuForm & { ml: string }>({ ml: "", kind: "decant", price: "", compareAt: "", active: true });
  const base = `/api/admin/products/${enc(product.id)}/skus/`;

  async function put(ml: number, f: SkuForm) {
    const b = skuBody(f);
    if ("error" in b) { msg.err(b.error); return false; }
    const res = await api(base + ml, { method: "PUT", body: b.value });
    if (!res.ok) { msg.err(res.error); return false; }
    msg.ok(`${ml} мл хадгалагдлаа${b.value.price === null ? " (үнэ хоосон = зарагдахгүй)" : ""}.`);
    await reload();
    return true;
  }
  async function del(ml: number) {
    const res = await api(base + ml, { method: "DELETE", conflict: "энэ хэмжээг захиалга нөөцөлсөн тул устгах боломжгүй. Оронд нь “Идэвхтэй”-г унтраана уу." });
    if (res.ok) { msg.ok(`${ml} мл устгагдлаа.`); await reload(); } else msg.err(res.error);
  }
  async function add(e: Event) {
    e.preventDefault();
    const ml = intOrNull(adding.ml);
    if (ml === null || Number.isNaN(ml) || ml <= 0 || ml > 1000) { msg.err("мл: 1–1000 бүхэл тоо."); return; }
    if (product.skus.some((s) => s.ml === ml)) { msg.err(`${ml} мл аль хэдийн байна.`); return; }
    if (await put(ml, adding)) setAdding({ ml: "", kind: adding.kind, price: "", compareAt: "", active: true });
  }

  return (
    <section class="a-panel" aria-labelledby="sku-h">
      <h2 id="sku-h" class="a-h2">Хэмжээ ба үнэ (SKU)</h2>
      <p class="a-dim a-small">Үнэ хоосон = <b>зарагдахгүй</b>. Үнэ ₮-өөр, бүхэл тоо.</p>
      <Table label="Хэмжээний хүснэгт" head={["мл", "Төрөл", "Үнэ ₮", "Хуучин үнэ ₮", "Идэвхтэй", ""]}>
        {product.skus.map((s) => <SkuRow key={`${s.id}:${s.updatedAt}:${s.price}`} sku={s} canEdit={canEdit} onSave={(f) => put(s.ml, f)} onDelete={() => del(s.ml)} />)}
      </Table>
      {!product.skus.length && <p class="a-dim">Хэмжээ алга.</p>}
      {canEdit && (
        <form class="a-addsku" onSubmit={add} data-testid="add-sku">
          <h3 class="a-h3">Хэмжээ нэмэх</h3>
          <Field label="мл"><input class="a-input" inputMode="numeric" name="ml" value={adding.ml} onInput={(e) => setAdding({ ...adding, ml: e.currentTarget.value })} /></Field>
          <Field label="Төрөл">
            <select class="a-input" value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.currentTarget.value })}>
              {SKU_KINDS.map((k) => <option value={k}>{SKU_KIND[k]}</option>)}
            </select>
          </Field>
          <Field label="Үнэ ₮ (хоосон = зарагдахгүй)"><input class="a-input" inputMode="numeric" name="price" value={adding.price} onInput={(e) => setAdding({ ...adding, price: e.currentTarget.value })} /></Field>
          <Field label="Хуучин үнэ ₮"><input class="a-input" inputMode="numeric" value={adding.compareAt} onInput={(e) => setAdding({ ...adding, compareAt: e.currentTarget.value })} /></Field>
          <label class="a-check"><input type="checkbox" checked={adding.active} onChange={(e) => setAdding({ ...adding, active: e.currentTarget.checked })} /> Идэвхтэй</label>
          <button class="a-btn" type="submit">Нэмэх</button>
        </form>
      )}
      {msg.node}
    </section>
  );
}

function SkuRow({ sku, canEdit, onSave, onDelete }: { sku: AdminSku; canEdit: boolean; onSave: (f: SkuForm) => Promise<boolean>; onDelete: () => void }) {
  const [f, setF] = useState(skuForm(sku));
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(skuForm(sku));
  const noPrice = !f.price.trim();
  return (
    <tr data-sku={sku.id}>
      <td class="a-mono"><b>{sku.ml}</b></td>
      <td>
        <select class="a-input a-input--sm" aria-label={`${sku.ml} мл төрөл`} disabled={!canEdit} value={f.kind} onChange={(e) => setF({ ...f, kind: e.currentTarget.value })}>
          {SKU_KINDS.map((k) => <option value={k}>{SKU_KIND[k]}</option>)}
        </select>
      </td>
      <td>
        <input class="a-input a-input--sm" inputMode="numeric" aria-label={`${sku.ml} мл үнэ`} data-field="price" disabled={!canEdit} value={f.price} onInput={(e) => setF({ ...f, price: e.currentTarget.value })} />
        {noPrice && <div><NotForSale /></div>}
        {!noPrice && !dirty && <div class="a-small a-dim">{money(sku.price)}</div>}
      </td>
      <td><input class="a-input a-input--sm" inputMode="numeric" aria-label={`${sku.ml} мл хуучин үнэ`} disabled={!canEdit} value={f.compareAt} onInput={(e) => setF({ ...f, compareAt: e.currentTarget.value })} /></td>
      <td><input type="checkbox" aria-label={`${sku.ml} мл идэвхтэй`} disabled={!canEdit} checked={f.active} onChange={(e) => setF({ ...f, active: e.currentTarget.checked })} /></td>
      <td>
        {canEdit && (
          <div class="a-row a-row--tight">
            <button type="button" class="a-btn a-btn--sm" data-action="save-sku" disabled={busy || !dirty} onClick={async () => { setBusy(true); await onSave(f); setBusy(false); }}>Хадгалах</button>
            <ConfirmButton label="Устгах" question={`${sku.ml} мл устгах уу?`} confirmLabel="Тийм" danger onConfirm={onDelete} disabled={busy} />
          </div>
        )}
      </td>
    </tr>
  );
}

/* ---------------- inventory ---------------- */

function Inventory({ product, reload }: { product: AdminProduct; reload: () => Promise<void> }) {
  const { can } = useSession();
  const canAdjust = can("inventory.write");
  const msg = useMsg();
  const [adj, setAdj] = useState({ sku: product.skus[0]?.id ?? "", mode: (product.skus[0]?.stock === null ? "set" : "delta") as "set" | "delta", value: "", reason: "restock", note: "" });
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState<{ sku: string; items: any[] | null; error: string } | null>(null);
  const selected = product.skus.find((s) => s.id === adj.sku);
  // untracked SKUs (stock null) only accept "set"
  const pickSku = (id: string) => setAdj({ ...adj, sku: id, mode: product.skus.find((s) => s.id === id)?.stock === null ? "set" : adj.mode });

  async function submit(e: Event) {
    e.preventDefault();
    const n = intOrNull(adj.value);
    if (n === null || Number.isNaN(n)) { msg.err("Тоо оруулна уу."); return; }
    if (adj.mode === "set" && n < 0) { msg.err("Үлдэгдэл 0-ээс бага байж болохгүй."); return; }
    if (adj.mode === "delta" && n === 0) { msg.err("Өөрчлөлт 0 байж болохгүй."); return; }
    if (adj.mode === "delta" && selected?.stock === null) { msg.err("Энэ хэмжээ тоолдоггүй: эхлээд “Тоог тогтоох (=)” сонгож тоо оруулна уу."); return; }
    const body: Record<string, unknown> = { sku: adj.sku, [adj.mode]: n, reason: adj.reason };
    if (adj.note.trim()) body.note = adj.note.trim();
    setBusy(true);
    const res = await api("/api/admin/inventory/adjust", { method: "POST", body, conflict: "үлдэгдэл нөөцлөгдсөн тооноос бага болох гэж байна, эсвэл тоолдоггүй хэмжээнд ± хийх гэж байна." });
    setBusy(false);
    if (res.ok) {
      msg.ok("Үлдэгдэл шинэчлэгдлээ.");
      setAdj({ ...adj, value: "", note: "" });
      await reload();
      if (hist?.sku === adj.sku) showHistory(adj.sku);
    } else msg.err(res.error);
  }

  async function showHistory(sku: string) {
    setHist({ sku, items: null, error: "" });
    const res = await api(`/api/admin/inventory/${enc(sku)}/movements`);
    setHist({ sku, items: res.ok ? rows(res.data, "movements") : [], error: res.error });
  }

  return (
    <section class="a-panel" aria-labelledby="inv-h">
      <h2 id="inv-h" class="a-h2">Үлдэгдэл</h2>
      <Table label="Үлдэгдлийн хүснэгт" head={["SKU", "Үлдэгдэл", "Нөөцлөгдсөн", "Боломжит", ""]}>
        {product.skus.map((s) => (
          <tr data-inv={s.id}>
            <td class="a-mono">{s.ml} мл</td>
            <td class="a-mono">{s.stock === null ? <span class="a-dim">тоолдоггүй</span> : num(s.stock)}</td>
            <td class="a-mono">{num(s.reserved)}</td>
            <td class="a-mono">{s.available === null ? "∞" : <b class={s.available === 0 ? "a-warn" : ""}>{num(s.available)}</b>}</td>
            <td><button type="button" class="a-btn a-btn--sm" aria-expanded={hist?.sku === s.id} onClick={() => (hist?.sku === s.id ? setHist(null) : showHistory(s.id))}>Түүх</button></td>
          </tr>
        ))}
      </Table>

      {hist && (
        <div class="a-sub" data-testid="movements">
          <h3 class="a-h3">Хөдөлгөөний түүх — <span class="a-mono">{hist.sku}</span></h3>
          <Msg kind="err" text={hist.error} />
          <Loading on={hist.items === null} />
          {hist.items && (hist.items.length ? (
            <Table label="Хөдөлгөөний түүх" head={["Огноо", "Өөрчлөлт", "Шалтгаан", "Хэн", "Захиалга", "Тэмдэглэл"]}>
              {hist.items.map((m) => {
                const d = pick(m, "delta") as number;
                const order = pick(m, "orderNo", "order_no", "orderId", "order_id");
                return (
                  <tr>
                    <td class="a-mono">{when(pick(m, "at"))}</td>
                    <td class="a-mono">{d > 0 ? `+${d}` : d}</td>
                    <td>{STOCK_REASON[pick(m, "reason")] ?? pick(m, "reason")}</td>
                    <td class="a-small">{pick(m, "actor")}</td>
                    <td class="a-mono">{order ?? "—"}</td>
                    <td class="a-small">{pick(m, "note") ?? ""}</td>
                  </tr>
                );
              })}
            </Table>
          ) : <p class="a-dim">Хөдөлгөөн алга.</p>)}
        </div>
      )}

      {canAdjust && product.skus.length > 0 && (
        <form class="a-addsku" onSubmit={submit} data-testid="adjust-form">
          <h3 class="a-h3">Үлдэгдэл тохируулах</h3>
          <Field label="Хэмжээ">
            <select class="a-input" name="sku" value={adj.sku} onChange={(e) => pickSku(e.currentTarget.value)}>
              {product.skus.map((s) => <option value={s.id}>{s.ml} мл</option>)}
            </select>
          </Field>
          <Field label="Арга">
            <select class="a-input" name="mode" value={adj.mode} onChange={(e) => setAdj({ ...adj, mode: e.currentTarget.value as "set" | "delta" })}>
              <option value="delta" disabled={selected?.stock === null}>Нэмэх / хасах (±)</option>
              <option value="set">Тоог тогтоох (=)</option>
            </select>
          </Field>
          <Field label={adj.mode === "set" ? "Шинэ үлдэгдэл" : "Өөрчлөлт (ж: 5 эсвэл -2)"} hint={selected?.stock === null ? "Тоолдоггүй: тоо тогтоовол тоолж эхэлнэ." : undefined}>
            <input class="a-input" name="value" inputMode="numeric" value={adj.value} onInput={(e) => setAdj({ ...adj, value: e.currentTarget.value })} required />
          </Field>
          <Field label="Шалтгаан">
            <select class="a-input" name="reason" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.currentTarget.value })}>
              <option value="restock">{STOCK_REASON.restock}</option>
              <option value="correction">{STOCK_REASON.correction}</option>
            </select>
          </Field>
          <Field label="Тэмдэглэл (заавал биш)"><input class="a-input" name="note" maxLength={300} value={adj.note} onInput={(e) => setAdj({ ...adj, note: e.currentTarget.value })} /></Field>
          <button class="a-btn a-btn--primary" type="submit" disabled={busy}>Хадгалах</button>
        </form>
      )}
      {msg.node}
    </section>
  );
}

