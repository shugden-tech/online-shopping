// genzst admin: one Preact island. Login (username + password -> token, or a token) -> GET /api/admin/me,
// hash routing, views loaded lazily, sidebar (desktop) / bottom bar (phone), new-order polling.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import type { Permission } from "../lib/contracts";
import { api, getToken, setToken, setUnauthorizedHandler, type Session } from "./api";
import { ROLE } from "./labels";
import { Icon, type IconName } from "./icons";
import { Loading, Msg, setSession as setCtx } from "./ui";

type Loader = () => Promise<{ default: ComponentType<any> }>;
interface Route { key: string; perm: Permission; title: string; load: Loader }

const R = {
  dashboard: { key: "dashboard", perm: "orders.read", title: "Хянах самбар", load: () => import("./views/Dashboard") },
  orders: { key: "orders", perm: "orders.read", title: "Захиалга", load: () => import("./views/Orders") },
  order: { key: "orders", perm: "orders.read", title: "Захиалга", load: () => import("./views/OrderDetail") },
  products: { key: "products", perm: "catalog.read", title: "Бараа", load: () => import("./views/Products") },
  product: { key: "products", perm: "catalog.read", title: "Бараа", load: () => import("./views/ProductEdit") },
  bundles: { key: "bundles", perm: "catalog.read", title: "Багц", load: () => import("./views/Bundles") },
  bundle: { key: "bundles", perm: "catalog.read", title: "Багц", load: () => import("./views/BundleEdit") },
  inventory: { key: "inventory", perm: "catalog.read", title: "Үлдэгдэл", load: () => import("./views/Inventory") },
  payments: { key: "payments", perm: "payments.read", title: "Төлбөр", load: () => import("./views/Payments") },
  shipments: { key: "shipments", perm: "delivery.read", title: "Хүргэлт", load: () => import("./views/Shipments") },
  shipment: { key: "shipments", perm: "delivery.read", title: "Хүргэлт", load: () => import("./views/ShipmentDetail") },
  webhooks: { key: "shipments", perm: "delivery.read", title: "Хүргэлт · Webhook", load: () => import("./views/Webhooks") },
  settings: { key: "settings", perm: "settings.read", title: "Тохиргоо", load: () => import("./views/Settings") },
  audit: { key: "audit", perm: "audit.read", title: "Түүх", load: () => import("./views/Audit") },
} satisfies Record<string, Route>;

const NAV: { key: string; href: string; label: string; perm: Permission; icon: IconName }[] = [
  { key: "dashboard", href: "#/", label: "Хянах самбар", perm: "orders.read", icon: "chart" },
  { key: "orders", href: "#/orders", label: "Захиалга", perm: "orders.read", icon: "bag" },
  { key: "products", href: "#/products", label: "Бараа", perm: "catalog.read", icon: "bottle" },
  { key: "bundles", href: "#/bundles", label: "Багц", perm: "catalog.read", icon: "gift" },
  { key: "inventory", href: "#/inventory", label: "Үлдэгдэл", perm: "catalog.read", icon: "box" },
  { key: "payments", href: "#/payments", label: "Төлбөр", perm: "payments.read", icon: "card" },
  { key: "shipments", href: "#/shipments", label: "Хүргэлт", perm: "delivery.read", icon: "truck" },
  { key: "settings", href: "#/settings", label: "Тохиргоо", perm: "settings.read", icon: "gear" },
  { key: "audit", href: "#/audit", label: "Түүх", perm: "audit.read", icon: "clock" },
];

function parseHash(h: string): { route: Route; props: Record<string, string> } {
  const [path = "", query = ""] = h.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  const q = Object.fromEntries(new URLSearchParams(query));
  const [a, b] = parts;
  if (a === "products" && b) return { route: R.product, props: { id: b === "new" ? "" : b } };
  if (a === "bundles" && b) return { route: R.bundle, props: { id: b === "new" ? "" : b } };
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
    load().then((m) => live && setC(() => m.default)).catch(() => live && setErr("Хуудсыг ачаалж чадсангүй. Хуудсаа шинэчилнэ үү."));
    return () => { live = false; };
  }, [load]);
  if (err) return <Msg kind="err" text={err} />;
  return C ? <C {...props} /> : <Loading on />;
}

