// Product list: search, filters (status, brand, gender, family, price, photo, low stock), sort, pages, and
// bulk actions on the selected rows (activate / hide / draft / set a price for one size).
import { useEffect, useState } from "preact/hooks";
import { GENDERS, PRODUCT_STATUSES, type AdminProduct } from "../../lib/contracts";
import { api, enc, qs } from "../api";
import { GENDER, PRODUCT_STATUS, money } from "../labels";
import { Badge, ConfirmButton, Empty, Field, Msg, Table, go, intOrNull, useLoad, useMsg, useSession } from "../ui";

const LIMIT = 50;
const SORTS: Record<string, string> = { default: "Үндсэн дараалал", brand: "Брэнд", name: "Нэр", updated: "Сүүлд зассан", created: "Сүүлд нэмсэн" };
const FAMILY: Record<string, string> = {
  amber: "Амбер", woody: "Модлог", floral: "Цэцэгс", citrus: "Цитрус", chypre: "Шипр", fresh: "Сэргэг", gourmand: "Гурманд", aromatic: "Ароматик",
};
interface F { q: string; status: string; brand: string; gender: string; family: string; hasPrice: string; hasPhoto: string; lowStock: string; sort: string; page: number }

function priceSummary(p: AdminProduct): string {
  const prices = p.skus.map((s) => s.price).filter((x): x is number => x !== null);
  if (!prices.length) return "";
  const lo = Math.min(...prices), hi = Math.max(...prices);
  return lo === hi ? money(lo) : `${money(lo)} – ${money(hi)}`;
}

