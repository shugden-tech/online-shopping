// Shipment detail: status changes per SHIPMENT_TRANSITIONS (manual provider), tracking no/url, retry when failed.
import { useEffect, useState } from "preact/hooks";
import { SHIPMENT_TRANSITIONS, type ShipmentStatus } from "../../lib/contracts";
import { api, enc, pick, shipmentView } from "../api";
import { PROVIDER, SHIPMENT_STATUS, when } from "../labels";
import { Badge, ConfirmButton, Field, Loading, Msg, useMsg, useSession } from "../ui";

export default function ShipmentDetail({ id }: { id: string }) {
  const { can } = useSession();
  const canWrite = can("delivery.write");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [track, setTrack] = useState({ trackingNo: "", trackingUrl: "", note: "" });
  const msg = useMsg();

  async function load() {
    const res = await api(`/api/admin/shipments/${enc(id)}`);
    if (!res.ok) { setError(res.error); return; }
    setData(res.data);
    const s = shipmentView(res.data.shipment ?? res.data);
    setTrack({ trackingNo: s.trackingNo, trackingUrl: s.trackingUrl, note: "" });
  }
  useEffect(() => { load(); }, [id]);

  if (error && !data) return <><p><a href="#/shipments">‹ Хүргэлт</a></p><Msg kind="err" text={error} /></>;
  if (!data) return <Loading on />;
  const s = shipmentView(data.shipment ?? data);
  const events: any[] = data.events ?? data.shipment?.events ?? [];
  const next = SHIPMENT_TRANSITIONS[s.status as ShipmentStatus] ?? [];

  async function patch(body: Record<string, unknown>, okText: string) {
    setBusy(true);
    const res = await api(`/api/admin/shipments/${enc(id)}`, { method: "PATCH", body, conflict: "хүргэлтийн төлөв өөрчлөгдсөн байна. Сэргээгээд дахин оролдоно уу." });
    setBusy(false);
    if (res.ok) { msg.ok(okText); await load(); } else msg.err(res.error);
  }
  async function retry() {
    setBusy(true);
    const res = await api(`/api/admin/shipments/${enc(id)}/retry`, { method: "POST", conflict: "зөвхөн амжилтгүй хүргэлтийг дахин оролдоно." });
    setBusy(false);
    if (res.ok) { msg.ok("Дахин илгээлээ."); await load(); } else msg.err(res.error);
  }
  const withNote = (b: Record<string, unknown>) => (track.note.trim() ? { ...b, note: track.note.trim() } : b);

  function saveTracking(e: Event) {
    e.preventDefault();
    const url = track.trackingUrl.trim();
    if (url && !/^https?:\/\//.test(url)) { msg.err("Трак холбоос http(s):// -ээр эхэлнэ."); return; }
    patch(withNote({ trackingNo: track.trackingNo.trim() || null, trackingUrl: url || null }), "Трак мэдээлэл хадгалагдлаа.");
  }

  return (
    <section aria-labelledby="sd-h" class="a-stack">
      <p><a href="#/shipments">‹ Хүргэлт</a></p>
      <h1 id="sd-h" class="a-title">Хүргэлт #{s.id}</h1>
      <div class="a-row">
        <Badge value={s.status} labels={SHIPMENT_STATUS} />
        <span class="a-small a-dim">{PROVIDER[s.provider] ?? s.provider} · захиалга {s.orderNo ? (can("orders.read") ? <a class="a-mono" href={`#/orders/${enc(s.orderNo)}`}>{s.orderNo}</a> : s.orderNo) : "—"}</span>
      </div>
      <dl class="a-dl a-panel">
        <dt>Компанийн дугаар</dt><dd class="a-mono">{s.providerRef || "—"}</dd>
        <dt>Трак</dt><dd class="a-mono">{s.trackingUrl ? <a href={s.trackingUrl} target="_blank" rel="noopener noreferrer">{s.trackingNo || s.trackingUrl}</a> : s.trackingNo || "—"}</dd>
        <dt>Оролдлого</dt><dd class="a-mono">{s.attempts}{s.nextRetryAt ? ` · дараагийнх ${when(s.nextRetryAt)}` : ""}</dd>
        {s.lastError && <><dt>Сүүлийн алдаа</dt><dd class="a-warn">{s.lastError}</dd></>}
        <dt>Үүссэн / шинэчилсэн</dt><dd class="a-mono a-small">{when(s.createdAt)} / {when(s.updatedAt)}</dd>
      </dl>

      {canWrite ? (
        <section class="a-panel" aria-labelledby="sa-h" data-testid="shipment-actions">
          <h2 id="sa-h" class="a-h2">Үйлдэл</h2>
          <form class="a-addsku" onSubmit={saveTracking}>
            <Field label="Трак дугаар"><input class="a-input" name="trackingNo" maxLength={120} value={track.trackingNo} onInput={(e) => setTrack({ ...track, trackingNo: e.currentTarget.value })} /></Field>
            <Field label="Трак холбоос"><input class="a-input" name="trackingUrl" type="url" value={track.trackingUrl} onInput={(e) => setTrack({ ...track, trackingUrl: e.currentTarget.value })} /></Field>
            <Field label="Тэмдэглэл (заавал биш)"><input class="a-input" name="note" maxLength={300} value={track.note} onInput={(e) => setTrack({ ...track, note: e.currentTarget.value })} /></Field>
            <button class="a-btn" type="submit" disabled={busy}>Трак хадгалах</button>
          </form>
          {next.length ? (
            <div class="a-row">
              <span class="a-small a-dim">Төлөв солих:</span>
              {next.map((to) =>
                s.status === "failed" && to === "pending" ? (
                  <button type="button" class="a-btn a-btn--primary" data-testid="retry" disabled={busy} onClick={retry}>Дахин оролдох</button>
                ) : to === "cancelled" ? (
                  <ConfirmButton testid="ship-cancel" label={SHIPMENT_STATUS.cancelled!} danger disabled={busy} question="Хүргэлтийг цуцлах уу?" confirmLabel="Тийм, цуцлах" onConfirm={() => patch(withNote({ status: to }), "Цуцлагдлаа.")} />
                ) : (
                  <button type="button" class="a-btn" data-to={to} disabled={busy} onClick={() => patch(withNote({ status: to }), `Төлөв: ${SHIPMENT_STATUS[to]}.`)}>{SHIPMENT_STATUS[to] ?? to}</button>
                ),
              )}
            </div>
          ) : <p class="a-dim">Эцсийн төлөв.</p>}
          {msg.node}
        </section>
      ) : <p class="a-dim">Таны эрхээр хүргэлт өөрчлөх боломжгүй.</p>}

      <section class="a-panel" aria-labelledby="se-h">
        <h2 id="se-h" class="a-h2">Түүх</h2>
        {events.length ? (
          <ol class="a-timeline">
            {events.map((e) => {
              const from = pick(e, "fromStatus", "from_status");
              const to = pick(e, "toStatus", "to_status");
              return (
                <li>
                  <span class="a-mono a-small">{when(pick(e, "at"))}</span>{" "}
                  {from ? `${SHIPMENT_STATUS[from] ?? from} → ` : ""}<b>{SHIPMENT_STATUS[to] ?? to}</b>
                  <span class="a-dim a-small"> · {pick(e, "source")}</span>
                  {pick(e, "note") && <div class="a-small">“{pick(e, "note")}”</div>}
                </li>
              );
            })}
          </ol>
        ) : <p class="a-dim">Түүх алга.</p>}
      </section>
    </section>
  );
}
