// Customer account tests (0006): register / login / logout, CSRF origin check, rate limits, session expiry and
// sliding refresh, password change ending other sessions, avatar validation (magic bytes, size) and serving,
// address CRUD + single default, order linkage (session only) + claiming past orders by phone, wishlist merge /
// replace, account deletion, admin list + password reset (audit), and Google sign-in against a mock Google
// (token endpoint + JWKS on 127.0.0.1:8894, RS256 tokens made here).
// Plain node (20+), no dependencies. Needs a built site served by wrangler with local D1 + migrations:
//   npx wrangler d1 migrations apply genzst --local --persist-to .wrangler/state-acct
//   npx astro build && npx wrangler dev --port 8788 --persist-to .wrangler/state-acct
//   BASE=http://localhost:8788 D1_PERSIST=.wrangler/state-acct npm run test:accounts
// .dev.vars: the always-pass TURNSTILE_SECRET, ADMIN_TOKEN / STAFF_TOKEN, and for the Google block
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL / GOOGLE_JWKS_URL (see .dev.vars.example).
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE ?? "http://localhost:8788").replace(/\/$/, "");
const PERSIST = process.env.D1_PERSIST ?? process.env.PERSIST ?? ".wrangler/state-acct";
const devVars = existsSync(join(root, ".dev.vars")) ? readFileSync(join(root, ".dev.vars"), "utf8") : "";
const envVar = (k) => process.env[k] ?? new RegExp(`^${k}=(.*)$`, "m").exec(devVars)?.[1]?.trim() ?? "";
const ADMIN = envVar("ADMIN_TOKEN");
const STAFF = envVar("STAFF_TOKEN");
const G_ID = envVar("GOOGLE_CLIENT_ID");
const G_SECRET = envVar("GOOGLE_CLIENT_SECRET");
const MOCK_PORT = Number((/:(\d+)/.exec(envVar("GOOGLE_TOKEN_URL")) ?? [])[1] ?? 8894);
const fileSettings = JSON.parse(readFileSync(join(root, "src/data/settings.json"), "utf8"));
const RUN = Math.random().toString(36).slice(2, 8);

let pass = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) pass++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail !== "" ? `  -> ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

/* ---------------- helpers ---------------- */
const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
function sql(command) {
  const out = execFileSync(
    process.execPath,
    [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "genzst", "--local", "--persist-to", PERSIST, "--json", "--command", command],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const fix = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === "null" ? null : v]));
  return JSON.parse(out.slice(out.indexOf("["))).map((s) => (s.results ?? []).map(fix));
}
const one = (command) => sql(command)[0]?.[0] ?? null;

let ipSeq = 0;
const freshIp = (tag = "x") => `acct-${RUN}-${tag}-${++ipSeq}`;
// unique valid Mongolian mobiles for this run (8 digits starting with 8)
let phoneSeq = Math.floor(Math.random() * 9000);
const freshPhone = () => `8${String(Date.now() % 1000).padStart(3, "0")}${String(++phoneSeq % 10000).padStart(4, "0")}`;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const b64url = (buf) => Buffer.from(buf).toString("base64url");

async function fetchRetry(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!/UND_ERR_SOCKET|ECONNRESET|UND_ERR_CLOSED/.test(err?.cause?.code ?? "")) throw err;
    return fetch(url, init);
  }
}

/** One "browser": keeps the cookies the server sets (name -> { value, attrs }). */
class Jar {
  constructor() {
    this.c = new Map();
  }
  header() {
    return [...this.c].map(([k, v]) => `${k}=${v.value}`).join("; ");
  }
  take(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(/;\s*/);
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      const maxAge = attrs.find((a) => /^max-age=/i.test(a));
      if (maxAge && Number(maxAge.split("=")[1]) <= 0) this.c.delete(name);
      else this.c.set(name, { value, attrs, raw: line });
    }
  }
  get(name) {
    return this.c.get(name);
  }
}

async function call(method, path, { body, form, jar, ip = freshIp(), origin = BASE, headers = {}, auth, redirect = "manual" } = {}) {
  const h = { "CF-Connecting-IP": ip, ...headers };
  if (origin) h.Origin = origin;
  if (jar?.c.size) h.Cookie = jar.header();
  if (auth) h.Authorization = `Bearer ${auth}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    h["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetchRetry(BASE + path, { method, headers: h, body: payload, redirect });
  jar?.take(res);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

const STRONG = `Zuun-Gol-${RUN}-pass!`;
async function register(jar, phone, { password = STRONG, name = "Test Хэрэглэгч", ip } = {}) {
  return call("POST", "/api/account/register", { jar, ip, body: { phone, password, name, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", website: "" } });
}
const login = (jar, phone, password = STRONG, ip) => call("POST", "/api/account/login", { jar, ip, body: { phone, password } });
const me = (jar) => call("GET", "/api/account/me", { jar, origin: null });
const tokenOf = (jar) => jar.get("__Host-gz_session")?.value ?? "";

function guestOrderSql(no, phone, status = "new", extra = "") {
  return `INSERT INTO orders (order_no, status, name, phone, city, district, address, payment, items_json, subtotal, delivery, total, locale, payment_status${extra ? ", customer_id" : ""})
          VALUES (${q(no)}, ${q(status)}, 'Guest Name', ${q(phone)}, 'ub', 'bayangol', 'Guest street 5', 'bank',
                  '[{"sku":"x:5","slug":"x","brand":"B","name":"N","ml":5,"qty":2,"price":1000,"tracked":false}]', 2000, 0, 2000, 'mn', 'unpaid'${extra ? `, ${extra}` : ""});`;
}
const orderNo = (tag) => `GZ-${String(Date.now()).slice(-6)}-${tag}`;

/* ---------------- mock Google ---------------- */
const key1 = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key2 = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk1 = { ...key1.publicKey.export({ format: "jwk" }), kid: "test-kid-1", alg: "RS256", use: "sig" };
const codes = new Map(); // code -> { claims, key, kid, challenge? }
function signJwt(claims, key = key1.privateKey, kid = "test-kid-1") {
  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const s = createSign("RSA-SHA256");
  s.update(`${head}.${body}`);
  return `${head}.${body}.${b64url(s.sign(key))}`;
}
let tokenCalls = [];
const mock = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
  if (url.pathname === "/jwks") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ keys: [jwk1] }));
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let raw = "";
    for await (const c of req) raw += c;
    const p = new URLSearchParams(raw);
    tokenCalls.push(Object.fromEntries(p));
    const entry = codes.get(p.get("code"));
    const pkceOk = entry && (!entry.challenge || b64url(createHash("sha256").update(p.get("code_verifier") ?? "").digest()) === entry.challenge);
    if (!entry || p.get("client_id") !== G_ID || p.get("client_secret") !== G_SECRET || p.get("grant_type") !== "authorization_code" || !pkceOk) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid_grant" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ id_token: signJwt(entry.claims, entry.key, entry.kid), access_token: "x", token_type: "Bearer" }));
  }
  res.writeHead(404).end();
});