export default function Products(props: Partial<Record<keyof F, string>>) {
  const { can } = useSession();
  const canEdit = can("catalog.write");
  const [f, setF] = useState<F>({
    q: props.q ?? "", status: props.status ?? "", brand: props.brand ?? "", gender: props.gender ?? "", family: props.family ?? "",
    hasPrice: props.hasPrice ?? "", hasPhoto: props.hasPhoto ?? "", lowStock: props.lowStock ?? "", sort: props.sort ?? "default", page: Number(props.page) || 1,
  });
  const [draft, setDraft] = useState(f.q);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [facets, setFacets] = useState<{ brands: { value: string; n: number }[]; families: { value: string; n: number }[]; counts: Record<string, number> } | null>(null);
  const msg = useMsg();
  const list = useLoad<{ items: AdminProduct[]; page: number; limit: number; total: number }>(
    () => api(`/api/admin/products${qs({ ...f, sort: f.sort === "default" ? "" : f.sort, page: f.page, limit: LIMIT })}`),
    [JSON.stringify(f)],
  );
  useEffect(() => { api("/api/admin/products/facets").then((r) => r.ok && setFacets(r.data)); }, []);
  useEffect(() => {
    const h = `#/products${qs({ ...f, sort: f.sort === "default" ? "" : f.sort, page: f.page > 1 ? f.page : null })}`;
    if (location.hash !== h) history.replaceState(null, "", h);
    setSel(new Set());
  }, [JSON.stringify(f)]);

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (list.data?.limit || LIMIT)));
  const set = (k: keyof F) => (e: Event) => setF({ ...f, [k]: (e.currentTarget as HTMLInputElement).value, page: 1 });
  const allOn = items.length > 0 && items.every((p) => sel.has(p.id));
  const toggle = (id: string) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  const filtered = Boolean(f.q || f.status || f.brand || f.gender || f.family || f.hasPrice || f.hasPhoto || f.lowStock);

  return (
    <section aria-labelledby="prod-h">
      <div class="a-row a-row--between">
        <h1 id="prod-h" class="a-title">Бараа</h1>
        {canEdit && <a class="a-btn a-btn--primary" href="#/products/new" data-testid="new-product">+ Шинэ бараа</a>}
      </div>
      {facets && (
        <div class="a-segs" role="group" aria-label="Төлөвөөр" style="margin-bottom:12px;flex-wrap:wrap">
          <button type="button" aria-pressed={!f.status} onClick={() => setF({ ...f, status: "", page: 1 })}>Бүгд ({Object.values(facets.counts).reduce((a, b) => a + b, 0)})</button>
          {PRODUCT_STATUSES.map((s) => <button type="button" aria-pressed={f.status === s} onClick={() => setF({ ...f, status: s, page: 1 })}>{PRODUCT_STATUS[s]} ({facets.counts[s] ?? 0})</button>)}
        </div>
      )}
      <form class="a-filters" role="search" onSubmit={(e) => { e.preventDefault(); setF({ ...f, q: draft.trim(), page: 1 }); }}>
        <Field label="Хайх (нэр, брэнд, ID)">
          <input class="a-input" type="search" name="q" value={draft} onInput={(e) => setDraft(e.currentTarget.value)} />
        </Field>
        <Field label="Брэнд">
          <select class="a-input" name="brand" value={f.brand} onChange={set("brand")}>
            <option value="">Бүгд</option>
            {facets?.brands.map((b) => <option value={b.value}>{b.value} ({b.n})</option>)}
          </select>
        </Field>
        <Field label="Хүйс">
          <select class="a-input" name="gender" value={f.gender} onChange={set("gender")}>
            <option value="">Бүгд</option>
            {GENDERS.map((g) => <option value={g}>{GENDER[g]}</option>)}
            <option value="none">Тодорхойгүй</option>
          </select>
        </Field>
        <Field label="Үнэрийн бүл">
          <select class="a-input" name="family" value={f.family} onChange={set("family")}>
            <option value="">Бүгд</option>
            {(facets?.families ?? []).map((x) => <option value={x.value}>{FAMILY[x.value] ?? x.value} ({x.n})</option>)}
            <option value="none">Тодорхойгүй</option>
          </select>
        </Field>
        <Field label="Үнэ">
          <select class="a-input" name="hasPrice" value={f.hasPrice} onChange={set("hasPrice")}>
            <option value="">Бүгд</option><option value="1">Үнэтэй</option><option value="0">Үнэ тавиагүй</option>
          </select>
        </Field>
        <Field label="Зураг">
          <select class="a-input" name="hasPhoto" value={f.hasPhoto} onChange={set("hasPhoto")}>
            <option value="">Бүгд</option><option value="1">Зурагтай</option><option value="0">Зураггүй</option>
          </select>
        </Field>
        <Field label="Эрэмбэлэх">
          <select class="a-input" name="sort" value={f.sort} onChange={set("sort")}>
            {Object.entries(SORTS).map(([k, v]) => <option value={k}>{v}</option>)}
          </select>
        </Field>
        <label class="a-check"><input type="checkbox" checked={f.lowStock === "1"} onChange={(e) => setF({ ...f, lowStock: e.currentTarget.checked ? "1" : "", page: 1 })} /> Цөөхөн үлдсэн</label>
        <button class="a-btn a-btn--primary" type="submit">Хайх</button>
        {filtered && <button class="a-btn a-btn--ghost" type="button" onClick={() => { setDraft(""); setF({ q: "", status: "", brand: "", gender: "", family: "", hasPrice: "", hasPhoto: "", lowStock: "", sort: f.sort, page: 1 }); }}>Цэвэрлэх</button>}
      </form>
      <Msg kind="err" text={list.error} />
      {msg.node}
      <p class="a-dim a-small" role="status">{list.loading ? "Ачаалж байна…" : list.data ? `Нийт ${total} бараа${pages > 1 ? ` · ${f.page}/${pages} хуудас` : ""}` : ""}</p>

      {canEdit && sel.size > 0 && <Bulk ids={[...sel]} onDone={(t) => { msg.ok(t); setSel(new Set()); list.reload(); }} onErr={msg.err} />}

      <Table label="Барааны жагсаалт" head={[canEdit ? "" : "", "", "Бараа", "Төлөв", "Хэмжээ / үнэ", "Үлдэгдэл"]}>
        {canEdit && items.length > 0 && (
          <tr><td colSpan={6} style="padding:6px 12px"><label class="a-check a-small"><input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(items.map((p) => p.id)))} data-testid="select-all" /> Энэ хуудсын бүгдийг сонгох</label></td></tr>
        )}
        {items.map((p) => {
          const tracked = p.skus.filter((s) => s.available !== null);
          const avail = tracked.reduce((a, s) => a + (s.available ?? 0), 0);
          const price = priceSummary(p);
          return (
            <tr data-product={p.id} data-href onClick={(e) => { if (!(e.target as Element).closest("a,input,label,button")) go(`#/products/${enc(p.id)}`); }}>
              <td style="width:36px">{canEdit && <input type="checkbox" aria-label={`${p.brand} ${p.name} сонгох`} checked={sel.has(p.id)} onChange={() => toggle(p.id)} />}</td>
              <td class="a-thumbcell">{p.imageFront ? <img class="a-thumb" src={p.imageFront} alt="" loading="lazy" width={42} height={42} /> : <span class="a-thumb a-thumb--none" aria-hidden="true" />}</td>
              <td>
                <a href={`#/products/${enc(p.id)}`}><b>{p.brand}</b> — {p.name}</a>
                <div class="a-dim a-mono a-small">{p.id}{p.concentration ? ` · ${p.concentration}` : ""}{p.gender ? ` · ${GENDER[p.gender]}` : ""}</div>
              </td>
              <td>
                <Badge value={p.status} labels={PRODUCT_STATUS} />
                {p.saleLocked && <div style="margin-top:4px"><span class="a-badge" data-s="locked">Худалдаа түгжсэн</span></div>}
              </td>
              <td class="a-small">
                {p.skus.length ? `${p.skus.map((s) => s.ml).join(" / ")} мл` : "Хэмжээ алга"}
                <div>{price ? <span class="a-mono">{price}</span> : <span class="a-badge" data-s="nosale">Үнэ тавиагүй</span>}</div>
              </td>
              <td class="a-mono">{tracked.length ? <span style={avail <= 3 ? "color:var(--warn)" : undefined}>{avail}</span> : <span class="a-dim">—</span>}</td>
            </tr>
          );
        })}
      </Table>
      {list.loading && !list.data && <div class="a-stack" style="margin-top:12px">{[1, 2, 3, 4].map(() => <span class="a-skel" />)}</div>}
      <Empty show={!!list.data && !items.length} text={filtered ? "Шүүлтүүрт тохирох бараа олдсонгүй." : "Бараа алга. “+ Шинэ бараа”-аар нэмнэ үү."} />
      {pages > 1 && (
        <nav class="a-pager" aria-label="Хуудаслалт">
          <button type="button" class="a-btn" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>‹ Өмнөх</button>
          <span class="a-dim">{f.page} / {pages}</span>
          <button type="button" class="a-btn" disabled={f.page >= pages} onClick={() => setF({ ...f, page: f.page + 1 })}>Дараах ›</button>
        </nav>
      )}
    </section>
  );
}

