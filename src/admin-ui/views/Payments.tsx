// Payments list (GET /api/admin/payments?status=&provider=&cursor=).
import { useState } from "preact/hooks";
import { PAYMENT_PROVIDERS, PAYMENT_STATUSES } from "../../lib/contracts";
import { api, enc, paymentView, qs } from "../api";
import { PAYMENT_STATUS, PROVIDER, money, when } from "../labels";
import { Badge, Empty, Field, Loading, Msg, Table, useKeyset, useMsg, useSession } from "../ui";
import { Icon } from "../icons";

export default function Payments(props: { status?: string; provider?: string }) {
  const { can } = useSession();
  const [f, setF] = useState({ status: props.status ?? "", provider: props.provider ?? "" });
  const list = useKeyset((cursor) => `/api/admin/payments${qs({ status: f.status, provider: f.provider, cursor, limit: 50 })}`, [f.status, f.provider], paymentView);
  const msg = useMsg();
  async function check(id: number) {
    msg.info("QPay-ээс шалгаж байна…");
    const r = await api(`/api/admin/payments/${id}/check`, { method: "POST" });
    if (!r.ok) { msg.err(r.error); return; }
    msg.ok(r.data.paymentStatus === "paid" ? "Төлбөр орсон байна: захиалга төлөгдсөн боллоо." : "QPay дээр төлбөр хараахан ороогүй байна.");
    list.reload();
  }
  return (
    <section aria-labelledby="pay-h">
      <h1 id="pay-h" class="a-title">Төлбөр</h1>
      <div class="a-filters">
        <Field label="Төлөв">
          <select class="a-input" value={f.status} onChange={(e) => setF({ ...f, status: e.currentTarget.value })}>
            <option value="">Бүгд</option>
            {PAYMENT_STATUSES.map((s) => <option value={s}>{PAYMENT_STATUS[s]}</option>)}
          </select>
        </Field>
        <Field label="Арга">
          <select class="a-input" value={f.provider} onChange={(e) => setF({ ...f, provider: e.currentTarget.value })}>
            <option value="">Бүгд</option>
            {PAYMENT_PROVIDERS.map((p) => <option value={p}>{PROVIDER[p]}</option>)}
          </select>
        </Field>
        <button type="button" class="a-btn a-btn--ghost" onClick={list.reload}><Icon name="refresh" />Шинэчлэх</button>
      </div>
      <p class="a-dim a-small">Банкны шилжүүлгийг захиалгын хуудаснаас “Төлбөр бүртгэх”-ээр баталгаажуулна (дүн, гүйлгээний утга оруулна). QPay төлбөрийг автоматаар шалгадаг. Төлбөр орсон мэдээ ирээгүй бол “QPay шалгах” товчийг дарна уу.</p>
      {msg.node}
      <Msg kind="err" text={list.error} />
      <Table label="Төлбөрийн жагсаалт" head={["#", "Захиалга", "Арга", "Дүн", "Төлсөн", "Төлөв", "Лавлах", "Огноо", ""]}>
        {list.items.map((p) => (
          <tr data-payment={p.id}>
            <td class="a-mono">{p.id}</td>
            <td class="a-mono">{p.orderNo ? (can("orders.read") ? <a href={`#/orders/${enc(p.orderNo)}`}>{p.orderNo}</a> : p.orderNo) : "—"}</td>
            <td>{PROVIDER[p.provider] ?? p.provider}</td>
            <td class="a-mono">{money(p.amount)}</td>
            <td class="a-mono">{money(p.paidAmount)}</td>
            <td><Badge value={p.status} labels={PAYMENT_STATUS} tone={`pay-${p.status}`} /></td>
            <td class="a-mono a-small a-break">{p.providerRef || "—"}</td>
            <td class="a-mono a-small">{when(p.paidAt || p.createdAt)}</td>
            <td>
              {p.provider === "qpay" && p.status === "pending" && can("payments.write") && <button type="button" class="a-btn a-btn--sm" data-testid="qpay-check" onClick={() => check(p.id)}><Icon name="qr" />QPay шалгах</button>}
              {p.provider === "bank" && p.status === "pending" && can("payments.write") && p.orderNo && <a class="a-btn a-btn--sm" href={`#/orders/${enc(p.orderNo)}`}><Icon name="paid" />Төлбөр бүртгэх</a>}
            </td>
          </tr>
        ))}
      </Table>
      <Loading on={list.loading} />
      <Empty show={!list.loading && !list.error && !list.items.length} text="Төлбөр алга." />
      {list.cursor !== null && <button type="button" class="a-btn" disabled={list.loading} onClick={list.more}><Icon name="more" />Цааш ачаалах</button>}
    </section>
  );
}
