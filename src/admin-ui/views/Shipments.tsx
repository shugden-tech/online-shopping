// Shipments list (GET /api/admin/shipments?status=&cursor=) + the delivery section's tabs.
import { useState } from "preact/hooks";
import { SHIPMENT_STATUSES } from "../../lib/contracts";
import { enc, qs, shipmentView } from "../api";
import { PROVIDER, SHIPMENT_STATUS, money, when } from "../labels";
import { Badge, Empty, Field, Loading, Msg, Table, go, useKeyset, useSession } from "../ui";
import { Icon } from "../icons";

/** Tabs shared by the delivery section (shipments, inbound webhook log, outbound webhooks). */
export function DeliveryTabs({ current }: { current: "list" | "in" | "out" }) {
  const { can } = useSession();
  return (
    <nav class="a-segs" aria-label="Хүргэлтийн хэсэг" style="margin-bottom:14px">
      <a href="#/shipments" aria-current={current === "list" ? "page" : undefined}><Icon name="shipments" />Хүргэлтүүд</a>
      <a href="#/webhooks?tab=in" aria-current={current === "in" ? "page" : undefined}><Icon name="webhook" />Ирсэн webhook</a>
      {can("settings.read") && <a href="#/webhooks?tab=out" aria-current={current === "out" ? "page" : undefined}><Icon name="webhook" />Илгээх webhook</a>}
    </nav>
  );
}

export default function Shipments(props: { status?: string }) {
  const [status, setStatus] = useState(props.status ?? "");
  const list = useKeyset((cursor) => `/api/admin/shipments${qs({ status, cursor, limit: 50 })}`, [status], shipmentView);
  return (
    <section aria-labelledby="sh-h">
      <h1 id="sh-h" class="a-title">Хүргэлт</h1>
      <DeliveryTabs current="list" />
      <div class="a-filters">
        <Field label="Төлөв">
          <select class="a-input" value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
            <option value="">Бүгд</option>
            {SHIPMENT_STATUSES.map((s) => <option value={s}>{SHIPMENT_STATUS[s]}</option>)}
          </select>
        </Field>
        <button type="button" class="a-btn a-btn--ghost" onClick={list.reload}><Icon name="refresh" />Шинэчлэх</button>
      </div>
      <p class="a-dim a-small">Хүргэлтийг захиалгын хуудаснаас үүсгэнэ (төлөгдсөн захиалга → “Хүргэлт үүсгэх”).</p>
      <Msg kind="err" text={list.error} />
      <Table label="Хүргэлтийн жагсаалт" head={["#", "Захиалга", "Хүргэгч", "Төлөв", "Хяналт", "Зардал", "Шинэчлэгдсэн"]}>
        {list.items.map((s) => (
          <tr data-shipment={s.id} data-href onClick={(e) => { if (!(e.target as Element).closest("a")) go(`#/shipments/${s.id}`); }}>
            <td class="a-mono"><a href={`#/shipments/${enc(String(s.id))}`}>#{s.id}</a></td>
            <td class="a-mono">{s.orderNo ? <a href={`#/orders/${enc(s.orderNo)}`}>{s.orderNo}</a> : "—"}</td>
            <td>{s.courier || (PROVIDER[s.provider] ?? s.provider)}{s.courier && <div class="a-small a-dim">{PROVIDER[s.provider] ?? s.provider}</div>}</td>
            <td><Badge value={s.status} labels={SHIPMENT_STATUS} />{s.lastError && s.status === "failed" && <div class="a-small a-warn">{s.lastError}</div>}</td>
            <td class="a-mono a-small">{s.trackingNo || "—"}</td>
            <td class="a-mono a-r">{s.fee === null ? "—" : money(s.fee)}</td>
            <td class="a-mono a-small">{when(s.updatedAt || s.createdAt)}</td>
          </tr>
        ))}
      </Table>
      <Loading on={list.loading} />
      <Empty show={!list.loading && !list.error && !list.items.length} text={status ? "Энэ төлөвтэй хүргэлт алга." : "Одоогоор хүргэлт алга."} />
      {list.cursor !== null && <p><button type="button" class="a-btn" disabled={list.loading} onClick={list.more}><Icon name="more" />Цааш ачаалах</button></p>}
    </section>
  );
}