function Bulk({ ids, onDone, onErr }: { ids: string[]; onDone: (t: string) => void; onErr: (t: string) => void }) {
  const [ml, setMl] = useState("5");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(body: Record<string, unknown>, done: (n: number) => string) {
    setBusy(true);
    const r = await api<{ changed: number }>("/api/admin/products/bulk", { method: "POST", body: { ids, ...body } });
    setBusy(false);
    if (r.ok) onDone(done(r.data.changed)); else onErr(r.error);
  }
  function setPriceAll(e: Event) {
    e.preventDefault();
    const m = intOrNull(ml), p = intOrNull(price);
    if (m === null || Number.isNaN(m) || m < 1 || m > 1000) { onErr("мл: 1–1000 бүхэл тоо."); return; }
    if (p === null || Number.isNaN(p) || p <= 0) { onErr("Үнэ: эерэг бүхэл тоо (₮)."); return; }
    run({ action: "price", ml: m, price: p }, (n) => `${n} бараанд ${m} мл-ийн үнэ ${money(p)} боллоо.`);
  }
  return (
    <form class="a-bulk" onSubmit={setPriceAll} data-testid="bulk">
      <b style="align-self:center">{ids.length} сонгосон</b>
      <button type="button" class="a-btn a-btn--sm" disabled={busy} onClick={() => run({ action: "activate" }, (n) => `${n} бараа идэвхжлээ.`)}>Идэвхжүүлэх</button>
      <button type="button" class="a-btn a-btn--sm" disabled={busy} onClick={() => run({ action: "draft" }, (n) => `${n} бараа ноорог боллоо.`)}>Ноорог болгох</button>
      <ConfirmButton label="Нуух" question={`${ids.length} барааг дэлгүүрээс нуух уу?`} confirmLabel="Тийм, нуух" onConfirm={() => run({ action: "hide" }, (n) => `${n} бараа нуугдлаа.`)} disabled={busy} />
      <span style="flex-basis:12px" />
      <Field label="Хэмжээ (мл)"><input class="a-input a-input--sm" style="width:80px" inputMode="numeric" value={ml} onInput={(e) => setMl(e.currentTarget.value)} /></Field>
      <Field label="Үнэ ₮"><input class="a-input a-input--sm" inputMode="numeric" value={price} onInput={(e) => setPrice(e.currentTarget.value)} /></Field>
      <button class="a-btn a-btn--sm a-btn--primary" type="submit" disabled={busy}>Үнэ тавих</button>
    </form>
  );
}
