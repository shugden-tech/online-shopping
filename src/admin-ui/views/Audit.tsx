// Audit log viewer (GET /api/admin/audit?entity=&entityId=&cursor=).
import { useState } from "preact/hooks";
import { qs } from "../api";
import { ACTION, ACTOR, ENTITY, when } from "../labels";
import { Empty, Field, Loading, Msg, Table, useKeyset } from "../ui";
import { Icon } from "../icons";

interface Row { id: number; at: string; actor: string; action: string; entity: string; entityId: string | null; data: unknown }

const KEY: Record<string, string> = {
  from: "өмнө", to: "болсон", status: "төлөв", price: "үнэ", compareAt: "хуучин үнэ", active: "идэвхтэй", kind: "төрөл", reason: "шалтгаан",
  delta: "өөрчлөлт", set: "тоо", total: "дүн", amount: "дүн", payment: "төлбөр", provider: "үйлчилгээ", trackingNo: "хяналтын дугаар", fee: "зардал",
  courier: "хүргэгч", saleLocked: "түгжсэн", imageFront: "урд зураг", imageBack: "ар зураг", bulk: "бөөнөөр", url: "хаяг", events: "үйл явдал",
  name: "нэр", brand: "брэнд", fromStatus: "өмнөх төлөв", side: "тал", bytes: "файлын хэмжээ", orderNo: "захиалга", source: "эх үүсвэр",
};

/** Turns an audit row's JSON into "key: value · key: value" (long or nested values are shortened). */
function summary(d: unknown): string {
  if (d === null || d === undefined) return "";
  if (typeof d !== "object") return String(d);
  return Object.entries(d as Record<string, unknown>)
    .filter(([k, v]) => v !== undefined && k !== "before")
    .map(([k, v]) => {
      let s = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
      if (s.length > 60) s = s.slice(0, 57) + "…";
      return `${KEY[k] ?? k}: ${s}`;
    })
    .join(" · ");
}

function link(r: Row) {
  if (!r.entityId) return "—";
  if (r.entity === "order") return <a href={`#/orders/${encodeURIComponent(r.entityId)}`}>{r.entityId}</a>;
  if (r.entity === "product") return <a href={`#/products/${encodeURIComponent(r.entityId)}`}>{r.entityId}</a>;
  if (r.entity === "sku") return <a href={`#/products/${encodeURIComponent(r.entityId.split(":")[0]!)}`}>{r.entityId}</a>;
  if (r.entity === "shipment") return <a href={`#/shipments/${encodeURIComponent(r.entityId)}`}>#{r.entityId}</a>;
  return r.entityId;
}

export default function Audit(props: { entity?: string; entityId?: string }) {
  const [f, setF] = useState({ entity: props.entity ?? "", entityId: props.entityId ?? "" });
  const [idDraft, setIdDraft] = useState(f.entityId);
  const list = useKeyset<Row>((cursor) => `/api/admin/audit${qs({ entity: f.entity, entityId: f.entityId, cursor, limit: 50 })}`, [f.entity, f.entityId]);
  return (
    <section aria-labelledby="au-h">
      <h1 id="au-h" class="a-title">Үйлдлийн түүх</h1>
      <p class="a-dim a-small" style="margin-top:-8px">Хэн, хэзээ, юуг өөрчилсөн. Хэрэглэгчийн хувийн мэдээлэл энд хадгалагдахгүй.</p>
      <form class="a-filters" onSubmit={(e) => { e.preventDefault(); setF({ ...f, entityId: idDraft.trim() }); }}>
        <Field label="Төрөл">
          <select class="a-input" name="entity" value={f.entity} onChange={(e) => setF({ ...f, entity: e.currentTarget.value })}>
            <option value="">Бүгд</option>
            {Object.entries(ENTITY).map(([k, v]) => <option value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="ID (заавал биш)">
          <input class="a-input a-mono" name="entityId" value={idDraft} onInput={(e) => setIdDraft(e.currentTarget.value)} />
        </Field>
        <button class="a-btn" type="submit"><Icon name="filter" />Шүүх</button>
      </form>
      <Msg kind="err" text={list.error} />
      <Table label="Үйлдлийн түүх" head={["Огноо", "Хэн", "Үйлдэл", "Төрөл", "ID", "Өгөгдөл"]}>
        {list.items.map((r) => (
          <tr data-audit={r.id}>
            <td class="a-mono a-small">{when(r.at)}</td>
            <td class="a-small">{ACTOR[r.actor] ?? r.actor}</td>
            <td class="a-small">{ACTION[r.action] ?? r.action}</td>
            <td>{ENTITY[r.entity] ?? r.entity}</td>
            <td class="a-mono a-small a-break">{link(r)}</td>
            <td class="a-small">{summary(r.data)}</td>
          </tr>
        ))}
      </Table>
      <Loading on={list.loading} />
      <Empty show={!list.loading && !list.error && !list.items.length} text="Бичлэг алга." />
      {list.cursor !== null && <button type="button" class="a-btn" disabled={list.loading} onClick={list.more}><Icon name="more" />Цааш ачаалах</button>}
    </section>
  );
}