/** /start (with jar) -> parse Location -> register a code with claims built by `make(nonce)` -> /callback. */
async function googleFlow(jar, { mode = "login", make, state: forceState, kid, key, skipPkce = false } = {}) {
  const s = await call("GET", `/api/account/google/start?mode=${mode}&return=/profile/`, { jar, origin: null });
  const loc = new URL(s.headers.get("location") ?? "http://x/");
  const nonce = loc.searchParams.get("nonce");
  const code = `code-${RUN}-${Math.random().toString(36).slice(2)}`;
  const now = Math.floor(Date.now() / 1000);
  codes.set(code, { claims: make({ nonce, now }), key, kid, challenge: skipPkce ? null : loc.searchParams.get("code_challenge") });
  const cb = await call("GET", `/api/account/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(forceState ?? loc.searchParams.get("state"))}`, { jar, origin: null });
  return { start: s, loc, cb, result: new URL(cb.headers.get("location") ?? "http://x/", BASE).searchParams.get("google") };
}
const gClaims = (sub, extra = {}) => ({ nonce, now }) => ({
  iss: "https://accounts.google.com", aud: G_ID, sub, email: `${sub}@example.com`, email_verified: true, name: "Google Хэрэглэгч",
  iat: now, exp: now + 600, nonce, ...extra,
});

/* ---------------- tests ---------------- */
let originalSettings = null;
const admin = (method, path, body) => call(method, path, { body, auth: ADMIN });

