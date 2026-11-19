// Delivery webhooks. tab=in: every call the delivery company made to /api/delivery/webhook/{provider}
// (payload, result, replay). tab=out: the owner's own endpoints (Telegram, Make, Zapier…): add, events,
// signed test event, delivery log with "send again".
import { useEffect, useState } from "preact/hooks";
import { WEBHOOK_EVENTS } from "../../lib/contracts";
import { api, qs } from "../api";
import { when } from "../labels";
import { Badge, ConfirmButton, Empty, Field, Loading, Msg, Table, useKeyset, useMsg, useSession } from "../ui";
import { DeliveryTabs } from "./Shipments";

const EVENT_LABEL: Record<string, string> = {
  "order.created": "Шинэ захиалга",
  "order.paid": "Захиалга төлөгдсөн",
  "order.cancelled": "Захиалга цуцлагдсан",
  "shipment.updated": "Хүргэлтийн төлөв өөрчлөгдсөн",
  ping: "Туршилт",
};
const HOOK_STATUS: Record<string, string> = { pending: "Хүлээгдэж буй", delivered: "Хүргэгдсэн", failed: "Амжилтгүй" };

function pretty(s: string | null | undefined): string {
  if (!s) return "";
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

export default function Webhooks(props: { tab?: string }) {
  const tab = props.tab === "out" ? "out" : "in";
  return (
    <section aria-labelledby="wh-h">
      <h1 id="wh-h" class="a-title">Хүргэлт · Webhook</h1>
      <DeliveryTabs current={tab} />
      {tab === "in" ? <Inbound /> : <Outbound />}
    </section>
  );
}

/* ---------------- inbound ---------------- */

function Inbound() {
  const { can } = useSession();
  const list = useKeyset((cursor) => `/api/admin/webhooks/inbound${qs({ cursor, limit: 30 })}`, []);
  const [open, setOpen] = useState<number | null>(null);
  const msg = useMsg();
  async function replay(id: number) {
    const r = await api(`/api/admin/webhooks/inbound/${id}/replay`, { method: "POST" });
    if (r.ok) { msg.ok(`#${id} дахин боловсрууллаа (HTTP ${r.data.httpStatus}).`); list.reload(); } else msg.err(r.error);
  }
  return (
    <>
      <aside class="a-panel a-panel--gold">
        <h2 class="a-h2">Хүргэлтийн компаниас ирэх дуудлага</h2>
        <p class="a-small a-dim" style="margin:0">
          Хаяг: <code class="a-kbd">{location.origin}/api/delivery/webhook/&lt;компани&gt;</code>. Дуудлага бүр
          <code class="a-kbd">X-Signature</code> толгойд HMAC-SHA256 гарын үсэгтэй байх ёстой (нууц түлхүүр: <code class="a-kbd">DELIVERY_WEBHOOK_SECRET</code>).
          Нэг үйл явдлыг дахин илгээвэл давхардуулж бүртгэхгүй. Хүргэлтийн компани сонгогдоогүй үед энд юу ч ирэхгүй.
        </p>
      </aside>
      {msg.node}
      <Msg kind="err" text={list.error} />
      <Table label="Ирсэн webhook" head={["#", "Хүлээн авсан", "Компани", "Гарын үсэг", "HTTP", "Үйл явдал", ""]}>
        {list.items.map((r: any) => (
          <>
            <tr data-inbound={r.id}>
              <td class="a-mono">{r.id}</td>
              <td class="a-mono a-small">{when(r.receivedAt)}</td>
              <td class="a-mono">{r.provider}</td>
              <td>{r.signatureOk ? <Badge value="ok" tone="active" labels={{ ok: "Зөв" }} /> : <Badge value="bad" tone="failed" labels={{ bad: "Буруу" }} />}</td>
              <td class="a-mono">{r.httpStatus}</td>
              <td class="a-mono a-small a-break">{r.eventIds || "—"}{r.replayCount ? <div class="a-dim">дахин: {r.replayCount}</div> : null}</td>
              <td>
                <div class="a-row a-row--tight">
                  <button type="button" class="a-btn a-btn--sm" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>Дэлгэрэнгүй</button>
                  {can("delivery.write") && r.signatureOk && <button type="button" class="a-btn a-btn--sm" data-testid="replay" onClick={() => replay(r.id)}>Дахин боловсруулах</button>}
                </div>
              </td>
            </tr>
            {open === r.id && (
              <tr><td colSpan={7}>
                <div class="a-two">
                  <div><h3 class="a-h3">Ирсэн өгөгдөл</h3><code class="a-code">{pretty(r.payload) || "—"}</code></div>
                  <div><h3 class="a-h3">Үр дүн</h3><code class="a-code">{pretty(r.result) || "—"}</code></div>
                </div>
              </td></tr>
            )}
          </>
        ))}
      </Table>
      <Loading on={list.loading} />
      <Empty show={!list.loading && !list.error && !list.items.length} text="Одоогоор ирсэн webhook алга." />
      {list.cursor !== null && <p><button type="button" class="a-btn" onClick={list.more}>Цааш ачаалах</button></p>}
    </>
  );
}

/* ---------------- outbound ---------------- */

interface Endpoint { id: number; url: string; description: string | null; events: string[]; active: boolean; failed: number; pending: number; lastDeliveredAt: string | null }

function Outbound() {
  const { can } = useSession();
  const canWrite = can("settings.write");
  const [eps, setEps] = useState<Endpoint[] | null>(null);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState<{ id: number; secret: string } | null>(null);
  const [form, setForm] = useState({ url: "", description: "", events: ["order.created", "order.paid"] as string[] });
  const [busy, setBusy] = useState(false);
  const [logFor, setLogFor] = useState<number | 0>(0);
  const msg = useMsg();

  async function load() {
    const r = await api<{ items: Endpoint[] }>("/api/admin/webhooks/endpoints");
    if (r.ok) { setEps(r.data.items); setError(""); } else setError(r.error);
  }
  useEffect(() => { load(); }, []);

  async function add(e: Event) {
    e.preventDefault();
    if (!/^https:\/\//.test(form.url.trim())) { msg.err("Хаяг https:// -ээр эхэлсэн байх ёстой."); return; }
    if (!form.events.length) { msg.err("Дор хаяж нэг үйл явдал сонгоно уу."); return; }
    setBusy(true);
    const r = await api<{ endpoint: Endpoint; secret: string }>("/api/admin/webhooks/endpoints", { method: "POST", body: { url: form.url.trim(), events: form.events, description: form.description.trim() || null } });
    setBusy(false);
    if (r.ok) { setSecret({ id: r.data.endpoint.id, secret: r.data.secret }); setForm({ url: "", description: "", events: form.events }); msg.clear(); load(); } else msg.err(r.error);
  }
  async function patch(id: number, body: Record<string, unknown>) {
    const r = await api(`/api/admin/webhooks/endpoints/${id}`, { method: "PATCH", body });
    if (r.ok) load(); else msg.err(r.error);
  }
  async function del(id: number) {
    const r = await api(`/api/admin/webhooks/endpoints/${id}`, { method: "DELETE" });
    if (r.ok) { msg.ok("Устгалаа."); load(); } else msg.err(r.error);
  }
  async function test(id: number) {
    msg.info("Туршилтын үйл явдал илгээж байна…");
    const r = await api(`/api/admin/webhooks/endpoints/${id}/test`, { method: "POST" });
    if (!r.ok) { msg.err(r.error); return; }
    const d = r.data.delivery;
    if (d.status === "delivered") msg.ok(`Амжилттай: таны сервер HTTP ${d.httpStatus} хариу өглөө.`);
    else msg.err(`Хүргэгдсэнгүй (${d.httpStatus ? `HTTP ${d.httpStatus}` : d.error === "timeout" ? "хугацаа хэтэрсэн" : "холбогдож чадсангүй"}). Автоматаар дахин оролдоно.`);
    load();
    setLogFor(id);
  }
  const toggleEvent = (ev: string) => setForm({ ...form, events: form.events.includes(ev) ? form.events.filter((x) => x !== ev) : [...form.events, ev] });

  return (
    <>
      <aside class="a-panel a-panel--gold">
        <h2 class="a-h2">Өөрийн системд мэдэгдэл илгээх</h2>
        <p class="a-small a-dim" style="margin:0 0 6px">
          Захиалга, төлбөр, хүргэлтийн үйл явдлыг таны Telegram бот, Make, Zapier зэрэг хаяг руу JSON-оор (POST) илгээнэ.
          Хүсэлт бүр <code class="a-kbd">X-Genzst-Signature: sha256=…</code> гарын үсэгтэй: түлхүүр нь энэ хаягийн нууц утга, гарын үсэг зурах өгөгдөл нь <code class="a-kbd">цагийн тэмдэг.бие</code>
          (<code class="a-kbd">X-Genzst-Timestamp</code>). 2xx хариу өгөхгүй бол 8 хүртэл удаа, завсарлагааг уртасган дахин илгээнэ.
        </p>
        <p class="a-small a-dim" style="margin:0">Хувийн нууцлалын үүднээс хэрэглэгчийн нэр, утас, хаяг илгээгдэхгүй: зөвхөн захиалгын дугаар, төлөв, дүн, бараа.</p>
      </aside>

      {secret && (
        <div class="a-msg a-msg--info" role="alert" data-testid="secret-once">
          <b>Нууц түлхүүр (зөвхөн одоо харагдана):</b> <code class="a-mono a-break" style="user-select:all">{secret.secret}</code>
          <div class="a-row" style="margin-top:8px">
            <button type="button" class="a-btn a-btn--sm" onClick={() => navigator.clipboard?.writeText(secret.secret).then(() => msg.ok("Хууллаа."), () => {})}>Хуулах</button>
            <button type="button" class="a-btn a-btn--sm a-btn--ghost" onClick={() => setSecret(null)}>Хадгалсан, хаах</button>
          </div>
        </div>
      )}
      {msg.node}
      <Msg kind="err" text={error} />
      <Loading on={!eps && !error} />
      {eps && (eps.length ? (
        <Table label="Webhook хаягууд" head={["Хаяг", "Үйл явдал", "Төлөв", "Сүүлд хүргэсэн", ""]}>
          {eps.map((ep) => (
            <tr data-endpoint={ep.id}>
              <td class="a-break"><span class="a-mono a-small">{ep.url}</span>{ep.description && <div class="a-small a-dim">{ep.description}</div>}</td>
              <td class="a-small">{ep.events.map((e) => EVENT_LABEL[e] ?? e).join(", ")}</td>
              <td>
                <Badge value={ep.active ? "on" : "off"} tone={ep.active ? "active" : "hidden"} labels={{ on: "Идэвхтэй", off: "Унтраасан" }} />
                {ep.failed > 0 && <div class="a-small a-warn">{ep.failed} амжилтгүй</div>}
                {ep.pending > 0 && <div class="a-small a-dim">{ep.pending} хүлээгдэж буй</div>}
              </td>
              <td class="a-mono a-small">{when(ep.lastDeliveredAt)}</td>
              <td>
                <div class="a-row a-row--tight" style="flex-wrap:wrap">
                  {canWrite && <button type="button" class="a-btn a-btn--sm" data-testid="hook-test" onClick={() => test(ep.id)}>Туршилт илгээх</button>}
                  <button type="button" class="a-btn a-btn--sm" aria-expanded={logFor === ep.id} onClick={() => setLogFor(logFor === ep.id ? 0 : ep.id)}>Лог</button>
                  {canWrite && <button type="button" class="a-btn a-btn--sm" onClick={() => patch(ep.id, { active: !ep.active })}>{ep.active ? "Унтраах" : "Асаах"}</button>}
                  {canWrite && <ConfirmButton label="Устгах" danger question="Энэ хаяг болон түүний логийг устгах уу?" confirmLabel="Тийм, устгах" onConfirm={() => del(ep.id)} />}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      ) : <p class="a-dim a-empty">Webhook хаяг нэмээгүй байна.</p>)}

      {logFor ? <Deliveries endpoint={logFor} canWrite={canWrite} /> : null}

      {canWrite && (
        <form class="a-panel" onSubmit={add} data-testid="hook-form" style="margin-top:16px">
          <h2 class="a-h2">Шинэ хаяг нэмэх</h2>
          <div class="a-grid">
            <Field label="Хаяг (https://…)" wide><input class="a-input" type="url" name="url" required value={form.url} onInput={(e) => setForm({ ...form, url: e.currentTarget.value })} placeholder="https://hook.make.com/…" /></Field>
            <Field label="Тайлбар (заавал биш)" wide><input class="a-input" name="description" maxLength={120} value={form.description} onInput={(e) => setForm({ ...form, description: e.currentTarget.value })} placeholder="ж: Telegram мэдэгдэл" /></Field>
            <div class="a-field a-field--wide" role="group" aria-label="Үйл явдал">
              <span class="a-field__label">Үйл явдал</span>
              <div class="a-row">
                {WEBHOOK_EVENTS.map((ev) => (
                  <label class="a-check"><input type="checkbox" checked={form.events.includes(ev)} onChange={() => toggleEvent(ev)} /> {EVENT_LABEL[ev]} <span class="a-mono a-small a-dim">{ev}</span></label>
                ))}
              </div>
            </div>
          </div>
          <button class="a-btn a-btn--primary" type="submit" disabled={busy}>Нэмэх</button>
        </form>
      )}
    </>
  );
}

function Deliveries({ endpoint, canWrite }: { endpoint: number; canWrite: boolean }) {
  const list = useKeyset((cursor) => `/api/admin/webhooks/deliveries${qs({ endpoint, cursor, limit: 20 })}`, [endpoint]);
  const [open, setOpen] = useState<number | null>(null);
  const msg = useMsg();
  async function again(id: number) {
    const r = await api(`/api/admin/webhooks/deliveries/${id}`, { method: "POST" });
    if (!r.ok) { msg.err(r.error); return; }
    const d = r.data.delivery;
    if (d.status === "delivered") msg.ok(`#${id} хүргэгдлээ (HTTP ${d.httpStatus}).`); else msg.err(`#${id} хүргэгдсэнгүй (${d.httpStatus ? `HTTP ${d.httpStatus}` : d.error}).`);
    list.reload();
  }
  return (
    <section class="a-panel" aria-label="Илгээлтийн лог" data-testid="hook-log">
      <h3 class="a-h3">Илгээлтийн лог</h3>
      {msg.node}
      <Msg kind="err" text={list.error} />
      <Table label="Илгээлтийн лог" head={["#", "Үүссэн", "Үйл явдал", "Төлөв", "Оролдлого", "Сүүлийн хариу", ""]}>
        {list.items.map((d: any) => (
          <>
            <tr>
              <td class="a-mono">{d.id}</td>
              <td class="a-mono a-small">{when(d.createdAt)}</td>
              <td class="a-small">{EVENT_LABEL[d.event] ?? d.event}</td>
              <td><Badge value={d.status} labels={HOOK_STATUS} tone={`hook-${d.status}`} />{d.status === "pending" && d.nextRetryAt && <div class="a-small a-dim">дараагийнх {when(d.nextRetryAt)}</div>}</td>
              <td class="a-mono">{d.attempts}</td>
              <td class="a-mono a-small">{d.lastStatus ?? "—"}{d.lastError ? ` · ${d.lastError}` : ""}</td>
              <td><div class="a-row a-row--tight">
                <button type="button" class="a-btn a-btn--sm" aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? null : d.id)}>Өгөгдөл</button>
                {canWrite && d.status !== "delivered" && <button type="button" class="a-btn a-btn--sm" onClick={() => again(d.id)}>Дахин илгээх</button>}
              </div></td>
            </tr>
            {open === d.id && <tr><td colSpan={7}><code class="a-code">{pretty(d.payload)}</code></td></tr>}
          </>
        ))}
      </Table>
      <Loading on={list.loading} />
      <Empty show={!list.loading && !list.error && !list.items.length} text="Илгээлт алга." />
      {list.cursor !== null && <p><button type="button" class="a-btn" onClick={list.more}>Цааш ачаалах</button></p>}
    </section>
  );
}
