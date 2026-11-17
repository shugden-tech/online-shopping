// Audit log viewer (GET /api/admin/audit?entity=&entityId=&cursor=).
import { useState } from "preact/hooks";
import { qs } from "../api";
import { ENTITY, when } from "../labels";
import { Empty, Field, Loading, Msg, Table, useKeyset } from "../ui";

interface Row { id: number; at: string; actor: string; action: string; entity: string; entityId: string | null; data: unknown }

export default function Audit(props: { entity?: string; entityId?: string }) {
  const [f, setF] = useState({ entity: props.entity ?? "", entityId: props.entityId ?? "" });
  const [idDraft, setIdDraft] = useState(f.entityId);
  const list = useKeyset<Row>((cursor) => `/api/admin/audit${qs({ entity: f.entity, entityId: f.entityId, cursor, limit: 50 })}`, [f.entity, f.entityId]);
  return (
    <section aria-labelledby="au-h">
      <h1 id="au-h" class="a-title">Үйлдлийн түүх</h1>
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
        <button class="a-btn" type="submit">Шүүх</button>
      </form>
      <Msg kind="err" text={list.error} />
      <Table label="Үйлдлийн түүх" head={["Огноо", "Хэн", "Үйлдэл", "Төрөл", "ID", "Өгөгдөл"]}>
        {list.items.map((r) => (
          <tr data-audit={r.id}>
            <td class="a-mono a-small">{when(r.at)}</td>
            <td class="a-small">{r.actor}</td>
            <td class="a-mono a-small">{r.action}</td>
            <td>{ENTITY[r.entity] ?? r.entity}</td>
            <td class="a-mono a-small a-break">{r.entityId ?? "—"}</td>
            <td><code class="a-code">{r.data === null || r.data === undefined ? "" : JSON.stringify(r.data)}</code></td>
          </tr>
        ))}
      </Table>
      <Loading on={list.loading} />
      <Empty show={!list.loading && !list.error && !list.items.length} text="Бичлэг алга." />
      {list.cursor !== null && <button type="button" class="a-btn" disabled={list.loading} onClick={list.more}>Цааш ачаалах</button>}
    </section>
  );
}