try {
  if (!ADMIN || !STAFF) throw new Error("ADMIN_TOKEN and STAFF_TOKEN are needed (environment or .dev.vars)");

  /* ----- signed out + CSRF ----- */
  const anon = await me(new Jar());
  ok("me signed out: 200 customer null", anon.status === 200 && anon.data.ok && anon.data.customer === null, anon.data);
  const P1 = freshPhone();
  const noOrigin = await call("POST", "/api/account/register", { origin: null, body: { phone: P1, password: STRONG, name: "X Y", turnstileToken: "t" } });
  ok("CSRF: register without Origin -> 403", noOrigin.status === 403, noOrigin.status);
  const evil = await call("POST", "/api/account/login", { origin: "https://evil.example", body: { phone: P1, password: STRONG } });
  ok("CSRF: login from another origin -> 403", evil.status === 403, evil.status);

  /* ----- register validation ----- */
  const weak = await register(new Jar(), P1, { password: "12345678" });
  ok("register: common password refused (422 common)", weak.status === 422 && weak.data.errors?.password === "common", weak.data);
  const short = await register(new Jar(), P1, { password: "Ab1!" });
  ok("register: short password refused (422 short)", short.status === 422 && short.data.errors?.password === "short", short.data);
  const withPhone = await register(new Jar(), P1, { password: `x${P1}x` });
  ok("register: password containing the phone refused", withPhone.status === 422 && withPhone.data.errors?.password === "common", withPhone.data);
  const badPhone = await register(new Jar(), "12345678");
  ok("register: phone must be a Mongolian mobile (422 phone)", badPhone.status === 422 && badPhone.data.errors?.phone === "phone", badPhone.data);
  const noTs = await call("POST", "/api/account/register", { body: { phone: P1, password: STRONG, name: "Test User" } });
  ok("register: Turnstile token required", noTs.status === 422 && noTs.data.errors?.turnstile === "turnstileMissing", noTs.data);
  const honey = await call("POST", "/api/account/register", { body: { phone: P1, password: STRONG, name: "Test User", turnstileToken: "t", website: "bot" } });
  ok("register: honeypot filled -> 400", honey.status === 400, honey.status);

  /* ----- claim past orders on sign-up ----- */
  const claimNo = orderNo("CLM1");
  const otherNo = orderNo("CLM2");
  sql(guestOrderSql(claimNo, P1) + guestOrderSql(otherNo, freshPhone()));
  const A = new Jar();
  const reg = await register(A, P1);
  ok("register: 201 + customer", reg.status === 201 && reg.data.customer?.phone === P1, reg.data);
  ok("register: claimed the 1 past order with the same phone", reg.data.claimed === 1, reg.data.claimed);
  ok("register: other phone's order not claimed", one(`SELECT customer_id FROM orders WHERE order_no = ${q(otherNo)}`)?.customer_id === null);
  const sc = A.get("__Host-gz_session");
  ok("cookie: __Host-gz_session HttpOnly; Secure; SameSite=Lax; Path=/", !!sc && /HttpOnly/i.test(sc.raw) && /Secure/i.test(sc.raw) && /SameSite=Lax/i.test(sc.raw) && /Path=\//.test(sc.raw) && !/Domain=/i.test(sc.raw), sc?.raw);
  ok("cookie: 32-byte token (base64url)", /^[A-Za-z0-9_-]{43}$/.test(tokenOf(A)), tokenOf(A));
  const hint = A.get("gz_in");
  ok("cookie: gz_in=1 hint is NOT HttpOnly and holds no secret", hint?.value === "1" && !/HttpOnly/i.test(hint.raw), hint?.raw);
  const cid = reg.data.customer.id;
  const srow = one(`SELECT id FROM customer_sessions WHERE customer_id = ${cid}`);
  ok("session: D1 stores SHA-256 of the token, not the token", srow?.id === sha256(tokenOf(A)) && srow.id !== tokenOf(A), srow);
  const crow = one(`SELECT password_hash, password_salt, password_iter FROM customers WHERE id = ${cid}`);
  ok("password: PBKDF2 100000 iterations, salted, not stored in clear", crow.password_iter === 100000 && crow.password_salt.length >= 20 && !crow.password_hash.includes(STRONG), crow.password_iter);
  const dup = await register(new Jar(), P1);
  ok("register: same phone again -> 409 taken", dup.status === 409 && dup.data.errors?.phone === "taken", dup.data);
  const m1 = await me(A);
  ok("me: signed in, no secrets in the response", m1.data.customer?.id === cid && m1.data.customer.hasPassword === true && !JSON.stringify(m1.data).includes("hash") && !JSON.stringify(m1.data).includes("salt"), m1.data);
  const m1PlusPrefix = await call("GET", "/api/account/me", { origin: null, headers: { Cookie: `__Host-gz_session=${tokenOf(A).slice(0, -1)}x` } });
  ok("me: a forged token is not a session", m1PlusPrefix.data.customer === null);

  /* ----- login ----- */
  const wrong = await login(new Jar(), P1, "Wrong-password-1");
  const unknown = await login(new Jar(), freshPhone(), "Wrong-password-1");
  ok("login: wrong password -> 401 invalid", wrong.status === 401 && wrong.data.errors?.form === "invalid", wrong.data);
  ok("login: unknown phone -> same 401 invalid (no enumeration)", unknown.status === 401 && JSON.stringify(unknown.data) === JSON.stringify(wrong.data), unknown.data);
  const B = new Jar();
  const lg = await login(B, P1);
  ok("login: correct -> 200 + new session", lg.status === 200 && lg.data.customer?.id === cid && tokenOf(B) && tokenOf(B) !== tokenOf(A), lg.data);

  /* ----- rate limits ----- */
  const RP = freshPhone();
  let last = null;
  for (let i = 0; i < 9; i++) last = await login(new Jar(), RP, "Wrong-password-1", freshIp("rp"));
  ok("rate limit: 9th login attempt for one phone (any IP) -> 429", last.status === 429 && last.data.errors?.form === "rate", last.status);
  const rip = freshIp("rip");
  for (let i = 0; i < 21; i++) last = await login(new Jar(), freshPhone(), "Wrong-password-1", rip);
  ok("rate limit: 21st login attempt from one IP -> 429", last.status === 429, last.status);
  const regIp = freshIp("reg");
  for (let i = 0; i < 6; i++) last = await register(new Jar(), freshPhone(), { ip: regIp });
  ok("rate limit: 6th sign-up from one IP in an hour -> 429", last.status === 429, last.status);

  /* ----- profile edit ----- */
  const pe = await call("PATCH", "/api/account/me", { jar: A, body: { name: "Шинэ Нэр", displayName: "Nick", showOnBoard: true } });
  ok("PATCH me: name, displayName, showOnBoard", pe.status === 200 && pe.data.customer.name === "Шинэ Нэр" && pe.data.customer.displayName === "Nick" && pe.data.customer.showOnBoard === true, pe.data);
  const pbad = await call("PATCH", "/api/account/me", { jar: A, body: { name: "x" } });
  ok("PATCH me: bad name -> 422", pbad.status === 422 && pbad.data.errors?.name === "name", pbad.data);
  const pcsrf = await call("PATCH", "/api/account/me", { jar: A, origin: "https://evil.example", body: { name: "Evil Name" } });
  ok("CSRF: PATCH me from another origin -> 403 (and nothing changed)", pcsrf.status === 403 && (await me(A)).data.customer.name === "Шинэ Нэр", pcsrf.status);
  const pphone = await call("PATCH", "/api/account/me", { jar: A, body: { phone: freshPhone(), password: "Wrong-password-1" } });
  ok("PATCH me: changing the phone needs the right password", pphone.status === 422 && pphone.data.errors?.password === "wrong", pphone.data);

  /* ----- session expiry + sliding refresh ----- */
  const sidB = sha256(tokenOf(B));
  sql(`UPDATE customer_sessions SET last_seen = datetime('now', '-2 hours'), expires_at = datetime('now', '+1 day') WHERE id = ${q(sidB)}`);
  const slide = await me(B);
  const after = one(`SELECT expires_at, last_seen FROM customer_sessions WHERE id = ${q(sidB)}`);
  ok("session: used after 1 h idle -> expiry slides to ~30 days and the cookie is re-sent",
    slide.data.customer?.id === cid && (slide.headers.getSetCookie?.() ?? []).some((c) => c.startsWith("__Host-gz_session=")) && new Date(after.expires_at.replace(" ", "T") + "Z") - Date.now() > 29 * 86400_000, after);
  sql(`UPDATE customer_sessions SET expires_at = datetime('now', '-1 minute') WHERE id = ${q(sidB)}`);
  const expired = await me(B);
  const expiredOrders = await call("GET", "/api/account/orders", { jar: B, origin: null });
  ok("session: expired -> signed out (me null, orders 401)", expired.data.customer === null && expiredOrders.status === 401, expiredOrders.status);

  /* ----- password change kills other sessions ----- */
  const C = new Jar();
  await login(C, P1);
  const pwWrong = await call("POST", "/api/account/password", { jar: A, body: { current: "nope-nope-1", next: "Another-Good-Pass-9" } });
  ok("password: wrong current -> 422", pwWrong.status === 422 && pwWrong.data.errors?.current === "wrong", pwWrong.data);
  const pwWeak = await call("POST", "/api/account/password", { jar: A, body: { current: STRONG, next: "password1" } });
  ok("password: common new password -> 422", pwWeak.status === 422 && pwWeak.data.errors?.next === "common", pwWeak.data);
  const NEWPW = `New-${RUN}-Passw0rd`;
  const pwOk = await call("POST", "/api/account/password", { jar: A, body: { current: STRONG, next: NEWPW } });
  ok("password: changed, other sessions ended", pwOk.status === 200 && pwOk.data.ended >= 1, pwOk.data);
  ok("password: the other device is signed out", (await me(C)).data.customer === null);
  ok("password: this device stays signed in", (await me(A)).data.customer?.id === cid);
  ok("password: old one no longer works", (await login(new Jar(), P1)).status === 401);
  ok("password: new one works", (await login(new Jar(), P1, NEWPW)).status === 200);

  /* ----- avatar ----- */
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
  const up = (bytes, type = "image/png", name = "a.png", jar = A, origin = BASE) => {
    const f = new FormData();
    f.append("file", new Blob([bytes], { type }), name);
    return call("POST", "/api/account/avatar", { jar, form: f, origin });
  };
  const fake = await up(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "image/png", "evil.png");
  ok("avatar: bad magic bytes (SVG named .png) -> 400 type", fake.status === 400 && fake.data.errors?.file === "type", fake.data);
  const big = Buffer.alloc(2 * 1024 * 1024 + 10, 0);
  png.copy(big);
  const tooBig = await up(big);
  ok("avatar: over 2 MB -> 413", tooBig.status === 413, tooBig.status);
  const csrfAv = await up(png, "image/png", "a.png", A, "https://evil.example");
  ok("CSRF: avatar upload from another origin -> 403", csrfAv.status === 403, csrfAv.status);
  const good = await up(png);
  ok("avatar: PNG stored, customer.avatarUrl set", good.status === 200 && /^\/api\/account\/avatar\?v=/.test(good.data.customer?.avatarUrl ?? ""), good.data);
  ok("avatar: R2 key customers/<id>.png", one(`SELECT avatar_key FROM customers WHERE id = ${cid}`)?.avatar_key === `customers/${cid}.png`);
  const avGet = await fetchRetry(`${BASE}/api/account/avatar`, { headers: { Cookie: A.header() } });
  const avBytes = Buffer.from(await avGet.arrayBuffer());
  ok("avatar: GET serves own image with safe headers",
    avGet.status === 200 && avGet.headers.get("content-type") === "image/png" && avGet.headers.get("x-content-type-options") === "nosniff" && /private/.test(avGet.headers.get("cache-control") ?? "") && avBytes.equals(png),
    `${avGet.status} ${avGet.headers.get("content-type")}`);
  const avAnon = await fetchRetry(`${BASE}/api/account/avatar`);
  ok("avatar: GET without a session -> 401", avAnon.status === 401, avAnon.status);
  const avDel = await call("DELETE", "/api/account/avatar", { jar: A });
  ok("avatar: DELETE clears it", avDel.status === 200 && avDel.data.customer.avatarUrl === null, avDel.data);
  ok("avatar: GET after delete -> 404", (await fetchRetry(`${BASE}/api/account/avatar`, { headers: { Cookie: A.header() } })).status === 404);

  /* ----- addresses ----- */
  const d0 = fileSettings.districts[0].id;
  const badAddr = await call("POST", "/api/account/addresses", { jar: A, body: { city: "ub", district: "nowhere", address: "Street 12345" } });
  ok("address: unknown UB district -> 422", badAddr.status === 422 && badAddr.data.errors?.district === "district", badAddr.data);
  const a1 = await call("POST", "/api/account/addresses", { jar: A, body: { label: "Гэр", city: "ub", district: d0, khoroo: "3", address: "Энхтайваны өргөн чөлөө 1" } });
  ok("address: first one is the default", a1.status === 201 && a1.data.address.isDefault === true, a1.data);
  const a2 = await call("POST", "/api/account/addresses", { jar: A, body: { label: "Ажил", city: "countryside", district: "Дархан-Уул", address: "Дархан, 5-р хороолол" } });
  ok("address: second one is not default", a2.status === 201 && a2.data.address.isDefault === false, a2.data);
  const mk = await call("PATCH", `/api/account/addresses/${a2.data.address.id}`, { jar: A, body: { isDefault: true } });
  const defaults = mk.data.items?.filter((x) => x.isDefault) ?? [];
  ok("address: make default moves it (exactly one default)", mk.status === 200 && defaults.length === 1 && defaults[0].id === a2.data.address.id, mk.data);
  const ed = await call("PATCH", `/api/account/addresses/${a1.data.address.id}`, { jar: A, body: { address: "Шинэ гудамж 22" } });
  ok("address: edit", ed.status === 200 && ed.data.items.find((x) => x.id === a1.data.address.id)?.address === "Шинэ гудамж 22", ed.data);
  // someone else cannot touch it
  const O = new Jar();
  await register(O, freshPhone());
  const foreign = await call("PATCH", `/api/account/addresses/${a1.data.address.id}`, { jar: O, body: { address: "Hijacked 12345" } });
  const foreignDel = await call("DELETE", `/api/account/addresses/${a1.data.address.id}`, { jar: O });
  ok("address: another customer's address -> 404", foreign.status === 404 && foreignDel.status === 404, `${foreign.status} ${foreignDel.status}`);
  const delDef = await call("DELETE", `/api/account/addresses/${a2.data.address.id}`, { jar: A });
  ok("address: deleting the default makes the remaining one default", delDef.status === 200 && delDef.data.items.length === 1 && delDef.data.items[0].isDefault === true, delDef.data);
  for (let i = 0; i < 9; i++) await call("POST", "/api/account/addresses", { jar: A, body: { city: "ub", district: d0, address: `Extra street ${i} 123` } });
  const eleventh = await call("POST", "/api/account/addresses", { jar: A, body: { city: "ub", district: d0, address: "One too many 123" } });
  ok("address: at most 10 -> 409 limit", eleventh.status === 409 && eleventh.data.errors?.form === "limit", eleventh.data);

  /* ----- order linkage ----- */
  originalSettings = (await admin("GET", "/api/admin/settings")).data?.settings ?? null;
  await admin("PUT", "/api/admin/settings", { "checkout.open": true, "payments.bank.enabled": true });
  const pid = `tacct-${RUN}`;
  sql(`INSERT INTO products (id, brand, name, status, sale_locked) VALUES (${q(pid)}, 'TestBrand', 'Acct test', 'active', 0);
       INSERT INTO skus (id, product_id, ml, kind, price, stock, active) VALUES (${q(`${pid}:5`)}, ${q(pid)}, 5, 'decant', 11000, NULL, 1);`);
  const orderBody = (extra = {}) => ({
    name: "Order Person", phone: "99112233", phone2: "", city: "ub", district: d0, khoroo: "1", address: "Order street 1, apt 2",
    note: "", payment: "bank", locale: "mn", items: [{ sku: `${pid}:5`, qty: 1 }], turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", website: "", ...extra,
  });
  const signedOrder = await call("POST", "/api/orders", { jar: A, body: orderBody({ customerId: 999999, customer_id: 999999 }), headers: { "Idempotency-Key": crypto.randomUUID() } });
  ok("order: placed while signed in", signedOrder.status === 201, signedOrder.data);
  ok("order: linked to the session's customer (body's customerId ignored)", one(`SELECT customer_id FROM orders WHERE order_no = ${q(signedOrder.data.orderNo)}`)?.customer_id === cid);
  const guestOrder = await call("POST", "/api/orders", { body: orderBody(), headers: { "Idempotency-Key": crypto.randomUUID() } });
  ok("order: guest checkout still works and is not linked", guestOrder.status === 201 && one(`SELECT customer_id FROM orders WHERE order_no = ${q(guestOrder.data.orderNo)}`)?.customer_id === null, guestOrder.data);
  const mine = await call("GET", "/api/account/orders", { jar: A, origin: null });
  const nos = (mine.data.items ?? []).map((o) => o.orderNo);
  ok("my orders: signed-in order + claimed order, not the guest one", nos.includes(signedOrder.data.orderNo) && nos.includes(claimNo) && !nos.includes(guestOrder.data.orderNo), nos);
  const first = mine.data.items?.find((o) => o.orderNo === signedOrder.data.orderNo);
  ok("my orders: status, payment status, total and items from D1", first?.status === "new" && first.paymentStatus === "unpaid" && first.total === signedOrder.data.total && first.items[0]?.sku === `${pid}:5`, first);
  ok("my orders: no name / phone / address returned", !/Order Person|99112233|Order street|Guest Name|Guest street/.test(JSON.stringify(mine.data)));
  await admin("PATCH", `/api/admin/orders/${signedOrder.data.orderNo}`, { status: "cancelled" });
  const live = await call("GET", "/api/account/orders", { jar: A, origin: null });
  ok("my orders: live status follows the admin change", live.data.items.find((o) => o.orderNo === signedOrder.data.orderNo)?.status === "cancelled");

  /* ----- wishlist merge ----- */
  const wi = (slug, extra = {}) => ({ slug, brand: "Brand", name: `Name ${slug}`, href: `/delguur/${slug}/`, ml: 5, cart: { sku: `${slug}:5`, slug, name: "N", brand: "B", family: "woody", shape: "round" }, ...extra });
  const w1 = await call("PUT", "/api/account/wishlist", { jar: A, body: { mode: "merge", items: [wi("wa"), wi("wb")] } });
  ok("wishlist: merge into empty", w1.status === 200 && w1.data.items.map((i) => i.slug).join() === "wa,wb", w1.data);
  const D = new Jar();
  await login(D, P1, NEWPW);
  const w2 = await call("PUT", "/api/account/wishlist", { jar: D, body: { mode: "merge", items: [wi("wb"), wi("wc"), wi("evil", { href: "javascript:alert(1)" }), wi("evil2", { img: "http://x/a.png" })] } });
  const slugs2 = w2.data.items.map((i) => i.slug).sort().join();
  ok("wishlist: merge from another device = union, unsafe items dropped", slugs2 === "wa,wb,wc", slugs2);
  const w3 = await call("PUT", "/api/account/wishlist", { jar: A, body: { mode: "replace", items: [wi("wc")] } });
  ok("wishlist: replace", w3.status === 200 && w3.data.items.map((i) => i.slug).join() === "wc", w3.data);
  const w4 = await call("GET", "/api/account/wishlist", { jar: D, origin: null });
  ok("wishlist: GET from the other device sees the same list", w4.data.items.map((i) => i.slug).join() === "wc" && w4.data.items[0].cart?.sku === "wc:5", w4.data);
  const wbad = await call("PUT", "/api/account/wishlist", { jar: A, body: { mode: "nope", items: [] } });
  ok("wishlist: bad mode -> 400", wbad.status === 400);

  /* ----- sessions, logout, logout-all ----- */
  const sl = await call("GET", "/api/account/sessions", { jar: A, origin: null });
  ok("sessions: listed with the current one flagged, no ids", sl.status === 200 && sl.data.items.filter((s) => s.current).length === 1 && !JSON.stringify(sl.data).includes(sha256(tokenOf(A))), sl.data);
  const E = new Jar();
  await login(E, P1, NEWPW);
  const lo = await call("POST", "/api/account/logout", { jar: E });
  ok("logout: cookies cleared and session row deleted", lo.status === 200 && !E.get("__Host-gz_session") && !E.get("gz_in") && (await me(E)).data.customer === null);
  const la = await call("POST", "/api/account/logout-all", { jar: D });
  ok("logout-all: every device signed out", la.status === 200 && la.data.ended >= 2 && (await me(A)).data.customer === null && (await me(D)).data.customer === null, la.data);

  /* ----- admin: list + reset password ----- */
  const noTok = await call("GET", "/api/admin/customers", { origin: null });
  const staffList = await call("GET", "/api/admin/customers", { auth: STAFF, origin: null });
  ok("admin customers: no token -> 401, staff -> 403 (owner only)", noTok.status === 401 && staffList.status === 403, `${noTok.status} ${staffList.status}`);
  const list = await call("GET", `/api/admin/customers?q=${P1}`, { auth: ADMIN, origin: null });
  const row = list.data.items?.find((c) => c.id === cid);
  ok("admin customers: owner lists them (search by phone), no hashes", row?.phone === P1 && row.orders >= 2 && !JSON.stringify(list.data).includes("hash"), list.data);
  const F = new Jar();
  await login(F, P1, NEWPW);
  const staffReset = await call("POST", `/api/admin/customers/${cid}/reset-password`, { auth: STAFF });
  ok("admin reset: staff -> 403", staffReset.status === 403);
  const rs = await call("POST", `/api/admin/customers/${cid}/reset-password`, { auth: ADMIN });
  ok("admin reset: owner gets a one-time temporary password", rs.status === 200 && /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/.test(rs.data.tempPassword ?? ""), rs.data);
  ok("admin reset: customer's sessions ended", (await me(F)).data.customer === null);
  const audit = one(`SELECT actor, action, entity, entity_id, data_json FROM audit_log WHERE action = 'customer.reset_password' AND entity_id = ${q(String(cid))} ORDER BY id DESC LIMIT 1`);
  ok("admin reset: audit-logged without PII or the password", audit?.actor === "admin:owner" && audit.entity === "customer" && !String(audit.data_json ?? "").includes(P1) && !String(audit.data_json ?? "").includes(rs.data.tempPassword), audit);
  const G = new Jar();
  const tl = await login(G, P1, rs.data.tempPassword);
  ok("admin reset: temp password works and asks for a new one", tl.status === 200 && tl.data.customer.mustChangePassword === true, tl.data);
  const FINALPW = `Final-${RUN}-Passw0rd`;
  const ch = await call("POST", "/api/account/password", { jar: G, body: { current: rs.data.tempPassword, next: FINALPW } });
  ok("admin reset: after choosing a new password the flag clears", ch.status === 200 && (await me(G)).data.customer.mustChangePassword === false);

  /* ----- account deletion ----- */
  sql(`UPDATE orders SET status = 'done' WHERE order_no = ${q(claimNo)}`);
  const openNo = orderNo("OPN1");
  sql(guestOrderSql(openNo, P1, "paid", String(cid)));
  const delWrong = await call("POST", "/api/account/delete", { jar: G, body: { password: "nope-nope-1" } });
  ok("delete: wrong password -> 422", delWrong.status === 422 && delWrong.data.errors?.password === "wrong", delWrong.data);
  const del = await call("POST", "/api/account/delete", { jar: G, body: { password: FINALPW } });
  ok("delete: 200 and cookies cleared", del.status === 200 && !G.get("__Host-gz_session"), del.data);
  const tomb = one(`SELECT phone, name, password_hash, deleted_at, avatar_key, google_sub, email FROM customers WHERE id = ${cid}`);
  ok("delete: customer row anonymised (tombstone)", tomb.phone === null && tomb.name === "" && tomb.password_hash === null && tomb.deleted_at !== null, tomb);
  ok("delete: sessions, addresses and wishlist removed",
    one(`SELECT (SELECT COUNT(*) FROM customer_sessions WHERE customer_id = ${cid}) + (SELECT COUNT(*) FROM customer_addresses WHERE customer_id = ${cid}) + (SELECT COUNT(*) FROM customer_wishlist WHERE customer_id = ${cid}) AS n`).n === 0);
  const doneRow = one(`SELECT name, phone, address, total, customer_id FROM orders WHERE order_no = ${q(claimNo)}`);
  ok("delete: finished order kept for accounting, PII removed", doneRow.total === 2000 && doneRow.name === "-" && doneRow.phone === "00000000" && doneRow.address === "-", doneRow);
  const openRow = one(`SELECT name, phone FROM orders WHERE order_no = ${q(openNo)}`);
  ok("delete: open (paid, not delivered) order keeps its delivery details", openRow.name === "Guest Name" && openRow.phone === P1, openRow);
  ok("delete: old phone + password no longer sign in", (await login(new Jar(), P1, FINALPW)).status === 401);
  const again = await register(new Jar(), P1);
  ok("delete: the phone can sign up again (new account)", again.status === 201 && again.data.customer.id !== cid, again.data);

  /* ----- Google ----- */
  const gProbe = await call("GET", "/api/account/google/start", { origin: null });
  if (gProbe.status === 404 || !G_ID) {
    console.log("SKIP  Google block: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_*_URL not set in .dev.vars");
  } else {
    await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
    const J = new Jar();
    const st = await call("GET", "/api/account/google/start?mode=login&return=/en/profile/", { jar: J, origin: null });
    const loc = new URL(st.headers.get("location") ?? "http://x/");
    ok("google start: 302 to the auth endpoint with PKCE S256, state, nonce, openid scope",
      st.status === 302 && loc.searchParams.get("code_challenge_method") === "S256" && loc.searchParams.get("code_challenge")?.length === 43 &&
      loc.searchParams.get("state") && loc.searchParams.get("nonce") && /openid/.test(loc.searchParams.get("scope") ?? "") &&
      loc.searchParams.get("redirect_uri") === `${BASE}/api/account/google/callback` && loc.searchParams.get("client_id") === G_ID, st.headers.get("location"));
    const stc = J.get("__Host-gz_goauth");
    ok("google start: signed HttpOnly state cookie (10 min)", !!stc && /HttpOnly/i.test(stc.raw) && /Max-Age=600/.test(stc.raw) && !stc.value.includes(loc.searchParams.get("state")), stc?.raw);

    const SUB = `sub-${RUN}-1`;
    const wrongState = await googleFlow(new Jar(), { make: gClaims(SUB), state: "not-the-state" });
    ok("google callback: state mismatch -> error, no session", wrongState.result === "error" && !(wrongState.cb.headers.getSetCookie?.() ?? []).some((c) => c.startsWith("__Host-gz_session=")), wrongState.result);
    const forged = await call("GET", `/api/account/google/callback?code=x&state=y`, { origin: null, headers: { Cookie: "__Host-gz_goauth=eyJzIjoieSJ9.AAAA" } });
    ok("google callback: forged state cookie -> error", new URL(forged.headers.get("location") ?? "http://x/", BASE).searchParams.get("google") === "error");
    const badAud = await googleFlow(new Jar(), { make: gClaims(SUB, { aud: "someone-else.apps.googleusercontent.com" }) });
    ok("google id token: wrong aud -> error", badAud.result === "error", badAud.result);
    const badIss = await googleFlow(new Jar(), { make: gClaims(SUB, { iss: "https://evil.example" }) });
    ok("google id token: wrong iss -> error", badIss.result === "error", badIss.result);
    const expiredTok = await googleFlow(new Jar(), { make: (x) => ({ ...gClaims(SUB)(x), exp: x.now - 3600, iat: x.now - 7200 }) });
    ok("google id token: expired -> error", expiredTok.result === "error", expiredTok.result);
    const badNonce = await googleFlow(new Jar(), { make: (x) => ({ ...gClaims(SUB)(x), nonce: "other-nonce" }) });
    ok("google id token: nonce mismatch -> error", badNonce.result === "error", badNonce.result);
    const badSig = await googleFlow(new Jar(), { make: gClaims(SUB), key: key2.privateKey, kid: "test-kid-1" });
    ok("google id token: signature by another key -> error", badSig.result === "error", badSig.result);
    const badKid = await googleFlow(new Jar(), { make: gClaims(SUB), key: key2.privateKey, kid: "unknown-kid" });
    ok("google id token: unknown kid -> error", badKid.result === "error", badKid.result);
    tokenCalls = [];
    const gj = new Jar();
    const g1 = await googleFlow(gj, { make: gClaims(SUB) });
    const tc = tokenCalls[0] ?? {};
    ok("google token exchange: code + PKCE verifier + client secret + redirect_uri", tc.grant_type === "authorization_code" && tc.code_verifier?.length >= 43 && tc.redirect_uri === `${BASE}/api/account/google/callback`, tc);
    ok("google login: first time -> new account + session (result new)", g1.result === "new" && !!tokenOf(gj) && new URL(g1.cb.headers.get("location"), BASE).pathname === "/profile/", g1.cb.headers.get("location"));
    const gme = await me(gj);
    ok("google login: phone empty until collected, google linked, e-mail kept", gme.data.customer?.phone === null && gme.data.customer.google === true && gme.data.customer.hasPassword === false && gme.data.customer.email === `${SUB}@example.com`, gme.data);
    const GP = freshPhone();
    sql(guestOrderSql(orderNo("GCL1"), GP));
    const setPhone = await call("PATCH", "/api/account/me", { jar: gj, body: { phone: GP } });
    ok("google account: phone collected without a password, past orders claimed", setPhone.status === 200 && setPhone.data.customer.phone === GP && setPhone.data.claimed === 1, setPhone.data);
    const takenPhone = await call("PATCH", "/api/account/me", { jar: gj, body: { phone: again.data.customer.phone, password: "x" } });
    ok("google account: changing to a phone used by another account -> refused", takenPhone.status === 422 || takenPhone.status === 409, takenPhone.status);
    const g2 = await googleFlow(new Jar(), { make: gClaims(SUB) });
    ok("google login: second time -> same account (result ok)", g2.result === "ok");
    const sameEmail = await googleFlow(new Jar(), { make: gClaims(`sub-${RUN}-2`, { email: `${SUB}@example.com` }) });
    const accounts = Number(one(`SELECT COUNT(*) AS n FROM customers WHERE email = ${q(`${SUB}@example.com`)}`).n);
    ok("google: never merged by e-mail alone (same e-mail, other sub -> separate account)", sameEmail.result === "new" && accounts === 2, accounts);
    const unlinkNoPw = await call("POST", "/api/account/google/unlink", { jar: gj });
    ok("google unlink: refused without a password", unlinkNoPw.status === 409 && unlinkNoPw.data.errors?.form === "no-password", unlinkNoPw.data);
    const linkAnon = await call("GET", "/api/account/google/start?mode=link", { jar: new Jar(), origin: null });
    ok("google link: needs a session (401)", linkAnon.status === 401);
    // phone account links a Google account
    const L = new Jar();
    const LP = freshPhone();
    await register(L, LP);
    const linkTaken = await googleFlow(L, { mode: "link", make: gClaims(SUB) });
    ok("google link: a Google account owned by someone else -> taken", linkTaken.result === "taken", linkTaken.result);
    const SUB3 = `sub-${RUN}-3`;
    const linked = await googleFlow(L, { mode: "link", make: gClaims(SUB3) });
    const lme = await me(L);
    ok("google link: linked to the signed-in phone account", linked.result === "linked" && lme.data.customer.google === true && lme.data.customer.phone === LP, lme.data);
    const viaGoogle = await googleFlow(new Jar(), { make: gClaims(SUB3) });
    ok("google link: then Google sign-in opens that same account", viaGoogle.result === "ok");
    const unl = await call("POST", "/api/account/google/unlink", { jar: L });
    ok("google unlink: allowed with phone + password", unl.status === 200 && unl.data.customer.google === false, unl.data);
  }

  /* ----- method / misc ----- */
  const getLogin = await call("GET", "/api/account/login", { origin: null });
  ok("login: GET -> 405", getLogin.status === 405);
} catch (err) {
  failed++;
  console.error("ERROR", err);
} finally {
  if (originalSettings) await admin("PUT", "/api/admin/settings", { "checkout.open": originalSettings["checkout.open"], "payments.bank.enabled": originalSettings["payments.bank.enabled"] }).catch(() => {});
  mock.close();
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
