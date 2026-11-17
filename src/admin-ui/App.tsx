// GenZst admin: one Preact island. Login (token -> GET /api/admin/me), hash routing, views loaded lazily.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import type { Permission } from "../lib/contracts";
import { api, getToken, setToken, setUnauthorizedHandler, type Session } from "./api";
import { ROLE } from "./labels";
import { Loading, Msg, SessionCtx, type Ctx } from "./ui";

type Loader = () => Promise<{ default: ComponentType<any> }>;
interface Route { key: string; perm: Permission; load: Loader }

const R = {
  dashboard: { key: "dashboard", perm: "orders.read", load: () => import("./views/Dashboard") },
  products: { key: "products", perm: "catalog.read", load: () => import("./views/Products") },
  product: { key: "products", perm: "catalog.read", load: () => import("./views/ProductEdit") },
  orders: { key: "orders", perm: "orders.read", load: () => import("./views/Orders") },
  order: { key: "orders", perm: "orders.read", load: () => import("./views/OrderDetail") },
  payments: { key: "payments", perm: "payments.read", load: () => import("./views/Payments") },
  shipments: { key: "shipments", perm: "delivery.read", load: () => import("./views/Shipments") },
  shipment: { key: "shipments", perm: "delivery.read", load: () => import("./views/ShipmentDetail") },
  settings: { key: "settings", perm: "settings.read", load: () => import("./views/Settings") },
  audit: { key: "audit", perm: "audit.read", load: () => import("./views/Audit") },
} satisfies Record<string, Route>;

const NAV: { key: string; href: string; label: string; perm: Permission }[] = [
  { key: "dashboard", href: "#/", label: "Хянах самбар", perm: "orders.read" },
  { key: "orders", href: "#/orders", label: "Захиалга", perm: "orders.read" },
  { key: "products", href: "#/products", label: "Бараа", perm: "catalog.read" },
  { key: "payments", href: "#/payments", label: "Төлбөр", perm: "payments.read" },
  { key: "shipments", href: "#/shipments", label: "Хүргэлт", perm: "delivery.read" },
  { key: "settings", href: "#/settings", label: "Дэлгүүрийн тохиргоо", perm: "settings.read" },
  { key: "audit", href: "#/audit", label: "Үйлдлийн түүх", perm: "audit.read" },
];

function parseHash(h: string): { route: Route; props: Record<string, string> } {
  const [path = "", query = ""] = h.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const q = Object.fromEntries(new URLSearchParams(query));
  const [a, b] = parts;
  if (a === "products" && b) return { route: R.product, props: { id: b === "new" ? "" : b } };
  if (a === "orders" && b) return { route: R.order, props: { no: b } };
  if (a === "shipments" && b) return { route: R.shipment, props: { id: b } };
  const r = (R as Record<string, Route>)[a ?? ""] ?? R.dashboard;
  return { route: r, props: q };
}

function useHash() {
  const [h, set] = useState(() => location.hash);
  useEffect(() => {
    const on = () => set(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return h;
}

function Lazy({ load, props }: { load: Loader; props: Record<string, string> }) {
  const [C, setC] = useState<ComponentType<any> | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setC(null);
    load().then((m) => live && setC(() => m.default)).catch(() => live && setErr("Хуудсыг ачаалж чадсангүй. Хуудсаа сэргээнэ үү."));
    return () => { live = false; };
  }, [load]);
  if (err) return <Msg kind="err" text={err} />;
  return C ? <C {...props} /> : <Loading on />;
}

function Login({ onIn, message }: { onIn: (s: Session) => void; message: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(message);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  async function submit(e: Event) {
    e.preventDefault();
    const token = input.current!.value.trim();
    if (!token) { setErr("Токеноо оруулна уу."); return; }
    setBusy(true);
    const res = await api<Session>("/api/admin/me", { token });
    setBusy(false);
    if (res.ok) {
      setToken(token);
      input.current!.value = "";
      onIn({ role: res.data.role, permissions: res.data.permissions ?? [] });
    } else if (res.status === 401) setErr("Токен буруу байна.");
    else if (res.status === 503) setErr("Админ хэсэг идэвхгүй байна: серверт ADMIN_TOKEN тохируулаагүй.");
    else setErr(res.error);
  }
  return (
    <main class="a-login">
      <h1 class="a-title">genzst · админ</h1>
      <form onSubmit={submit} class="a-login__form" data-testid="login">
        <label class="a-field">
          <span class="a-field__label">Нэвтрэх токен</span>
          <input ref={input} class="a-input" type="password" name="token" autocomplete="current-password" required />
          <span class="a-field__hint">Токен зөвхөн энэ цонхонд (sessionStorage) хадгалагдана.</span>
        </label>
        <button class="a-btn a-btn--primary" type="submit" disabled={busy}>{busy ? "Шалгаж байна…" : "Нэвтрэх"}</button>
        <Msg kind="err" text={err} />
      </form>
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(() => Boolean(getToken()));
  const [loginMsg, setLoginMsg] = useState("");
  const hash = useHash();
  const main = useRef<HTMLElement>(null);

  const logout = (msg = "") => { setToken(""); setSession(null); setLoginMsg(msg); };

  useEffect(() => {
    setUnauthorizedHandler((msg) => logout(msg));
    if (!getToken()) return;
    api<Session>("/api/admin/me").then((res) => {
      setBooting(false);
      if (res.ok) setSession({ role: res.data.role, permissions: res.data.permissions ?? [] });
      else if (res.status !== 401) logout(res.error);
    });
  }, []);

  const ctx = useMemo<Ctx | null>(() => {
    if (!session) return null;
    const set = new Set(session.permissions);
    return { role: session.role, can: (p: Permission) => set.has(p) };
  }, [session]);

  const { route, props } = parseHash(hash);
  useEffect(() => { if (session) main.current?.focus({ preventScroll: true }); }, [hash]);

  if (booting && !session) return <main class="a-login"><Loading on /></main>;
  if (!session || !ctx) return <Login onIn={(s) => { setLoginMsg(""); setSession(s); }} message={loginMsg} />;

  const allowed = ctx.can(route.perm);
  return (
    <SessionCtx.Provider value={ctx}>
      <a class="a-skip" href="#a-main" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>Үндсэн хэсэг рүү</a>
      <header class="a-head">
        <a class="a-brand" href="#/">genzst · админ</a>
        <span class="a-role" data-testid="role">{ROLE[session.role] ?? session.role}</span>
        <button type="button" class="a-btn a-btn--ghost" data-testid="logout" onClick={() => logout("Гарлаа.")}>Гарах</button>
      </header>
      <nav class="a-nav" aria-label="Админ цэс">
        {NAV.filter((n) => ctx.can(n.perm)).map((n) => (
          <a href={n.href} class="a-nav__link" aria-current={route.key === n.key ? "page" : undefined}>{n.label}</a>
        ))}
      </nav>
      <main id="a-main" class="a-main" ref={main} tabIndex={-1}>
        {allowed ? <Lazy key={hash} load={route.load} props={props} /> : <Msg kind="err" text="Эрх хүрэхгүй: энэ хэсгийг харах эрх танд алга." />}
      </main>
    </SessionCtx.Provider>
  );
}
