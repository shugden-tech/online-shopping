// Bundle editor (0005): names, descriptions, price / compare-at, status, sort, picture (upload or URL) and the
// parts (product sizes picked with a search). Delete asks first. Every save is audit-logged by the server.
import { useEffect, useState } from "preact/hooks";
import { PRODUCT_STATUSES, type AdminProduct } from "../../lib/contracts";
import { BUNDLE_ID_RE, type BundleView } from "../../lib/bundles/types";
import { api, enc, qs } from "../api";
import { PRODUCT_STATUS, money } from "../labels";
import { ConfirmButton, Field, Loading, Msg, go, intOrNull, useMsg, useSession } from "../ui";
import { DropZone, prepare, slugify } from "./ProductEdit";
import { BLOCK, partTitle } from "./Bundles";
import { Icon } from "../icons";

interface Part { sku: string; qty: number; label: string | null; title: string }
interface Form {
  id: string; nameMn: string; nameEn: string; descriptionMn: string; descriptionEn: string;
  price: string; compareAt: string; status: string; sort: string; image: string; parts: Part[];
}

const toForm = (b: BundleView | null): Form => ({
  id: b?.id ?? "", nameMn: b?.nameMn ?? "", nameEn: b?.nameEn ?? "", descriptionMn: b?.descriptionMn ?? "", descriptionEn: b?.descriptionEn ?? "",
  price: b?.price?.toString() ?? "", compareAt: b?.compareAt?.toString() ?? "", status: b?.status ?? "draft", sort: String(b?.sort ?? 0),
  image: b?.image ?? "",
  parts: (b?.parts ?? []).map((p) => ({ sku: p.sku, qty: p.qty, label: p.label, title: partTitle(p) })),
});
const orNull = (s: string) => (s.trim() ? s.trim() : null);

function fromForm(f: Form): { value: Record<string, unknown> } | { error: string } {
  if (!f.nameMn.trim()) return { error: "Монгол нэрийг заавал бөглөнө үү." };
  const price = intOrNull(f.price), compareAt = intOrNull(f.compareAt), sort = intOrNull(f.sort);
  if (Number.isNaN(price) || (price !== null && price <= 0)) return { error: "Үнэ: эерэг бүхэл тоо (₮) эсвэл хоосон (худалдаалахгүй)." };
  if (Number.isNaN(compareAt) || (compareAt !== null && compareAt <= 0)) return { error: "Хуучин үнэ: эерэг бүхэл тоо эсвэл хоосон." };
  if (compareAt !== null && price !== null && compareAt <= price) return { error: "Хуучин үнэ одоогийн үнээс их байх ёстой." };
  if (Number.isNaN(sort)) return { error: "Эрэмбэ: бүхэл тоо." };
  if (!f.parts.length) return { error: "Багцад дор хаяж нэг бараа нэмнэ үү." };
  if (f.image && !/^(https:\/\/|\/)/.test(f.image.trim())) return { error: "Зургийн хаяг https:// эсвэл / тэмдэгтээр эхлэх ёстой." };
  return {
    value: {
      nameMn: f.nameMn.trim(), nameEn: orNull(f.nameEn), descriptionMn: orNull(f.descriptionMn), descriptionEn: orNull(f.descriptionEn),
      price, compareAt, status: f.status, sort: sort ?? 0, image: orNull(f.image),
      items: f.parts.map((p) => ({ sku: p.sku, qty: p.qty, label: p.label ?? p.title })),
    },
  };
}

async function uploadBundleImage(id: string, blob: Blob): Promise<{ url: string } | { error: string }> {
  const fd = new FormData();
  fd.append("file", blob, `front.${blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : "jpg"}`);
  fd.append("bundleId", id);
  fd.append("side", "front");
  const res = await api<{ url: string }>("/api/admin/media", { method: "POST", form: fd });
  if (!res.ok || !res.data.url) return { error: res.error || "Серверийн хариунд зургийн хаяг алга." };
  return { url: res.data.url };
}

