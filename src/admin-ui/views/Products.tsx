// Product list: search, status/brand filter, page-numbered paging (GET /api/admin/products -> Page<AdminProduct>).
import { useState } from "preact/hooks";
import { PRODUCT_STATUSES, type AdminProduct } from "../../lib/contracts";
import { api, qs } from "../api";
import { PRODUCT_STATUS, money } from "../labels";
import { Badge, Empty, Field, Loading, Msg, Table, useLoad, useSession } from "../ui";

const LIMIT = 50;

function priceSummary(p: AdminProduct): string {
  const prices = p.skus.map((s) => s.price).filter((x): x is number => x !== null);
  if (!prices.length) return "Үнэгүй";
  const lo = Math.min(...prices), hi = Math.max(...prices);
  return lo === hi ? money(lo) : `${money(lo)} – ${money(hi)}`;
}

export default function Products(props: { status?: string; q?: string; brand?: string }) {
  const { can } = useSession();
  const [f, setF] = useState({ q: props.q ?? "", status: props.status ?? "", brand: props.brand ?? "", page: 1 });
  const [draft, setDraft] = useState({ q: f.q, brand: f.brand });
  const list = useLoad<{ items: AdminProduct[]; page: number; limit: number; total: number }>(
    () => api(`/api/admin/products${qs({ q: f.q, status: f.status, brand: f.brand, page: f.page, limit: LIMIT })}`),
    [f.q, f.status, f.brand, f.page],
  );
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (list.data?.limit || LIMIT)));

  return (
    <section aria-labelledby="prod-h">
      <div class="a-row a-row--between">
        <h1 id="prod-h" class="a-title">Бараа</h1>
        {can("catalog.write") && <a class="a-btn a-btn--primary" href="#/products/new" data-testid="new-product">+ Шинэ бараа</a>}
      </div>
      <form class="a-filters" role="search" onSubmit={(e) => { e.preventDefault(); setF({ ...f, q: draft.q.trim(), brand: draft.brand.trim(), page: 1 }); }}>
        <Field label="Хайх (нэр, брэнд, ID)">
          <input class="a-input" type="search" name="q" value={draft.q} onInput={(e) => setDraft({ ...draft, q: e.currentTarget.value })} />
        </Field>
        <Field label="Брэнд">
          <input class="a-input" name="brand" value={draft.brand} onInput={(e) => setDraft({ ...draft, brand: e.currentTarget.value })} />
        </Field>
        <Field label="Төлөв">
          <select class="a-input" name="status" value={f.status} onChange={(e) => setF({ ...f, status: e.currentTarget.value, page: 1 })}>
            <option value="">Бүгд</option>
            {PRODUCT_STATUSES.map((s) => <option value={s}>{PRODUCT_STATUS[s]}</option>)}
          </select>
        </Field>
        <button class="a-btn" type="submit">Хайх</button>
      </form>
      <Msg kind="err" text={list.error} />
      <Loading on={list.loading && !list.data} />
      <p class="a-dim a-small" role="status">{list.data ? `Нийт ${total} бараа` : ""}</p>
      <Table label="Барааны жагсаалт" head={["", "Бараа", "Төлөв", "Хэмжээ / үнэ", "Үлдэгдэл"]}>
        {items.map((p) => {
          const tracked = p.skus.filter((s) => s.available !== null);
          const avail = tracked.reduce((a, s) => a + (s.available ?? 0), 0);
          return (
            <tr data-product={p.id}>
              <td class="a-thumbcell">{p.imageFront ? <img class="a-thumb" src={p.imageFront} alt="" loading="lazy" width={40} height={40} /> : <span class="a-thumb a-thumb--none" aria-hidden="true" />}</td>
              <td>
                <a href={`#/products/${encodeURIComponent(p.id)}`}><b>{p.brand}</b> — {p.name}</a>
                <div class="a-dim a-mono a-small">{p.id}</div>
              </td>
              <td>
                <Badge value={p.status} labels={PRODUCT_STATUS} />
                {p.saleLocked && <> <span class="a-badge" data-s="locked">Худалдаа түгжсэн</span></>}
              </td>
              <td class="a-small">
                {p.skus.length} хэмжээ · <span class={priceSummary(p) === "Үнэгүй" ? "a-warn" : ""}>{priceSummary(p)}</span>
              </td>
              <td class="a-mono">{tracked.length ? avail : "—"}</td>
            </tr>
          );
        })}
      </Table>
      <Empty show={!!list.data && !items.length} text="Илэрц олдсонгүй." />
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
