// Order detail: items, totals, customer, payments, reservations, shipments, event history; status actions
// limited to ORDER_TRANSITIONS and the role; bank mark-paid; create shipment.
import { useEffect, useState } from "preact/hooks";
import { ORDER_TRANSITIONS, type OrderStatus, type Permission } from "../../lib/contracts";
import { api, enc, orderView, paymentView, pick, shipmentView, type OrderView } from "../api";
import {
  ORDER_ACTION, ORDER_PAY_STATUS, ORDER_STATUS, PAYMENT_STATUS, PROVIDER, SHIPMENT_STATUS, money, when,
} from "../labels";
import { Badge, ConfirmButton, Field, Loading, Msg, Table, go, intOrNull, useMsg, useSession } from "../ui";

const CITY: Record<string, string> = { ub: "Улаанбаатар", countryside: "Орон нутаг" };

/** Permission an order transition needs (PATCH to `paid` also needs payments.write — CONTRACTS §4). */
export const transitionPerms = (to: string): Permission[] => (to === "paid" ? ["orders.write", "payments.write"] : ["orders.write"]);

export default function OrderDetail({ no }: { no: string }) {
  const { can } = useSession();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const msg = useMsg();

  async function load() {
    const res = await api(`/api/admin/orders/${enc(no)}`);
    if (res.ok) { setData(res.data); setError(""); } else setError(res.error);
  }
  useEffect(() => { load(); }, [no]);

  if (error && !data) return <><p><a href="#/orders">‹ Захиалга</a></p><Msg kind="err" text={error} /></>;
  if (!data) return <Loading on />;

  const raw = data.order ?? {};
  const o: OrderView = orderView(raw);
  const events: any[] = data.events ?? raw.events ?? [];
  const payments = (data.payments ?? raw.payments ?? []).map(paymentView);
  const reservations: any[] | null = data.reservations ?? raw.reservations ?? null;
  const shipList = data.shipments ?? raw.shipments ?? (data.shipment ? [data.shipment] : raw.shipment ? [raw.shipment] : []);
  const shipments = (shipList as any[]).map(shipmentView);
  const next = (ORDER_TRANSITIONS[o.status as OrderStatus] ?? []).filter((to) => transitionPerms(to).every(can));
  const activeShipment = shipments.some((s) => s.status !== "cancelled" && s.status !== "failed");

  async function transition(to: string) {
    setBusy(true);
    const body: Record<string, string> = { status: to };
    if (note.trim()) body.note = note.trim();
    const res = await api(`/api/admin/orders/${enc(no)}`, { method: "PATCH", body, conflict: "захиалгын төлөв өөр газар өөрчлөгдсөн байна. Хуудсыг сэргээгээд дахин оролдоно уу." });
    setBusy(false);
    if (res.ok) { setNote(""); msg.ok(`Төлөв: ${ORDER_STATUS[to] ?? to}.`); await load(); } else msg.err(res.error);
  }

  async function createShipment() {
    setBusy(true);
    const res = await api("/api/admin/shipments", { method: "POST", body: { orderNo: o.no }, conflict: "захиалга төлөгдсөн төлөвт биш эсвэл хүргэлт аль хэдийн үүссэн байна." });
    setBusy(false);
    if (res.ok) {
      const s = res.data.shipment ? shipmentView(res.data.shipment) : null;
      msg.ok(`Хүргэлт үүслээ${s ? ` (#${s.id}, ${SHIPMENT_STATUS[s.status] ?? s.status})` : ""}.`);
      await load();
    } else msg.err(res.error);
  }

  return (
    <section aria-labelledby="od-h" class="a-stack">
      <p><a href="#/orders">‹ Захиалга</a></p>
      <div class="a-row a-row--between">
        <h1 id="od-h" class="a-title a-mono">{o.no}</h1>
        {can("audit.read") && <a href={`#/audit?entity=order&entityId=${enc(o.no)}`}>Үйлдлийн түүх</a>}
      </div>
      <div class="a-row">
        <Badge value={o.status} labels={ORDER_STATUS} />
        <Badge value={o.paymentStatus} labels={ORDER_PAY_STATUS} tone={`pay-${o.paymentStatus}`} />
        <span class="a-dim a-small">{when(o.createdAt)} · {PROVIDER[o.payment] ?? o.payment}{o.locale ? ` · ${o.locale}` : ""}</span>
      </div>
      {o.status === "new" && o.holdExpiresAt && <p class="a-small">Нөөц {when(o.holdExpiresAt)} хүртэл хадгалагдана (төлөгдөхгүй бол цуцлагдана).</p>}
      {o.cancelReason && <p class="a-small">Цуцалсан шалтгаан: {o.cancelReason}</p>}

      <section class="a-panel" aria-labelledby="act-h" data-testid="order-actions">
        <h2 id="act-h" class="a-h2">Үйлдэл</h2>
        {next.length ? (
          <>
            <Field label="Тэмдэглэл (заавал биш)"><input class="a-input" maxLength={300} value={note} onInput={(e) => setNote(e.currentTarget.value)} /></Field>
            <div class="a-row">
              {next.map((to) =>
                to === "cancelled" ? (
                  <ConfirmButton testid="to-cancelled" label={ORDER_ACTION.cancelled!} danger disabled={busy}
                    question={`${o.no} захиалгыг цуцлах уу? ${o.status === "paid" ? "Үлдэгдэл буцаан нэмэгдэнэ." : "Нөөцлөгдсөн бараа суллагдана."}`}
                    confirmLabel="Тийм, цуцлах" onConfirm={() => transition("cancelled")} />
                ) : (
                  <button type="button" class="a-btn" data-to={to} data-testid={`to-${to}`} disabled={busy} onClick={() => transition(to)}>{ORDER_ACTION[to] ?? to}</button>
                ),
              )}
            </div>
          </>
        ) : (
          <p class="a-dim">{ORDER_TRANSITIONS[o.status as OrderStatus]?.length === 0 ? "Эцсийн төлөв — өөрчлөх боломжгүй." : "Таны эрхээр төлөв өөрчлөх боломжгүй."}</p>
        )}
        {(o.status === "new" || o.status === "confirmed") && can("payments.write") && <MarkPaid no={o.no} total={o.total} onDone={async (t) => { msg.ok(t); await load(); }} />}
        {o.status === "paid" && can("delivery.write") && !activeShipment && (
          <div class="a-row"><button type="button" class="a-btn a-btn--primary" data-testid="create-shipment" disabled={busy} onClick={createShipment}>Хүргэлт үүсгэх</button></div>
        )}
        {msg.node}
      </section>

      <div class="a-two">
        <section class="a-panel" aria-labelledby="cust-h">
          <h2 id="cust-h" class="a-h2">Хэрэглэгч</h2>
          <dl class="a-dl">
            <dt>Нэр</dt><dd>{o.name || "—"}</dd>
            <dt>Утас</dt><dd class="a-mono">{o.phone}{o.phone2 ? ` / ${o.phone2}` : ""}</dd>
            <dt>Хаяг</dt><dd>{[CITY[o.city] ?? o.city, o.district, o.khoroo].filter(Boolean).join(", ")}<br />{o.address}</dd>
            {o.note && <><dt>Тэмдэглэл</dt><dd>“{o.note}”</dd></>}
          </dl>
        </section>
        <section class="a-panel" aria-labelledby="tot-h">
          <h2 id="tot-h" class="a-h2">Дүн</h2>
          <dl class="a-dl">
            <dt>Барааны дүн</dt><dd class="a-mono">{money(o.subtotal)}</dd>
            <dt>Хүргэлт</dt><dd class="a-mono">{money(o.delivery)}</dd>
            <dt>Нийт</dt><dd class="a-mono"><b>{money(o.total)}</b></dd>
          </dl>
        </section>
      </div>

      <section class="a-panel" aria-labelledby="items-h">
        <h2 id="items-h" class="a-h2">Бараа</h2>
        <Table label="Захиалгын бараа" head={["Бараа", "мл", "Тоо", "Нэгж үнэ", "Дүн"]}>
          {o.items.map((i) => (
            <tr>
              <td>{[i.brand, i.name].filter(Boolean).join(" — ") || i.sku || i.slug}<div class="a-mono a-small a-dim">{i.sku ?? i.slug}</div></td>
              <td class="a-mono">{i.ml ?? "—"}</td>
              <td class="a-mono">{i.qty}</td>
              <td class="a-mono">{money(i.price)}</td>
              <td class="a-mono">{i.price !== undefined ? money(i.price * i.qty) : "—"}</td>
            </tr>
          ))}
        </Table>
      </section>

      <section class="a-panel" aria-labelledby="pay-h">
        <h2 id="pay-h" class="a-h2">Төлбөр</h2>
        {payments.length ? (
          <Table label="Төлбөрүүд" head={["#", "Арга", "Дүн", "Төлсөн", "Төлөв", "Лавлах", "Огноо"]}>
            {payments.map((p: ReturnType<typeof paymentView>) => (
              <tr>
                <td class="a-mono">{p.id}</td>
                <td>{PROVIDER[p.provider] ?? p.provider}</td>
                <td class="a-mono">{money(p.amount)}</td>
                <td class="a-mono">{money(p.paidAmount)}</td>
                <td><Badge value={p.status} labels={PAYMENT_STATUS} tone={`pay-${p.status}`} /></td>
                <td class="a-mono a-small a-break">{p.providerRef || "—"}</td>
                <td class="a-mono a-small">{when(p.paidAt || p.createdAt)}</td>
              </tr>
            ))}
          </Table>
        ) : <p class="a-dim">Төлбөрийн мөр алга.</p>}
      </section>

      {reservations && (
        <section class="a-panel" aria-labelledby="res-h">
          <h2 id="res-h" class="a-h2">Нөөцлөлт</h2>
          <Table label="Нөөцлөлт" head={["SKU", "Тоо", "Хянадаг", "Төлөв"]}>
            {reservations.map((r) => (
              <tr>
                <td class="a-mono">{pick(r, "sku", "skuId", "sku_id")}</td>
                <td class="a-mono">{pick(r, "qty")}</td>
                <td>{pick(r, "tracked") ? "Тийм" : "Үгүй"}</td>
                <td>{({ held: "Нөөцлөгдсөн", committed: "Хасагдсан", released: "Суллагдсан" } as Record<string, string>)[pick(r, "status")] ?? pick(r, "status")}</td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {shipments.length > 0 && (
        <section class="a-panel" aria-labelledby="ship-h">
          <h2 id="ship-h" class="a-h2">Хүргэлт</h2>
          <ul class="a-list">
            {shipments.map((s) => (
              <li>{can("delivery.read") ? <a href={`#/shipments/${s.id}`}>#{s.id}</a> : `#${s.id}`} · {PROVIDER[s.provider] ?? s.provider} · <Badge value={s.status} labels={SHIPMENT_STATUS} />{s.trackingNo && <> · <span class="a-mono">{s.trackingNo}</span></>}</li>
            ))}
          </ul>
        </section>
      )}

      <section class="a-panel" aria-labelledby="ev-h">
        <h2 id="ev-h" class="a-h2">Төлвийн түүх</h2>
        {events.length ? (
          <ol class="a-timeline">
            {events.map((e) => {
              const from = pick(e, "fromStatus", "from_status");
              const to = pick(e, "toStatus", "to_status");
              return (
                <li>
                  <span class="a-mono a-small">{when(pick(e, "at"))}</span>{" "}
                  {from ? `${ORDER_STATUS[from] ?? from} → ` : ""}<b>{ORDER_STATUS[to] ?? to}</b>
                  <span class="a-dim a-small"> · {pick(e, "actor")}</span>
                  {pick(e, "note") && <div class="a-small">“{pick(e, "note")}”</div>}
                </li>
              );
            })}
          </ol>
        ) : <p class="a-dim">Түүх алга.</p>}
      </section>
      <p><button type="button" class="a-btn a-btn--ghost" onClick={() => go("#/orders")}>‹ Жагсаалт руу</button></p>
    </section>
  );
}

function MarkPaid({ no, total, onDone }: { no: string; total: number; onDone: (msg: string) => Promise<void> }) {
  const [amount, setAmount] = useState(String(total || ""));
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const msg = useMsg();
  async function submit(e: Event) {
    e.preventDefault();
    const a = intOrNull(amount);
    if (a === null || Number.isNaN(a) || a <= 0) { msg.err("Дүн: эерэг бүхэл тоо (₮)."); return; }
    if (!reference.trim()) { msg.err("Гүйлгээний утга / лавлах дугаар оруулна уу."); return; }
    setBusy(true);
    const res = await api(`/api/admin/orders/${enc(no)}/mark-paid`, { method: "POST", body: { amount: a, reference: reference.trim() }, conflict: "захиалга төлбөр хүлээх төлөвт биш байна (цуцлагдсан эсвэл аль хэдийн төлөгдсөн)." });
    setBusy(false);
    if (res.ok) { msg.clear(); await onDone(`Банкны төлбөр бүртгэгдлээ: ${money(a)}.`); } else msg.err(res.error);
  }
  return (
    <form class="a-addsku" onSubmit={submit} data-testid="mark-paid">
      <h3 class="a-h3">Банкны шилжүүлгээр төлөгдсөн гэж тэмдэглэх</h3>
      <Field label="Дүн ₮"><input class="a-input" name="amount" inputMode="numeric" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} required /></Field>
      <Field label="Гүйлгээний утга / лавлах"><input class="a-input" name="reference" maxLength={120} value={reference} onInput={(e) => setReference(e.currentTarget.value)} required /></Field>
      <button class="a-btn a-btn--primary" type="submit" disabled={busy}>Төлбөр бүртгэх</button>
      {msg.node}
    </form>
  );
}