export default function BundleEdit({ id }: { id: string }) {
  const { can } = useSession();
  const isNew = !id;
  const canEdit = can("catalog.write");
  const canUpload = canEdit && can("media.write");
  const [bundle, setBundle] = useState<BundleView | null>(null);
  const [form, setForm] = useState<Form>(toForm(null));
  const [loading, setLoading] = useState(!isNew);
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const msg = useMsg();

  async function load() {
    const res = await api<{ bundle: BundleView }>(`/api/admin/bundles/${enc(id)}`);
    setLoading(false);
    if (!res.ok) { setLoadErr(res.error); return; }
    setBundle(res.data.bundle);
    setForm(toForm(res.data.bundle));
  }
  useEffect(() => { if (!isNew) load(); }, [id]);
  useEffect(() => {
    if (!pending) { setPreview(null); return; }
    const u = URL.createObjectURL(pending);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [pending]);

  const set = <K extends keyof Form>(k: K) => (e: Event) => setForm({ ...form, [k]: (e.currentTarget as HTMLInputElement).value });

  async function save(e: Event) {
    e.preventDefault();
    if (!canEdit) return;
    const v = fromForm(form);
    if ("error" in v) { msg.err(v.error); return; }
    setBusy(true);
    if (isNew) {
      const newId = form.id.trim() || slugify(form.nameEn || form.nameMn).slice(0, 80).replace(/-+$/, "");
      if (!BUNDLE_ID_RE.test(newId)) { setBusy(false); msg.err("ID: зөвхөн жижиг латин үсэг, тоо, зураас (a-z, 0-9, -), 80 тэмдэгт хүртэл."); return; }
      const res = await api<{ bundle: BundleView }>("/api/admin/bundles", { method: "POST", body: { id: newId, ...v.value }, conflict: "Ийм ID-тай багц аль хэдийн байна." });
      if (!res.ok) { setBusy(false); msg.err(res.error); return; }
      if (pending) {
        msg.info("Зургийг оруулж байна…");
        const up = await uploadBundleImage(newId, pending);
        if ("error" in up) msg.err(up.error);
        else await api(`/api/admin/bundles/${enc(newId)}`, { method: "PATCH", body: { image: up.url } });
      }
      setBusy(false);
      go(`#/bundles/${enc(newId)}`);
      return;
    }
    const before = fromForm(toForm(bundle));
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v.value)) {
      const old = "value" in before ? before.value[k] : undefined;
      if (JSON.stringify(val) !== JSON.stringify(old)) patch[k] = val;
    }
    if (!Object.keys(patch).length) { setBusy(false); msg.info("Өөрчлөлт алга."); return; }
    const res = await api<{ bundle: BundleView }>(`/api/admin/bundles/${enc(id)}`, { method: "PATCH", body: patch });
    setBusy(false);
    if (res.ok) { setBundle(res.data.bundle); setForm(toForm(res.data.bundle)); msg.ok("Хадгаллаа."); } else msg.err(res.error);
  }

  async function uploadNow(file: File) {
    const blob = await prepare(file);
    if (typeof blob === "string") { msg.err(blob); return; }
    if (isNew) { setPending(blob); return; }
    setBusy(true);
    msg.info(`Оруулж байна… (${Math.round(blob.size / 1024)} KB)`);
    const up = await uploadBundleImage(id, blob);
    if ("error" in up) { setBusy(false); msg.err(up.error); return; }
    const res = await api<{ bundle: BundleView }>(`/api/admin/bundles/${enc(id)}`, { method: "PATCH", body: { image: up.url } });
    setBusy(false);
    if (res.ok) { setBundle(res.data.bundle); setForm({ ...form, image: res.data.bundle.image ?? "" }); msg.ok("Зураг хадгалагдлаа."); } else msg.err(res.error);
  }

  async function remove() {
    setBusy(true);
    const res = await api(`/api/admin/bundles/${enc(id)}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) go("#/bundles"); else msg.err(res.error);
  }

  const movePart = (i: number, d: -1 | 1) => {
    const parts = [...form.parts];
    const j = i + d;
    if (j < 0 || j >= parts.length) return;
    [parts[i], parts[j]] = [parts[j]!, parts[i]!];
    setForm({ ...form, parts });
  };

  if (loading) return <Loading on />;
  if (loadErr) return <><p><a href="#/bundles"><Icon name="back" />Багц</a></p><Msg kind="err" text={loadErr} /></>;

  const info = new Map((bundle?.parts ?? []).map((p) => [p.sku, p]));
  const imgSrc = preview ?? (form.image || null);

  return (
    <section aria-labelledby="be-h" class="a-stack">
      <p><a href="#/bundles"><Icon name="back" />Багц</a></p>
      <div class="a-row a-row--between">
        <h1 id="be-h" class="a-title">{isNew ? "Шинэ багц" : bundle!.nameMn}</h1>
        {!isNew && (
          <div class="a-row">
            {bundle!.status === "active" && <a class="a-btn a-btn--sm" href={`/bundles/${enc(id)}/`} target="_blank" rel="noopener" data-testid="view-bundle">Дэлгүүрт харах<Icon name="external" /></a>}
            {can("audit.read") && <a class="a-btn a-btn--sm a-btn--ghost" href={`#/audit?entity=bundle&entityId=${enc(id)}`}><Icon name="audit" />Түүх</a>}
          </div>
        )}
      </div>
      {!canEdit && <Msg kind="info" text="Таны эрхээр багц засах боломжгүй (зөвхөн харах)." />}
      {bundle && (
        <p class="a-small" data-testid="bundle-state">
          {bundle.sellable
            ? <span class="a-badge" data-s="active">Дэлгүүрт зарагдаж байна{bundle.available !== null ? ` · ${bundle.available} багц хүртэл` : ""}</span>
            : <span class="a-badge" data-s="nosale">{BLOCK[bundle.block ?? "off"]}</span>}
          {bundle.separateTotal !== null && bundle.price !== null && <span class="a-dim"> · Тус тусад нь: {money(bundle.separateTotal)}</span>}
        </p>
      )}

      <form onSubmit={save} class="a-panel" data-testid="bundle-form">
        <fieldset disabled={!canEdit || busy} class="a-grid">
          <legend class="a-h2">Үндсэн мэдээлэл</legend>
          <Field label="Нэр (монгол)"><input class="a-input" name="nameMn" required maxLength={120} value={form.nameMn} onInput={set("nameMn")} /></Field>
          <Field label="Нэр (англи)"><input class="a-input" name="nameEn" maxLength={120} value={form.nameEn} onInput={set("nameEn")} /></Field>
          {isNew ? (
            <Field label="ID (хаягийн хэсэг)" hint={`Хоосон бол автоматаар: ${slugify(form.nameEn || form.nameMn) || "bundle-name"}. Дараа нь өөрчлөгдөхгүй.`}>
              <input class="a-input a-mono" name="id" pattern="[a-z0-9][a-z0-9\-]{0,79}" value={form.id} placeholder={slugify(form.nameEn || form.nameMn)} onInput={set("id")} />
            </Field>
          ) : (
            <Field label="ID"><input class="a-input a-mono" value={bundle!.id} readOnly /></Field>
          )}
          <Field label="Эрэмбэ" hint="Бага тоотой нь түрүүнд харагдана."><input class="a-input" name="sort" inputMode="numeric" value={form.sort} onInput={set("sort")} /></Field>
          <Field label="Үнэ (₮)" hint="Хоосон бол худалдаалахгүй."><input class="a-input" name="price" inputMode="numeric" value={form.price} onInput={set("price")} data-testid="bundle-price" /></Field>
          <Field label="Хуучин үнэ (₮, заавал биш)" hint="Зураастай харагдана. Одоогийн үнээс их байх ёстой."><input class="a-input" name="compareAt" inputMode="numeric" value={form.compareAt} onInput={set("compareAt")} /></Field>
          <Field label="Тайлбар (монгол)" wide><textarea class="a-input" name="descriptionMn" rows={3} value={form.descriptionMn} onInput={set("descriptionMn")} /></Field>
          <Field label="Тайлбар (англи)" wide><textarea class="a-input" name="descriptionEn" rows={3} value={form.descriptionEn} onInput={set("descriptionEn")} /></Field>
          <div class="a-field a-field--wide" role="radiogroup" aria-label="Багцын төлөв">
            <span class="a-field__label">Төлөв — багцыг <b>нуухыг</b> хүсвэл “Нуусан”-ыг сонгоно</span>
            <div class="a-row">
              {PRODUCT_STATUSES.map((s) => (
                <label class="a-check"><input type="radio" name="status" value={s} checked={form.status === s} onChange={set("status")} /> {PRODUCT_STATUS[s]}</label>
              ))}
            </div>
          </div>
        </fieldset>

        <fieldset disabled={!canEdit || busy} class="a-grid">
          <legend class="a-h2">Бүрэлдэхүүн</legend>
          <div class="a-field a-field--wide">
            {form.parts.length === 0 && <p class="a-dim a-small">Доорх хайлтаар бараа хайж, хэмжээг нь нэмнэ үү.</p>}
            <ol class="a-stack" style="padding-left:20px;margin:0" data-testid="bundle-parts">
              {form.parts.map((p, i) => {
                const s = info.get(p.sku);
                return (
                  <li data-sku={p.sku}>
                    <div class="a-row" style="flex-wrap:wrap;align-items:center">
                      <span class="a-grow"><b>{p.title}</b> <span class="a-dim a-mono a-small">{p.sku}</span></span>
                      <label class="a-small">Тоо <input class="a-input a-input--sm" style="width:60px" inputMode="numeric" value={p.qty} aria-label={`${p.title} тоо`}
                        onInput={(e) => { const n = Math.max(1, Math.min(10, Number(e.currentTarget.value) || 1)); setForm({ ...form, parts: form.parts.map((x, k) => (k === i ? { ...x, qty: n } : x)) }); }} /></label>
                      <button type="button" class="a-btn a-btn--sm a-btn--ghost" aria-label="Дээш" disabled={i === 0} onClick={() => movePart(i, -1)}><Icon name="up" /></button>
                      <button type="button" class="a-btn a-btn--sm a-btn--ghost" aria-label="Доош" disabled={i === form.parts.length - 1} onClick={() => movePart(i, 1)}><Icon name="down" /></button>
                      <button type="button" class="a-btn a-btn--sm" onClick={() => setForm({ ...form, parts: form.parts.filter((_, k) => k !== i) })}><Icon name="remove" />Хасах</button>
                    </div>
                    {s && (
                      <div class="a-small a-dim">
                        {s.productStatus === null ? "Каталогт ийм бараа алга." : !s.ok ? (s.productStatus !== "active" ? `Бараа ${PRODUCT_STATUS[s.productStatus] ?? s.productStatus} төлөвтэй — идэвхжүүлнэ үү.` : "Энэ хэмжээ идэвхгүй эсвэл үнэ тавиагүй.") : `Үнэ ${money(s.price)}${s.available !== null ? ` · ${s.available} багцад хүрэлцэнэ` : " · үлдэгдэл хянаагүй"}`}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
          {canEdit && <PartSearch onPick={(p) => form.parts.some((x) => x.sku === p.sku) ? msg.err("Энэ хэмжээ аль хэдийн нэмэгдсэн.") : setForm({ ...form, parts: [...form.parts, p] })} />}
        </fieldset>

        <fieldset disabled={busy} class="a-grid">
          <legend class="a-h2">Зураг</legend>
          <div class="a-imgside a-field--wide" data-side="front">
            {canUpload ? <DropZone label="Багцын зураг" src={imgSrc} disabled={busy} testid="bundle" onFile={uploadNow} /> : (
              <div class="a-preview">{imgSrc ? <img src={imgSrc} alt="Багцын зураг" /> : <span class="a-dim">Зураг алга</span>}</div>
            )}
            {isNew && pending && <p class="a-small a-dim">{Math.round(pending.size / 1024)} KB · багц үүсэхэд оруулагдана. <button type="button" class="a-btn a-btn--sm a-btn--ghost" onClick={() => setPending(null)}><Icon name="close" />Болих</button></p>}
            {canEdit && <Field label="Эсвэл зургийн хаяг" hint="https://… эсвэл /bundles/1.webp"><input class="a-input" name="image" value={form.image} onInput={set("image")} data-testid="bundle-image-url" /></Field>}
          </div>
        </fieldset>

        {canEdit && (
          <div class="a-row">
            <button class="a-btn a-btn--primary" type="submit" disabled={busy} data-testid="save-bundle">{busy ? "Хадгалж байна…" : isNew ? "Багц үүсгэх" : "Хадгалах"}</button>
            {!isNew && <ConfirmButton label="Устгах" question="Энэ багцыг бүр мөсөн устгах уу? (Өмнөх захиалгад нөлөөлөхгүй.)" confirmLabel="Тийм, устгах" onConfirm={remove} disabled={busy} danger testid="delete-bundle" />}
          </div>
        )}
        {msg.node}
      </form>
    </section>
  );
}

/** Product search -> size buttons. A product without that size yet can still be added (shown as not for sale). */
function PartSearch({ onPick }: { onPick: (p: Part) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<AdminProduct[] | null>(null);
  const [err, setErr] = useState("");
  async function search(e: Event) {
    e.preventDefault();
    if (!q.trim()) return;
    const r = await api<{ items: AdminProduct[] }>(`/api/admin/products${qs({ q: q.trim(), limit: 12 })}`);
    if (r.ok) { setItems(r.data.items ?? []); setErr(""); } else setErr(r.error);
  }
  return (
    <div class="a-field a-field--wide" data-testid="part-search">
      <span class="a-field__label">Бараа нэмэх</span>
      <div class="a-row">
        <input class="a-input a-grow" type="search" aria-label="Бараа хайх (нэр, брэнд, ID)" placeholder="Жишээ: Versace Eros" value={q} onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(e); }} />
        <button type="button" class="a-btn" onClick={search}><Icon name="search" />Хайх</button>
      </div>
      <Msg kind="err" text={err} />
      {items && (items.length === 0 ? <p class="a-dim a-small">Олдсонгүй.</p> : (
        <ul class="a-stack" style="list-style:none;padding:0;margin:8px 0 0">
          {items.map((p) => {
            const title = `${p.brand} ${p.name}${p.concentration ? ` ${p.concentration}` : ""}`;
            const sizes = p.skus.map((s) => s.ml);
            const extra = sizes.includes(10) ? [] : [10];
            return (
              <li class="a-row" style="flex-wrap:wrap;align-items:center" data-product={p.id}>
                <span class="a-grow a-small"><b>{title}</b> <span class="a-dim">· {PRODUCT_STATUS[p.status]}</span></span>
                {p.skus.map((s) => (
                  <button type="button" class="a-btn a-btn--sm" data-add-sku={s.id} onClick={() => onPick({ sku: s.id, qty: 1, label: title, title })}>
                    + {s.ml} мл{s.price === null ? " (үнэ тавиагүй)" : ""}
                  </button>
                ))}
                {extra.map((ml) => (
                  <button type="button" class="a-btn a-btn--sm a-btn--ghost" data-add-sku={`${p.id}:${ml}`} title="Энэ хэмжээ одоогоор үүсээгүй байна. Барааны хуудсанд үүсгэх хүртэл багц худалдаалагдахгүй." onClick={() => onPick({ sku: `${p.id}:${ml}`, qty: 1, label: title, title })}>
                    + {ml} мл (хэмжээ үүсээгүй)
                  </button>
                ))}
              </li>
            );
          })}
        </ul>
      ))}
    </div>
  );
}
