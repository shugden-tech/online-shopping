// Customer accounts (owner only): read-only list + "reset password" for the forgot-password phone call
// (GET /api/admin/customers, POST /api/admin/customers/{id}/reset-password; docs/CONTRACTS.md §10).
import { useState } from "preact/hooks";
import { api, qs } from "../api";
import { when } from "../labels";
import { ConfirmButton, Empty, Field, Loading, Msg, Table, useKeyset, useMsg } from "../ui";
import { Icon } from "../icons";

interface Row {
  id: number; phone: string | null; name: string; email: string | null; google: boolean; hasPassword: boolean;
  mustChangePassword: boolean; orders: number; createdAt: string; lastSeen: string | null; deleted: boolean;
}

export default function Customers() {
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState("");
  const [temp, setTemp] = useState<{ id: number; pw: string } | null>(null);
  const list = useKeyset<Row>((cursor) => `/api/admin/customers${qs({ q, cursor, limit: 50 })}`, [q]);
  const msg = useMsg();
  async function reset(id: number) {
    const r = await api(`/api/admin/customers/${id}/reset-password`, { method: "POST" });
    if (!r.ok) { msg.err(r.error); return; }
    setTemp({ id, pw: r.data.tempPassword });
    msg.ok("Түр нууц үг үүслээ. Хэрэглэгчид утсаар хэлнэ үү — дахин харагдахгүй.");
    list.reload();
  }
  return (
    <section aria-labelledby="cu-h">
      <h1 id="cu-h" class="a-title">Хэрэглэгчид</h1>
      <p class="a-dim a-small" style="margin-top:-8px">
        Нууц үгээ мартсан хэрэглэгч утсаар холбогдоход эхлээд хэн болохыг нь шалгаад (захиалгын дугаар, нэр), “Нууц үг сэргээх” дарна.
        Түр нууц үгээр нэвтэрсний дараа сайт шинэ нууц үг тохируулахыг шаардана. Бүх төхөөрөмжөөс гаргана.
      </p>
      <form class="a-filters" onSubmit={(e) => { e.preventDefault(); setQ(draft.trim()); }}>
        <Field label="Утас эсвэл нэр">
          <input class="a-input" name="q" value={draft} onInput={(e) => setDraft(e.currentTarget.value)} />
        </Field>
        <button class="a-btn" type="submit"><Icon name="search" />Хайх</button>
      </form>
      {msg.node}
      {temp && (
        <p class="a-msg a-msg--ok" data-testid="temp-password">
          #{temp.id} түр нууц үг: <strong class="a-mono">{temp.pw}</strong>
        </p>
      )}
      <Msg kind="err" text={list.error} />
      <Table label="Хэрэглэгчид" head={["#", "Утас", "Нэр", "Нэвтрэх", "Захиалга", "Бүртгүүлсэн", "Сүүлд", ""]}>
        {list.items.map((c) => (
          <tr data-customer={c.id}>
            <td class="a-mono">{c.id}</td>
            <td class="a-mono">{c.deleted ? "устгасан" : c.phone ?? "—"}</td>
            <td>{c.name || "—"}{c.email ? <div class="a-dim a-small">{c.email}</div> : null}</td>
            <td class="a-small">{[c.hasPassword ? "нууц үг" : "", c.google ? "Google" : ""].filter(Boolean).join(" · ") || "—"}{c.mustChangePassword ? <div class="a-dim a-small">түр нууц үг</div> : null}</td>
            <td class="a-mono">{c.orders}</td>
            <td class="a-mono a-small">{when(c.createdAt)}</td>
            <td class="a-mono a-small">{c.lastSeen ? when(c.lastSeen) : "—"}</td>
            <td>{!c.deleted && c.phone && (
              <ConfirmButton label="Нууц үг сэргээх" question={`#${c.id} (${c.phone})-ийн нууц үгийг түр нууц үгээр солих уу?`} confirmLabel="Солих" onConfirm={() => void reset(c.id)} testid={`reset-${c.id}`} />
            )}</td>
          </tr>
        ))}
      </Table>
      <Loading on={list.loading} />
      <Empty show={!list.loading && !list.error && !list.items.length} text="Хэрэглэгч алга." />
      {list.cursor !== null && <button type="button" class="a-btn" disabled={list.loading} onClick={list.more}><Icon name="more" />Цааш ачаалах</button>}
    </section>
  );
}
