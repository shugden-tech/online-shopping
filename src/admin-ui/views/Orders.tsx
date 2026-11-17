// Orders list: status filter + search (server), payment-status filter (on the loaded rows), keyset "load more".
import { useEffect, useState } from "preact/hooks";
import { ORDER_STATUSES, PAYMENT_STATUSES_ORDER } from "../../lib/contracts";
import { api, enc, orderView, qs, rows, type OrderView } from "../api";
import { ORDER_PAY_STATUS, ORDER_STATUS, money, when } from "../labels";
import { Badge, Empty, Field, Loading, Msg, Table } from "../ui";

export default function Orders(props: { status?: string; q?: string }) {
  const [f, setF] = useState({ status: props.status ?? "", q: props.q ?? "" });
  const [pay, setPay] = useState("");
  const [q, setQ] = useState(f.q);
  const [items, setItems] = useState<OrderView[]>([]);
  const [cursor, setCursor] = useState<string | number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load(reset: boolean) {
    setLoading(true);
    const res = await api(`/api/admin/orders${qs({ status: f.status, q: f.q, cursor: reset ? null : cursor, limit: 50 })}`);
    setLoading(false);
    if (!res.ok) { setError(res.error); return; }
    setError("");
    const list = rows(res.data, "orders").map(orderView);
    setItems((cur) => (reset ? list : [...cur, ...list]));
    setCursor(res.data.nextCursor ?? null);
  }
  useEffect(() => { load(true); }, [f.status, f.q]);

  const shown = pay ? items.filter((o) => o.paymentStatus === pay) : items;

  return (
    <section aria-labelledby="ord-h">
      <h1 id="ord-h" class="a-title">Захиалга</h1>
      <form class="a-filters" role="search" onSubmit={(e) => { e.preventDefault(); setF({ ...f, q: q.trim() }); }}>
        <Field label="Хайх (дугаар, утас, нэр)">
          <input class="a-input" type="search" name="q" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        </Field>
        <Field label="Төлөв">
          <select class="a-input" name="status" value={f.status} onChange={(e) => setF({ ...f, status: e.currentTarget.value })}>
            <option value="">Бүгд</option>
            {ORDER_STATUSES.map((s) => <option value={s}>{ORDER_STATUS[s]}</option>)}
          </select>
        </Field>
        <Field label="Төлбөрийн төлөв">
          <select class="a-input" name="payment" value={pay} onChange={(e) => setPay(e.currentTarget.value)}>
            <option value="">Бүгд</option>
            {PAYMENT_STATUSES_ORDER.map((s) => <option value={s}>{ORDER_PAY_STATUS[s]}</option>)}
          </select>
        </Field>
        <button class="a-btn" type="submit">Хайх</button>
        <button class="a-btn a-btn--ghost" type="button" onClick={() => load(true)}>Сэргээх</button>
      </form>
      <Msg kind="err" text={error} />
      <p class="a-dim a-small" role="status">{loading ? "Ачаалж байна…" : `${shown.length} захиалга харагдаж байна${pay ? " (төлбөрийн шүүлтүүр ачаалсан мөрөнд)" : ""}`}</p>
      <Table label="Захиалгын жагсаалт" head={["Дугаар", "Огноо", "Төлөв", "Төлбөр", "Хэрэглэгч", "Дүн"]}>
        {shown.map((o) => (
          <tr data-order={o.no}>
            <td class="a-mono"><a href={`#/orders/${enc(o.no)}`}>{o.no}</a></td>
            <td class="a-mono a-small">{when(o.createdAt)}</td>
            <td><Badge value={o.status} labels={ORDER_STATUS} /></td>
            <td>
              <Badge value={o.paymentStatus} labels={ORDER_PAY_STATUS} tone={`pay-${o.paymentStatus}`} />
              {o.status === "new" && o.holdExpiresAt && <div class="a-small a-dim">нөөц {when(o.holdExpiresAt)} хүртэл</div>}
            </td>
            <td>{o.name}<div class="a-mono a-small">{o.phone}</div></td>
            <td class="a-mono">{money(o.total)}</td>
          </tr>
        ))}
      </Table>
      <Loading on={loading && !items.length} />
      <Empty show={!loading && !error && !shown.length} text="Захиалга алга." />
      {cursor !== null && <button type="button" class="a-btn" disabled={loading} onClick={() => load(false)}>Цааш ачаалах</button>}
    </section>
  );
}