/** One readable sentence for each way logging in can fail. */
function loginError(status: number, code: string | undefined, mode: "password" | "token"): string {
  if (status === 0) return "Сервертэй холбогдож чадсангүй. Интернэт холболтоо шалгаад дахин оролдоно уу.";
  if (status === 429) return "Хэт олон удаа буруу оролдлоо. 10 минут орчим хүлээгээд дахин оролдоно уу.";
  if (status === 401) return mode === "password" ? "Нэвтрэх нэр эсвэл нууц үг буруу байна." : "Токен буруу байна.";
  if (status === 503 && code === "login-disabled") return "Нэр, нууц үгээр нэвтрэх боломж серверт идэвхжээгүй байна (ADMIN_USERNAME, ADMIN_PASSWORD тохируулаагүй). Токеноор нэвтэрнэ үү.";
  if (status === 503) return "Админ хэсэг идэвхгүй байна: серверт ADMIN_TOKEN тохируулаагүй.";
  if (status >= 500) return `Серверийн алдаа гарлаа (${status}). Түр хүлээгээд дахин оролдоно уу.`;
  return `Нэвтэрч чадсангүй (${status}).`;
}

function Login({ onIn, message, logo }: { onIn: (s: Session) => void; message: string; logo: string }) {
  const [mode, setMode] = useState<"password" | "token">("password");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(message);
  const user = useRef<HTMLInputElement>(null);
  const secret = useRef<HTMLInputElement>(null);
  useEffect(() => { (mode === "password" ? user : secret).current?.focus(); }, [mode]);

  async function submit(e: Event) {
    e.preventDefault();
    const username = user.current?.value.trim() ?? "";
    let token = secret.current!.value.trim();
    if (mode === "password" && !username) { setErr("Нэвтрэх нэрээ оруулна уу."); user.current?.focus(); return; }
    if (!token) { setErr(mode === "password" ? "Нууц үгээ оруулна уу." : "Токеноо оруулна уу."); secret.current?.focus(); return; }
    setBusy(true);
    setErr("");
    if (mode === "password") {
      const lg = await api<{ token: string }>("/api/admin/login", { method: "POST", body: { username, password: token }, token: "-" });
      if (!lg.ok || !lg.data.token) { setBusy(false); setErr(loginError(lg.status, lg.data?.errors?.form, "password")); return; }
      token = lg.data.token;
    }
    const res = await api<Session>("/api/admin/me", { token });
    setBusy(false);
    if (res.ok) {
      setToken(token);
      secret.current!.value = "";
      onIn({ role: res.data.role, permissions: res.data.permissions ?? [] });
    } else setErr(loginError(res.status, res.data?.errors?.form, mode));
  }

  return (
    <main class="a-login">
      <div class="a-login__card">
        <img class="a-login__logo" src={logo} alt="" width={84} height={84} />
        <h1 class="a-login__h">genzst</h1>
        <p class="a-login__sub">Удирдлагын хэсэг</p>
        <form onSubmit={submit} class="a-login__form" data-testid="login" noValidate>
          <div class="a-tabs" role="group" aria-label="Нэвтрэх арга">
            <button type="button" aria-pressed={mode === "password"} onClick={() => { setMode("password"); setErr(""); }}>Нэр, нууц үг</button>
            <button type="button" aria-pressed={mode === "token"} data-testid="mode-token" onClick={() => { setMode("token"); setErr(""); }}>Токен</button>
          </div>
          {mode === "password" && (
            <label class="a-field">
              <span class="a-field__label">Нэвтрэх нэр</span>
              <input ref={user} class="a-input" type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck={false} />
            </label>
          )}
          <label class="a-field">
            <span class="a-field__label">{mode === "password" ? "Нууц үг" : "Токен"}</span>
            <input ref={secret} class="a-input" type="password" name="token" autocomplete={mode === "password" ? "current-password" : "off"} />
            {mode === "token" && <span class="a-field__hint">Токен зөвхөн энэ цонхонд хадгалагдаж, цонхоо хаахад устна.</span>}
          </label>
          <button class="a-btn a-btn--primary" type="submit" disabled={busy}>{busy ? "Шалгаж байна…" : "Нэвтрэх"}</button>
          <Msg kind="err" text={err} />
        </form>
      </div>
    </main>
  );
}

/* ---------------- new-order awareness ---------------- */

const SOUND_KEY = "gz-admin-sound";
const soundOn = () => { try { return localStorage.getItem(SOUND_KEY) === "1"; } catch { return false; } };

function beep() {
  try {
    const C = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    const ctx = new C();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.55);
  } catch { /* no audio */ }
}

