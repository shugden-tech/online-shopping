// Orders list: search (number, phone, name), order / payment status, date range (server-side), keyset
// "load more". Reloads by itself when the poll in the shell sees a new order.
import { useEffect, useState } from "preact/hooks";
import { ORDER_STATUSES, PAYMENT_STATUSES_ORDER } from "../../lib/contracts";
import { api, enc, orderView, qs, rows, type OrderView } from "../api";
import { ORDER_PAY_STATUS, ORDER_STATUS, PROVIDER, money, when } from "../labels";
import { Badge, Empty, Field, Loading, Msg, Table, go } from "../ui";
import { Icon } from "../icons";

interface F { status: string; paymentStatus: string; q: string; from: string; to: string }

export default function Orders(props: Partial<F>) {
  const [f, setF] = useState<F>({ status: props.status ?? "", paymentStatus: props.paymentStatus ?? "", q: props.q ?? "", from: props.from ?? "", to: props.to ?? "" });
  const [draft, setDraft] = useState(f.q);
  const [items, setItems] = useState<OrderView[]>([]);
  const [cursor, setCursor] = useState<string | number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load(reset: boolean) {
    setLoading(true);
    const res = await api(`/api/admin/orders${qs({ ...f, cursor: reset ? null : cursor, limit: 50 })}`);
    setLoading(false);
    if (!res.ok) { setError(res.error); return; }
    setError("");
    const list = rows(res.data, "orders").map(orderView);
    setItems((cur) => (reset ? list : [...cur, ...list]));
    setCursor(res.data.nextCursor ?? null);
  }
  useEffect(() => {
    load(true);
    // keep the filters in the address so a reload or a shared link shows the same list
    const q = qs({ ...f });
    if (location.hash !== `#/orders${q}`) history.replaceState(null, "", `#/orders${q}`);
  }, [f.status, f.paymentStatus, f.q, f.from, f.to]);
  useEffect(() => {
    const on = () => load(true);
    addEventListener("gz:new-order", on);
    return () => removeEventListener("gz:new-order", on);
  }, [f.status, f.paymentStatus, f.q, f.from, f.to]);

  const set = (k: keyof F) => (e: Event) => setF({ ...f, [k]: (e.currentTarget as HTMLInputElement).value });
  const filtered = Boolean(f.status || f.paymentStatus || f.q || f.from || f.to);

  return (
    <section aria-labelledby="ord-h">
      <h1 id="ord-h" class="a-title">Захиалга</h1>
      <form class="a-filters" role="search" onSubmit={(e) => { e.preventDefault(); setF({ ...f, q: draft.trim() }); }}>
        <Field label="Хайх (дугаар, утас, нэр)">
          <input class="a-input" type="search" name="q" value={draft} placeholder="GZ-… / 9911… / нэр" onInput={(e) => setDraft(e.currentTarget.value)} />
        </Field>
        <Field label="Төлөв">
          <select class="a-input" name="status" value={f.status} onChange={set("status")}>
            <option value="">Бүгд</option>
            {ORDER_STATUSES.map((s) => <option value={s}>{ORDER_STATUS[s]}</option>)}
          </select>
        </Field>
        <Field label="Төлбөр">
          <select class="a-input" name="payment" value={f.paymentStatus} onChange={set("paymentStatus")}>
            <option value="">Бүгд</option>
            {PAYMENT_STATUSES_ORDER.map((s) => <option value={s}>{ORDER_PAY_STATUS[s]}</option>)}
          </select>
        </Field>
        <Field label="Эхлэх огноо"><input class="a-input" type="date" name="from" value={f.from} max={f.to || undefined} onChange={set("from")} /></Field>
        <Field label="Дуусах огноо"><input class="a-input" type="date" name="to" value={f.to} min={f.from || undefined} onChange={set("to")} /></Field>
        <button class="a-btn a-btn--primary" type="submit"><Icon name="search" />Хайх</button>
        {filtered && <button class="a-btn a-btn--ghost" type="button" onClick={() => { setDraft(""); setF({ status: "", paymentStatus: "", q: "", from: "", to: "" }); }}><Icon name="filterOff" />Цэвэрлэх</button>}
      </form>
      <Msg kind="err" text={error} />
      <p class="a-dim a-small" role="status">{loading ? "Ачаалж байна…" : `${items.length}${cursor !== null ? "+" : ""} захиалга`}</p>
      <Table label="Захиалгын жагсаалт" head={["Дугаар", "Огноо", "Хэрэглэгч", "Дүн", "Төлбөр", "Төлөв"]}>
        {items.map((o) => (
          <tr data-order={o.no} data-href onClick={(e) => { if (!(e.target as Element).closest("a")) go(`#/orders/${enc(o.no)}`); }}>
            <td class="a-mono"><a href={`#/orders/${enc(o.no)}`}>{o.no}</a></td>
            <td class="a-mono a-small">{when(o.createdAt)}</td>
            <td>{o.name}<div class="a-mono a-small a-dim">{o.phone}</div></td>
            <td class="a-mono a-r">{money(o.total)}</td>
            <td>
              <Badge value={o.paymentStatus} labels={ORDER_PAY_STATUS} tone={`pay-${o.paymentStatus}`} />
              <div class="a-small a-dim">{PROVIDER[o.payment] ?? o.payment}</div>
              {o.status === "new" && o.holdExpiresAt && <div class="a-small a-dim">Нөөцлөлт {when(o.holdExpiresAt)} хүртэл</div>}
            </td>
            <td><Badge value={o.status} labels={ORDER_STATUS} /></td>
          </tr>
        ))}
      </Table>
      <Loading on={loading && !items.length} />
      <Empty show={!loading && !error && !items.length} text={filtered ? "Шүүлтүүрт тохирох захиалга олдсонгүй." : "Одоогоор захиалга алга. Шинэ захиалга орж ирэхэд энд харагдана."} />
      {cursor !== null && <p><button type="button" class="a-btn" disabled={loading} onClick={() => load(false)}><Icon name="more" />Цааш ачаалах</button></p>}
    </section>
  );
}
