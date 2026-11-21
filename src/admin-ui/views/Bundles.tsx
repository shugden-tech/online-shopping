// Bundles list (0005): every bundle with its parts, price, status and whether it can be bought right now.
import type { BundleView } from "../../lib/bundles/types";
import { api, enc } from "../api";
import { PRODUCT_STATUS, money } from "../labels";
import { Badge, Empty, Msg, Table, go, useLoad, useSession } from "../ui";
import { Icon } from "../icons";

export const BLOCK: Record<string, string> = {
  hidden: "Дэлгүүрт харагдахгүй",
  soon: "Үнэ тавиагүй",
  off: "Бүрэлдэхүүнд худалдаалагдахгүй бараа байна",
  out: "Үлдэгдэл дууссан",
  closed: "Захиалга хаалттай",
};

export const partTitle = (p: BundleView["parts"][number]) =>
  p.name ? `${p.brand ?? ""} ${p.name}${p.concentration ? ` ${p.concentration}` : ""}`.trim() : (p.label ?? p.productId);

export default function Bundles() {
  const { can } = useSession();
  const list = useLoad<{ items: BundleView[] }>(() => api("/api/admin/bundles"), []);
  const items = list.data?.items ?? [];
  return (
    <section aria-labelledby="bun-h">
      <div class="a-row a-row--between">
        <h1 id="bun-h" class="a-title">Багц</h1>
        {can("catalog.write") && <a class="a-btn a-btn--primary" href="#/bundles/new" data-testid="new-bundle"><Icon name="add" />Шинэ багц</a>}
      </div>
      <p class="a-dim a-small">Багц нь хэд хэдэн хэмжээг (SKU) нэг үнээр зарна. Захиалахад бүрэлдэхүүн бүрийн үлдэгдэл нөөцлөгдөнө. Бүрэлдэхүүний аль нэг нь худалдаалагдахгүй эсвэл дууссан бол багц “Түр дууссан” гэж харагдана.</p>
      <Msg kind="err" text={list.error} />
      <p class="a-dim a-small" role="status">{list.loading ? "Ачаалж байна…" : list.data ? `Нийт ${items.length} багц` : ""}</p>
      <Table label="Багцын жагсаалт" head={["", "Багц", "Төлөв", "Үнэ", "Борлуулалт"]}>
        {items.map((b) => (
          <tr data-bundle={b.id} data-href onClick={(e) => { if (!(e.target as Element).closest("a,button")) go(`#/bundles/${enc(b.id)}`); }}>
            <td class="a-thumbcell">{b.image ? <img class="a-thumb" src={b.image} alt="" loading="lazy" width={42} height={42} /> : <span class="a-thumb a-thumb--none" aria-hidden="true" />}</td>
            <td>
              <a href={`#/bundles/${enc(b.id)}`}><b>{b.nameMn}</b>{b.nameEn ? <span class="a-dim"> · {b.nameEn}</span> : null}</a>
              <div class="a-dim a-small">{b.parts.map((p) => `${partTitle(p)} ${p.ml} мл${p.qty > 1 ? ` ×${p.qty}` : ""}`).join(" · ")}</div>
              <div class="a-dim a-mono a-small">{b.id} · эрэмбэ {b.sort}</div>
            </td>
            <td><Badge value={b.status} labels={PRODUCT_STATUS} /></td>
            <td class="a-mono">
              {b.price !== null ? money(b.price) : <span class="a-badge" data-s="nosale">Үнэ тавиагүй</span>}
              {b.compareAt !== null && <div class="a-dim a-small"><s>{money(b.compareAt)}</s></div>}
            </td>
            <td class="a-small">
              {b.sellable ? (
                <span class="a-badge" data-s="active">Зарагдаж байна{b.available !== null ? ` · ${b.available}` : ""}</span>
              ) : (
                <span class="a-badge" data-s="nosale">{BLOCK[b.block ?? "off"]}</span>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <Empty show={!!list.data && !items.length} text="Багц алга. “+ Шинэ багц”-аар нэмнэ үү." />
    </section>
  );
}
