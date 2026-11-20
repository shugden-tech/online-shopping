// Stock (Үлдэгдэл): every size across the catalog with stock / reserved / available, search, "low" filter,
// quick +/- adjust with a reason, and the movement history per SKU.
import { useState } from "preact/hooks";
import { api, enc, qs } from "../api";
import { PRODUCT_STATUS, STOCK_REASON, num, when, ACTOR } from "../labels";
import { Badge, Empty, Field, Loading, Msg, Table, intOrNull, useKeyset, useMsg, useSession } from "../ui";
import { Icon } from "../icons";

const LOW = 3;

export default function Inventory(props: { low?: string; q?: string }) {
  const { can } = useSession();
  const canAdjust = can("inventory.write");
  const [f, setF] = useState({ q: props.q ?? "", low: props.low === "1", tracked: false, active: true });
  const [draft, setDraft] = useState(f.q);
  const list = useKeyset(
    (cursor) => `/api/admin/inventory${qs({ q: f.q, low: f.low ? LOW : null, tracked: f.tracked ? 1 : null, active: f.active ? 1 : null, cursor, limit: 100 })}`,
    [f.q, f.low, f.tracked, f.active],
  );
  const [open, setOpen] = useState<string | null>(null);
  const msg = useMsg();

  return (
    <section aria-labelledby="inv-h">
      <h1 id="inv-h" class="a-title">Үлдэгдэл</h1>
      <form class="a-filters" role="search" onSubmit={(e) => { e.preventDefault(); setF({ ...f, q: draft.trim() }); }}>
        <Field label="Хайх (брэнд, нэр, SKU)"><input class="a-input" type="search" value={draft} onInput={(e) => setDraft(e.currentTarget.value)} /></Field>
        <label class="a-check"><input type="checkbox" checked={f.low} onChange={(e) => setF({ ...f, low: e.currentTarget.checked })} data-testid="low-only" /> Зөвхөн цөөхөн (≤ {LOW})</label>
        <label class="a-check"><input type="checkbox" checked={f.tracked} onChange={(e) => setF({ ...f, tracked: e.currentTarget.checked })} /> Зөвхөн тоолдог</label>
        <label class="a-check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.currentTarget.checked })} /> Зөвхөн идэвхтэй бараа</label>
        <button class="a-btn a-btn--primary" type="submit"><Icon name="search" />Хайх</button>
      </form>
      <p class="a-dim a-small">“Тоолдоггүй” хэмжээ хязгааргүй зарагдана. Тоог нэг удаа оруулбал түүнээс хойш тоолж эхэлнэ.</p>
      {msg.node}
      <Msg kind="err" text={list.error} />
      <Table label="Үлдэгдлийн жагсаалт" head={["Бараа", "Хэмжээ", "Үлдэгдэл", "Нөөцлөгдсөн", "Боломжит", canAdjust ? "Тохируулах" : "", ""]}>
        {list.items.map((s: any) => (
          <>
            <tr data-inv={s.id}>
              <td><a href={`#/products/${enc(s.productId)}`}><b>{s.brand}</b> — {s.name}</a>{s.productStatus !== "active" && <> <Badge value={s.productStatus} labels={PRODUCT_STATUS} /></>}</td>
              <td class="a-mono">{s.ml} мл</td>
              <td class="a-mono">{s.stock === null ? <span class="a-dim">тоолдоггүй</span> : num(s.stock)}</td>
              <td class="a-mono">{num(s.reserved)}</td>
              <td class="a-mono">{s.available === null ? "∞" : <b class={s.available <= 0 ? "a-warn" : undefined} style={s.available > 0 && s.available <= LOW ? "color:var(--warn)" : undefined}>{num(s.available)}</b>}</td>
              <td>{canAdjust && <Adjust sku={s} onDone={(t) => { msg.ok(t); list.reload(); }} onErr={msg.err} />}</td>
              <td><button type="button" class="a-btn a-btn--sm" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}><Icon name="audit" />Түүх</button></td>
            </tr>
            {open === s.id && <tr><td colSpan={7}><Movements sku={s.id} /></td></tr>}
          </>
        ))}
      </Table>
      <Loading on={list.loading} />
      <Empty show={!list.loading && !list.error && !list.items.length} text={f.low ? "Цөөхөн үлдсэн хэмжээ алга." : "Илэрц олдсонгүй."} />
      {list.cursor !== null && <p><button type="button" class="a-btn" disabled={list.loading} onClick={list.more}><Icon name="more" />Цааш ачаалах</button></p>}
    </section>
  );
}

/** Inline adjust: a number (+5 / -2 for tracked sizes, the new count for untracked ones) + reason. */
function Adjust({ sku, onDone, onErr }: { sku: any; onDone: (t: string) => void; onErr: (t: string) => void }) {
  const tracked = sku.stock !== null;
  const [v, setV] = useState("");
  const [reason, setReason] = useState("restock");
  const [busy, setBusy] = useState(false);
  async function go(e: Event) {
    e.preventDefault();
    const n = intOrNull(v);
    if (n === null || Number.isNaN(n) || (!tracked && n < 0) || (tracked && n === 0)) { onErr(tracked ? "Өөрчлөлт: 0-ээс өөр бүхэл тоо (ж: 5 эсвэл -2)." : "Тоо: 0 буюу түүнээс их бүхэл тоо."); return; }
    setBusy(true);
    const res = await api("/api/admin/inventory/adjust", { method: "POST", body: { sku: sku.id, [tracked ? "delta" : "set"]: n, reason }, conflict: "нөөцлөгдсөн тооноос бага болгох боломжгүй." });
    setBusy(false);
    if (res.ok) { setV(""); onDone(`${sku.brand} ${sku.name} ${sku.ml} мл: үлдэгдэл шинэчлэгдлээ.`); } else onErr(res.error);
  }
  return (
    <form class="a-row a-row--tight" onSubmit={go}>
      <input class="a-input a-input--sm" style="width:72px" inputMode="numeric" aria-label={`${sku.ml} мл ${tracked ? "өөрчлөлт" : "тоо"}`} placeholder={tracked ? "±" : "="} value={v} onInput={(e) => setV(e.currentTarget.value)} />
      <select class="a-input a-input--sm" aria-label="Шалтгаан" value={reason} onChange={(e) => setReason(e.currentTarget.value)}>
        <option value="restock">{STOCK_REASON.restock}</option>
        <option value="correction">{STOCK_REASON.correction}</option>
      </select>
      <button class="a-btn a-btn--sm" type="submit" disabled={busy}>OK</button>
    </form>
  );
}

function Movements({ sku }: { sku: string }) {
  const list = useKeyset((cursor) => `/api/admin/inventory/${enc(sku)}/movements${qs({ cursor })}`, [sku]);
  return (
    <div data-testid="movements">
      <Msg kind="err" text={list.error} />
      {list.items.length ? (
        <Table label="Хөдөлгөөний түүх" head={["Огноо", "Өөрчлөлт", "Шалтгаан", "Хэн", "Тэмдэглэл"]}>
          {list.items.map((m: any) => (
            <tr>
              <td class="a-mono a-small">{when(m.at)}</td>
              <td class="a-mono">{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
              <td>{STOCK_REASON[m.reason] ?? m.reason}</td>
              <td class="a-small">{ACTOR[m.actor] ?? m.actor}</td>
              <td class="a-small">{m.note ?? ""}</td>
            </tr>
          ))}
        </Table>
      ) : !list.loading && <p class="a-dim">Хөдөлгөөн алга.</p>}
      <Loading on={list.loading} />
    </div>
  );
}
