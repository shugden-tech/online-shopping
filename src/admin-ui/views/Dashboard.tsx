// Dashboard: KPIs for today / 7 / 30 days, a 30-day orders + revenue chart (inline SVG), what needs attention
// now, and the latest orders. One request: GET /api/admin/stats?range= (aggregated in SQL).
import { useEffect, useState } from "preact/hooks";
import { api, enc } from "../api";
import { ORDER_PAY_STATUS, ORDER_STATUS, PROVIDER, money, num, when } from "../labels";
import { Badge, Msg, Table, go, useSession } from "../ui";

interface Stats {
  range: string;
  kpi: { orders: number; cancelled: number; paidOrders: number; revenue: number; aov: number };
  now: Record<string, number>;
  lowStockThreshold: number;
  series: { day: string; orders: number; revenue: number }[];
  latest: { orderNo: string; createdAt: string; name: string; phone: string; total: number; payment: string; paymentStatus: string; status: string }[];
}

const RANGES = [
  { v: "today", l: "Өнөөдөр" },
  { v: "7d", l: "7 хоног" },
  { v: "30d", l: "30 хоног" },
];

const short = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}сая` : n >= 1000 ? `${Math.round(n / 1000)}мянга` : String(n));

/** Bars = orders per day, line = paid revenue per day. Plain SVG, scales to the panel width. */
function Chart({ series }: { series: Stats["series"] }) {
  const W = 720, H = 220, L = 34, R = 52, T = 12, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const maxO = Math.max(1, ...series.map((d) => d.orders));
  const maxR = Math.max(1, ...series.map((d) => d.revenue));
  const bw = iw / series.length;
  const x = (i: number) => L + i * bw + bw / 2;
  const yO = (v: number) => T + ih - (v / maxO) * ih;
  const yR = (v: number) => T + ih - (v / maxR) * ih;
  const line = series.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yR(d.revenue).toFixed(1)}`).join(" ");
  const ticks = [0, 0.5, 1];
  const totalO = series.reduce((a, d) => a + d.orders, 0);
  const totalR = series.reduce((a, d) => a + d.revenue, 0);
  return (
    <figure style="margin:0">
      <svg class="a-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Сүүлийн 30 хоног: ${totalO} захиалга, ${money(totalR)} төлөгдсөн орлого`}>
        {ticks.map((t) => (
          <g>
            <line x1={L} x2={W - R} y1={T + ih - t * ih} y2={T + ih - t * ih} stroke="var(--line)" stroke-dasharray={t ? "3 4" : undefined} />
            <text x={L - 6} y={T + ih - t * ih + 3} text-anchor="end">{Math.round(maxO * t)}</text>
            <text x={W - R + 6} y={T + ih - t * ih + 3}>{short(Math.round(maxR * t))}</text>
          </g>
        ))}
        {series.map((d, i) => (
          <rect x={x(i) - bw * 0.32} width={bw * 0.64} y={yO(d.orders)} height={Math.max(0, T + ih - yO(d.orders))} rx="2" fill="rgba(107,95,112,.55)">
            <title>{`${d.day}: ${d.orders} захиалга, ${money(d.revenue)}`}</title>
          </rect>
        ))}
        <path d={line} fill="none" stroke="var(--ok)" stroke-width="2" stroke-linejoin="round" />
        {series.map((d, i) => (i % 5 === 4 || i === 0 ? <text x={x(i)} y={H - 8} text-anchor="middle">{d.day.slice(5).replace("-", "/")}</text> : null))}
      </svg>
      <figcaption class="a-legend"><span><i style="background:rgba(107,95,112,.7)" />Захиалгын тоо (зүүн тэнхлэг)</span><span><i style="background:var(--ok)" />Төлөгдсөн орлого ₮ (баруун тэнхлэг)</span></figcaption>
    </figure>
  );
}

