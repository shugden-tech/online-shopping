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
  top: string; heart: string; base: string; descriptionMn: string; descriptionEn: string;
  status: string; saleLocked: boolean; sort: string;
}

const toForm = (p: AdminProduct | null): Form => ({
  id: p?.id ?? "", brand: p?.brand ?? "", name: p?.name ?? "", concentration: p?.concentration ?? "",
  gender: p?.gender ?? "", family: p?.family ?? "", releaseYear: p?.releaseYear?.toString() ?? "",
  top: p?.notes.top.join(", ") ?? "", heart: p?.notes.heart.join(", ") ?? "", base: p?.notes.base.join(", ") ?? "",
  descriptionMn: p?.descriptionMn ?? "", descriptionEn: p?.descriptionEn ?? "",
  status: p?.status ?? "draft", saleLocked: p?.saleLocked ?? false, sort: String(p?.sort ?? 0),
});

const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const orNull = (s: string) => (s.trim() ? s.trim() : null);

/** Form -> AdminProduct-shaped editable fields, or an error message. */
function fromForm(f: Form): { value: Record<string, unknown> } | { error: string } {
  const year = intOrNull(f.releaseYear);
  if (Number.isNaN(year) || (year !== null && (year < 1700 || year > 2100))) return { error: "Он: 1700–2100 хооронд бүхэл тоо эсвэл хоосон." };
  const sort = intOrNull(f.sort);
  if (Number.isNaN(sort)) return { error: "Эрэмбэ: бүхэл тоо." };
  if (!f.brand.trim() || !f.name.trim()) return { error: "Брэнд ба нэр заавал бөглөнө." };
  return {
    value: {
      brand: f.brand.trim(), name: f.name.trim(), concentration: orNull(f.concentration), gender: f.gender || null,
      family: orNull(f.family), releaseYear: year, notes: { top: list(f.top), heart: list(f.heart), base: list(f.base) },
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
      if (!PRODUCT_ID_RE.test(form.id)) { setBusy(false); msg.err("ID: зөвхөн жижиг латин үсэг, тоо, зураас (a-z, 0-9, -), 120 тэмдэгт хүртэл."); return; }
      const res = await api("/api/admin/products", { method: "POST", body: { id: form.id, ...v.value }, conflict: "ийм ID-тай бараа аль хэдийн байна." });
      setBusy(false);
      if (res.ok) go(`#/products/${enc(form.id)}`);
      else msg.err(res.error);
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
        {!isNew && can("audit.read") && <a href={`#/audit?entity=product&entityId=${enc(id)}`}>Үйлдлийн түүх</a>}
      </div>
      {!canEdit && <Msg kind="info" text="Таны эрхээр барааны мэдээлэл засах боломжгүй (зөвхөн харах). Үлдэгдэл тохируулах эрх байвал доор хийнэ." />}

      <form onSubmit={save} data-testid="product-form" class="a-panel">
        <fieldset disabled={!canEdit || busy} class="a-grid">
          <legend class="a-h2">Үндсэн мэдээлэл</legend>
          {isNew ? (
            <Field label="ID (URL slug)" hint="ж: mugler-alien-edp — дараа нь өөрчлөгдөхгүй">
              <input class="a-input a-mono" name="id" required pattern="[a-z0-9][a-z0-9\-]{0,119}" value={form.id} onInput={set("id")} />
            </Field>
          ) : (
            <Field label="ID"><input class="a-input a-mono" value={product!.id} readOnly /></Field>
          )}
          <Field label="Брэнд"><input class="a-input" name="brand" required value={form.brand} onInput={set("brand")} /></Field>
          <Field label="Нэр"><input class="a-input" name="name" required value={form.name} onInput={set("name")} /></Field>
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
          <Field label="Үнэрийн бүл (family)"><input class="a-input" name="family" value={form.family} onInput={set("family")} /></Field>
          <Field label="Гарсан он"><input class="a-input" name="releaseYear" inputMode="numeric" value={form.releaseYear} onInput={set("releaseYear")} /></Field>
          <Field label="Эрэмбэ (sort)"><input class="a-input" name="sort" inputMode="numeric" value={form.sort} onInput={set("sort")} /></Field>
          <Field label="Дээд нот (top)" hint="Таслалаар тусгаарлана" wide><input class="a-input" name="top" value={form.top} onInput={set("top")} /></Field>
          <Field label="Зүрхэн нот (heart)" wide><input class="a-input" name="heart" value={form.heart} onInput={set("heart")} /></Field>
          <Field label="Суурь нот (base)" wide><input class="a-input" name="base" value={form.base} onInput={set("base")} /></Field>
          <Field label="Тайлбар (монгол)" wide><textarea class="a-input" name="descriptionMn" rows={4} value={form.descriptionMn} onInput={set("descriptionMn")} /></Field>
          <Field label="Тайлбар (англи)" wide><textarea class="a-input" name="descriptionEn" rows={4} value={form.descriptionEn} onInput={set("descriptionEn")} /></Field>
        </fieldset>

        <fieldset disabled={!canEdit || busy} class="a-grid">
          <legend class="a-h2">Харагдах байдал ба худалдаа</legend>
          <div class="a-field a-field--wide" role="radiogroup" aria-label="Барааны төлөв">
            <span class="a-field__label">Барааны төлөв — <b>бараа нуух</b> энд</span>
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
        {canEdit && (
          <div class="a-row">
            <button class="a-btn a-btn--primary" type="submit" disabled={busy} data-testid="save-product">{busy ? "Хадгалж байна…" : isNew ? "Бараа үүсгэх" : "Хадгалах"}</button>
          </div>
        )}
        {msg.node}
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

function Images({ product, onProduct }: { product: AdminProduct; onProduct: (d: any) => Promise<void> }) {
  return (
    <section class="a-panel" aria-labelledby="img-h">
      <h2 id="img-h" class="a-h2">Зураг</h2>
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
    if (res.ok) { await onProduct(res.data); msg.ok(value ? "Зураг хадгалагдлаа." : "Зураг устгагдлаа."); } else msg.err(res.error);
    return res.ok;
  }

  async function upload(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) { msg.err("Зөвхөн JPEG, PNG, WebP зураг."); input.value = ""; return; }
    if (file.size > MAX_IMAGE) { msg.err("Зураг 5 MB-аас ихгүй байх ёстой."); input.value = ""; return; }
    setBusy(true);
    msg.info("Хуулж байна…");
    const fd = new FormData();
    fd.append("file", file);
    fd.append("productId", product.id);
    fd.append("side", side);
    const res = await api<{ url: string }>("/api/admin/media", { method: "POST", form: fd });
    if (!res.ok || !res.data.url) { setBusy(false); msg.err(res.error || "Хариунд url алга."); input.value = ""; return; }
    await patch(res.data.url);
    setBusy(false);
    input.value = "";
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
      <div class="a-preview">
        {current ? <img src={current} alt={`${label} зураг`} data-testid={`preview-${side}`} /> : <span class="a-dim">Зураг алга</span>}
      </div>
      {current && <p class="a-small a-mono a-break">{current}</p>}
      {canPatch ? (
        <>
          {canUpload && (
            <label class="a-field">
              <span class="a-field__label">Файл хуулах (JPEG/PNG/WebP, ≤ 5 MB)</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={upload} data-testid={`upload-${side}`} />
            </label>
          )}
          <form class="a-row" onSubmit={useUrl}>
            <label class="a-field a-grow">
              <span class="a-field__label">Эсвэл зургийн хаяг буулгах</span>
              <input class="a-input" type="url" inputMode="url" placeholder="https://…" value={url} onInput={(e) => setUrl(e.currentTarget.value)} disabled={busy} data-testid={`url-${side}`} />
            </label>
            <button class="a-btn" type="submit" disabled={busy || !url.trim()}>Хэрэглэх</button>
          </form>
          {current && <ConfirmButton label="Зураг авах" question="Зургийг устгах уу?" confirmLabel="Тийм, устгах" onConfirm={() => patch(null)} disabled={busy} />}
        </>
      ) : null}
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
  if (compareAt !== null && (price === null || compareAt <= price)) return { error: "Хуучин үнэ (compare-at) одоогийн үнээс их байх ёстой (үнэгүй бол хоосон)." };
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
    msg.ok(`${ml} мл хадгалагдлаа${b.value.price === null ? " (үнэгүй = зарагдахгүй)" : ""}.`);
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
      <Table label="SKU хүснэгт" head={["мл", "Төрөл", "Үнэ ₮", "Хуучин үнэ ₮", "Идэвхтэй", ""]}>
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
    if (adj.mode === "delta" && selected?.stock === null) { msg.err("Энэ хэмжээний үлдэгдэл хянагддаггүй: “Тоог тогтоох (=)” сонгож эхлээд тоо оруулна уу."); return; }
    const body: Record<string, unknown> = { sku: adj.sku, [adj.mode]: n, reason: adj.reason };
    if (adj.note.trim()) body.note = adj.note.trim();
    setBusy(true);
    const res = await api("/api/admin/inventory/adjust", { method: "POST", body, conflict: "үлдэгдэл захиалгад нөөцлөгдсөн тооноос доош орох гэж байна, эсвэл хянагддаггүй SKU-д ± хийх гэж байна." });
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
            <td class="a-mono">{s.stock === null ? <span class="a-dim">хянахгүй</span> : num(s.stock)}</td>
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
          <Field label={adj.mode === "set" ? "Шинэ үлдэгдэл" : "Өөрчлөлт (ж: 5 эсвэл -2)"} hint={selected?.stock === null ? "Хянагддаггүй: тоо тогтоовол хянаж эхэлнэ." : undefined}>
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

