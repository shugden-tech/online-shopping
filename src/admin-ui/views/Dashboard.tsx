// Dashboard: counts from the list endpoints (keyset lists are counted up to one page of 100 -> "100+").
import { useEffect, useState } from "preact/hooks";
import type { Permission } from "../../lib/contracts";
import { api, orderView, pick, qs, rows } from "../api";
import { num } from "../labels";
import { Table, useSession } from "../ui";

const PAGE = 100;
interface Card { key: string; label: string; href: string; perm: Permission; value: string | null; error?: boolean; warn?: boolean }

async function countKeyset(path: string, filter?: (r: any) => boolean): Promise<string | null> {
  const res = await api(path);
  if (!res.ok) return null;
  const items = rows(res.data);
  const n = filter ? items.filter(filter).length : items.length;
  return res.data.nextCursor ? `${n}+` : String(n);
}

export default function Dashboard() {
  const { can } = useSession();
  const [cards, setCards] = useState<Card[]>([]);
  const [low, setLow] = useState<any[]>([]);

  useEffect(() => {
    let invP: Promise<any> | null = null;
    const inv = (filter: (s: any) => boolean) => async () => {
      invP ??= api(`/api/admin/inventory${qs({ low: 3, limit: PAGE })}`);
      const res = await invP;
      if (!res.ok) return null;
      setLow(rows(res.data).filter((s) => typeof pick(s, "available") === "number" && pick(s, "available") <= 3));
      const n = rows(res.data).filter(filter).length;
      return res.data.nextCursor ? `${n}+` : String(n);
    };
    const defs: (Omit<Card, "value"> & { get: () => Promise<string | null> })[] = [
      { key: "new", label: "Шинэ захиалга", href: "#/orders?status=new", perm: "orders.read", get: () => countKeyset(`/api/admin/orders${qs({ status: "new", limit: PAGE })}`) },
      {
        key: "awaiting", label: "Төлбөр хүлээгдэж буй (шинэ + баталгаажсан)", href: "#/orders?status=confirmed", perm: "orders.read",
        get: async () => {
          const [a, b] = await Promise.all([
            countKeyset(`/api/admin/orders${qs({ status: "new", limit: PAGE })}`, (o) => orderView(o).paymentStatus !== "paid"),
            countKeyset(`/api/admin/orders${qs({ status: "confirmed", limit: PAGE })}`, (o) => orderView(o).paymentStatus !== "paid"),
          ]);
          if (a === null || b === null) return null;
          const plus = a.endsWith("+") || b.endsWith("+");
          return `${parseInt(a) + parseInt(b)}${plus ? "+" : ""}`;
        },
      },
      { key: "paid", label: "Төлөгдсөн, илгээгээгүй", href: "#/orders?status=paid", perm: "orders.read", get: () => countKeyset(`/api/admin/orders${qs({ status: "paid", limit: PAGE })}`) },
      { key: "failedShip", label: "Амжилтгүй хүргэлт", href: "#/shipments?status=failed", perm: "delivery.read", warn: true, get: () => countKeyset(`/api/admin/shipments${qs({ status: "failed", limit: PAGE })}`) },
      {
        key: "zero", label: "Дууссан (0) SKU", href: "#low-stock", perm: "catalog.read", warn: true,
        get: inv((s) => pick(s, "available") === 0),
      },
      {
        key: "low", label: "Цөөхөн үлдсэн (1–3) SKU", href: "#low-stock", perm: "catalog.read",
        get: inv((s) => { const a = pick(s, "available"); return typeof a === "number" && a > 0 && a <= 3; }),
      },
      {
        key: "draft", label: "Ноорог бараа", href: "#/products?status=draft", perm: "catalog.read",
        get: async () => { const r = await api(`/api/admin/products${qs({ status: "draft", limit: 1 })}`); return r.ok ? String(r.data.total ?? rows(r.data).length) : null; },
      },
    ];
    const visible = defs.filter((d) => can(d.perm));
    setCards(visible.map(({ get: _g, ...d }) => ({ ...d, value: null })));
    visible.forEach((d, i) => {
      d.get().then((v) => setCards((cs) => cs.map((c, j) => (j === i ? { ...c, value: v ?? "!", error: v === null } : c))));
    });
  }, []);

  return (
    <section aria-labelledby="dash-h">
      <h1 id="dash-h" class="a-title">Хянах самбар</h1>
      <ul class="a-cards" data-testid="dashboard">
        {cards.map((c) => (
          <li>
            <a onClick={c.href === "#low-stock" ? (e) => { e.preventDefault(); document.getElementById("low-h")?.scrollIntoView(); } : undefined} class={`a-card${c.warn && c.value && c.value !== "0" && !c.error ? " a-card--warn" : ""}`} href={c.href} data-card={c.key}>
              <span class="a-card__n" aria-live="polite">{c.value === null ? "…" : c.error ? "—" : c.value}</span>
              <span class="a-card__l">{c.label}</span>
              {c.error && <span class="a-card__e">Ачаалж чадсангүй</span>}
            </a>
          </li>
        ))}
      </ul>
      {low.length > 0 && (
        <section class="a-panel" aria-labelledby="low-h">
          <h2 id="low-h" class="a-h2">Нөөц багатай / дууссан SKU</h2>
          <Table label="Нөөц багатай SKU" head={["SKU", "Бараа", "Үлдэгдэл", "Нөөцлөгдсөн", "Боломжит"]}>
            {low.map((s) => {
              const id = String(pick(s, "id", "sku") ?? "");
              const pid = pick(s, "productId", "product_id") ?? id.slice(0, id.lastIndexOf(":"));
              return (
                <tr>
                  <td class="a-mono"><a href={`#/products/${encodeURIComponent(pid)}`}>{id}</a></td>
                  <td>{[pick(s, "brand"), pick(s, "name")].filter(Boolean).join(" — ") || pid}</td>
                  <td class="a-mono">{num(pick(s, "stock"))}</td>
                  <td class="a-mono">{num(pick(s, "reserved"))}</td>
                  <td class="a-mono"><b>{num(pick(s, "available"))}</b></td>
                </tr>
              );
            })}
          </Table>
        </section>
      )}
      <p class="a-dim a-small">Тоо нь жагсаалтын эхний {PAGE} мөрөөс тоологдоно; илүү бол “+” гэж харагдана. “Цөөхөн” = 3 ба түүнээс бага үлдэгдэл.</p>
    </section>
  );
}
