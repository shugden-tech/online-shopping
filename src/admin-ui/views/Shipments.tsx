// Shipments list (GET /api/admin/shipments?status=&cursor=).
import { useState } from "preact/hooks";
import { SHIPMENT_STATUSES } from "../../lib/contracts";
import { enc, qs, shipmentView } from "../api";
import { PROVIDER, SHIPMENT_STATUS, when } from "../labels";
import { Badge, Empty, Field, Loading, Msg, Table, useKeyset } from "../ui";

export default function Shipments(props: { status?: string }) {
  const [status, setStatus] = useState(props.status ?? "");
  const list = useKeyset((cursor) => `/api/admin/shipments${qs({ status, cursor, limit: 50 })}`, [status], shipmentView);
  return (
    <section aria-labelledby="sh-h">
      <h1 id="sh-h" class="a-title">Хүргэлт</h1>
      <div class="a-filters">
        <Field label="Төлөв">
          <select class="a-input" value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
            <option value="">Бүгд</option>
            {SHIPMENT_STATUSES.map((s) => <option value={s}>{SHIPMENT_STATUS[s]}</option>)}
          </select>
        </Field>
        <button type="button" class="a-btn a-btn--ghost" onClick={list.reload}>Сэргээх</button>
      </div>
      <Msg kind="err" text={list.error} />
      <Table label="Хүргэлтийн жагсаалт" head={["#", "Захиалга", "Компани", "Төлөв", "Трак", "Оролдлого", "Шинэчилсэн"]}>
        {list.items.map((s) => (
          <tr data-shipment={s.id}>
            <td class="a-mono"><a href={`#/shipments/${enc(String(s.id))}`}>#{s.id}</a></td>
            <td class="a-mono">{s.orderNo || "—"}</td>
            <td>{PROVIDER[s.provider] ?? s.provider}</td>
            <td><Badge value={s.status} labels={SHIPMENT_STATUS} />{s.lastError && s.status === "failed" && <div class="a-small a-warn">{s.lastError}</div>}</td>
            <td class="a-mono a-small">{s.trackingNo || "—"}</td>
            <td class="a-mono">{s.attempts}</td>
            <td class="a-mono a-small">{when(s.updatedAt || s.createdAt)}</td>
          </tr>
        ))}
      </Table>
      <Loading on={list.loading} />
      <Empty show={!list.loading && !list.error && !list.items.length} text="Хүргэлт алга." />
      {list.cursor !== null && <button type="button" class="a-btn" disabled={list.loading} onClick={list.more}>Цааш ачаалах</button>}
    </section>
  );
}