export default function Dashboard(props: { range?: string }) {
  const { can } = useSession();
  const [range, setRange] = useState(props.range && RANGES.some((r) => r.v === props.range) ? props.range : "7d");
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const r = await api<Stats>(`/api/admin/stats?range=${range}`);
    setLoading(false);
    if (r.ok) { setData(r.data); setError(""); } else setError(r.error);
  }
  useEffect(() => { load(); }, [range]);
  useEffect(() => {
    const on = () => load();
    addEventListener("gz:new-order", on);
    return () => removeEventListener("gz:new-order", on);
  }, [range]);

  const k = data?.kpi;
  const n = data?.now ?? {};
  const v = (x: number | undefined, f: (n: number) => string = num) => (loading && !data ? "…" : x === undefined ? "—" : f(x));
  const kpis = [
    { key: "orders", l: "Захиалга", n: v(k?.orders), sub: k?.cancelled ? `${k.cancelled} цуцлагдсан` : "" },
    { key: "revenue", l: "Орлого (төлөгдсөн)", n: v(k?.revenue, money), gold: true, sub: k ? `${k.paidOrders} төлөгдсөн захиалга` : "" },
    { key: "aov", l: "Захиалгын дундаж дүн", n: v(k?.aov, money), sub: "" },
  ];
  const now = [
    { key: "pendingPayments", l: "Төлбөр хүлээгдэж буй", href: "#/orders?status=new", perm: "orders.read" },
    { key: "toShip", l: "Илгээх захиалга", href: "#/orders?status=paid", perm: "orders.read" },
    { key: "lowStock", l: `Цөөхөн үлдсэн (≤ ${data?.lowStockThreshold ?? 3})`, href: "#/inventory?low=1", perm: "catalog.read", warn: true },
    { key: "outOfStock", l: "Дууссан хэмжээ", href: "#/inventory?low=1", perm: "catalog.read", warn: true },
    { key: "failedShipments", l: "Амжилтгүй хүргэлт", href: "#/shipments?status=failed", perm: "delivery.read", warn: true },
    { key: "failedWebhooks", l: "Амжилтгүй webhook", href: "#/webhooks?tab=out", perm: "settings.read", warn: true },
    { key: "unpricedActive", l: "Үнэ тавиагүй идэвхтэй бараа", href: "#/products?status=active&hasPrice=0", perm: "catalog.read", warn: true },
    { key: "draftProducts", l: "Ноорог бараа", href: "#/products?status=draft", perm: "catalog.read" },
  ].filter((c) => can(c.perm as any));

  return (
    <section aria-labelledby="dash-h" class="a-stack">
      <div class="a-row a-row--between">
        <h1 id="dash-h" class="a-title" style="margin:0">Хянах самбар</h1>
        <div class="a-segs" role="group" aria-label="Хугацаа">
          {RANGES.map((r) => <button type="button" aria-pressed={range === r.v} onClick={() => setRange(r.v)} data-range={r.v}>{r.l}</button>)}
        </div>
      </div>
      <Msg kind="err" text={error} />
      <ul class="a-cards" data-testid="dashboard">
        {kpis.map((c) => (
          <li><div class={`a-card${c.gold ? " a-card--gold" : ""}`} data-card={c.key}>
            <span class="a-card__l">{c.l}</span>
            <span class="a-card__n" aria-live="polite">{c.n}</span>
            {c.sub && <span class="a-small a-dim">{c.sub}</span>}
          </div></li>
        ))}
      </ul>

      <section class="a-panel a-panel--gold" aria-labelledby="chart-h">
        <div class="a-row a-row--between"><h2 id="chart-h" class="a-h2">Сүүлийн 30 хоног</h2></div>
        {data ? <Chart series={data.series} /> : <span class="a-skel" style="height:200px" />}
      </section>

      <section aria-labelledby="now-h">
        <h2 id="now-h" class="a-h2">Анхаарах зүйлс</h2>
        <ul class="a-cards">
          {now.map((c) => {
            const val = n[c.key];
            return (
              <li><a class={`a-card${c.warn && val ? " a-card--warn" : ""}`} href={c.href} data-card={c.key}>
                <span class="a-card__l">{c.l}</span>
                <span class="a-card__n">{v(val)}</span>
              </a></li>
            );
          })}
        </ul>
      </section>

      <section class="a-panel" aria-labelledby="latest-h">
        <div class="a-row a-row--between">
          <h2 id="latest-h" class="a-h2">Сүүлийн захиалгууд</h2>
          <a href="#/orders" class="a-small">Бүх захиалга →</a>
        </div>
        {data && !data.latest.length ? <p class="a-dim a-empty">Одоогоор захиалга алга.</p> : (
          <Table label="Сүүлийн захиалгууд" head={["Дугаар", "Огноо", "Хэрэглэгч", "Утас", "Дүн", "Төлбөр", "Төлөв"]}>
            {(data?.latest ?? []).map((o) => (
              <tr data-href onClick={() => go(`#/orders/${enc(o.orderNo)}`)}>
                <td class="a-mono"><a href={`#/orders/${enc(o.orderNo)}`}>{o.orderNo}</a></td>
                <td class="a-mono a-small">{when(o.createdAt)}</td>
                <td>{o.name}</td>
                <td class="a-mono a-small">{o.phone}</td>
                <td class="a-mono a-r">{money(o.total)}</td>
                <td><Badge value={o.paymentStatus} labels={ORDER_PAY_STATUS} tone={`pay-${o.paymentStatus}`} /><div class="a-small a-dim">{PROVIDER[o.payment] ?? o.payment}</div></td>
                <td><Badge value={o.status} labels={ORDER_STATUS} /></td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      <p class="a-dim a-small">Өдрийг Улаанбаатарын цагаар (UTC+8) тооцно. Орлогод зөвхөн төлбөр нь баталгаажсан, цуцлагдаагүй захиалга орно.</p>
    </section>
  );
}