/** Polls every 45 s while the tab is visible: badge count of `new` orders, title flash + optional sound on a new one. */
function usePoll(enabled: boolean, runJobs: boolean) {
  const [count, setCount] = useState(0);
  const latest = useRef(0);
  const flash = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const base = document.title;
    let timer = 0;
    let n = 0;
    const stopFlash = () => { if (flash.current) { clearInterval(flash.current); flash.current = null; document.title = base; } };
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const r = await api<{ latestId: number; newCount: number }>("/api/admin/orders/poll");
      if (r.ok) {
        setCount(r.data.newCount);
        if (latest.current && r.data.latestId > latest.current) {
          if (soundOn()) beep();
          stopFlash();
          let on = false;
          flash.current = window.setInterval(() => { on = !on; document.title = on ? "● Шинэ захиалга" : base; }, 1000);
          dispatchEvent(new CustomEvent("gz:new-order"));
        }
        latest.current = Math.max(latest.current, r.data.latestId);
      }
      // housekeeping (expire holds, retry deliveries, send webhooks) every ~3 minutes
      if (runJobs && n++ % 4 === 0) void api("/api/admin/jobs/run", { method: "POST" });
    };
    const onVis = () => { if (document.visibilityState === "visible") { stopFlash(); void tick(); } };
    void tick();
    timer = window.setInterval(tick, 45_000);
    document.addEventListener("visibilitychange", onVis);
    addEventListener("focus", stopFlash);
    return () => { clearInterval(timer); stopFlash(); document.removeEventListener("visibilitychange", onVis); removeEventListener("focus", stopFlash); };
  }, [enabled, runJobs]);
  return count;
}

export default function App({ logo = "/favicon.png" }: { logo?: string }) {
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

  // plain computation: the module-level session must be set before the views render
  const perms = new Set(session?.permissions ?? []);
  const ctx = session ? { role: session.role, can: (p: Permission) => perms.has(p) } : null;
  if (ctx) setCtx(ctx);
  const newOrders = usePoll(Boolean(ctx?.can("orders.read")), Boolean(ctx?.can("orders.write")));

  const { route, props } = parseHash(hash);
  useEffect(() => { if (session) { main.current?.focus({ preventScroll: true }); scrollTo(0, 0); } }, [hash]);

  if (booting && !session) return <main class="a-login"><Loading on /></main>;
  if (!session || !ctx) return <Login logo={logo} onIn={(s) => { setLoginMsg(""); setSession(s); }} message={loginMsg} />;

  const allowed = ctx.can(route.perm);
  const items = NAV.filter((n) => ctx.can(n.perm));
  const link = (n: (typeof NAV)[number]) => (
    <a href={n.href} class="a-nav__link" aria-current={route.key === n.key ? "page" : undefined} data-nav={n.key}>
      <Icon name={n.icon} />
      <span>{n.label}</span>
      {n.key === "orders" && newOrders > 0 && <span class="a-nav__badge" aria-label={`${newOrders} шинэ захиалга`} data-testid="new-badge">{newOrders}</span>}
    </a>
  );
  return (
    <div class="a-shell">
      <a class="a-skip" href="#a-main" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>Үндсэн хэсэг рүү шилжих</a>
      <aside class="a-side">
        <a class="a-logo" href="#/" aria-label="genzst админ, хянах самбар">
          <img src={logo} alt="" width={38} height={38} />
          <span class="a-logo__t"><span class="a-logo__name">genzst</span><span class="a-logo__sub">админ</span></span>
        </a>
        <nav class="a-nav" aria-label="Админ цэс">{items.map(link)}</nav>
        <div class="a-side__foot">
          <a href="/" target="_blank" rel="noopener">Дэлгүүр үзэх ↗</a>
          <span>Нэвтэрсэн: {ROLE[session.role] ?? session.role}</span>
        </div>
      </aside>
      <div class="a-col">
        <header class="a-top">
          <img class="a-top__logo" src={logo} alt="" width={30} height={30} />
          <span class="a-top__title">{route.title}</span>
          <span class="a-role" data-testid="role">{ROLE[session.role] ?? session.role}</span>
          <a class="a-btn a-btn--ghost a-btn--sm a-hide-sm" href="/" target="_blank" rel="noopener">Дэлгүүр ↗</a>
          <button type="button" class="a-btn a-btn--sm" data-testid="logout" onClick={() => logout("Та системээс гарлаа.")}>Гарах</button>
        </header>
        <main id="a-main" class="a-main" ref={main} tabIndex={-1}>
          {allowed ? <Lazy key={hash} load={route.load} props={props} /> : <Msg kind="err" text="Танд энэ хэсгийг үзэх эрх байхгүй байна." />}
        </main>
      </div>
      <nav class="a-bnav" aria-label="Админ цэс (гар утас)">{items.map(link)}</nav>
    </div>
  );
}
