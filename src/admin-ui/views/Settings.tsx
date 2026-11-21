// Settings (GET/PUT /api/admin/settings; PUT sends only the changed keys): store open/closed, payment methods,
// holds, delivery fees, bank details and contacts shown to customers, the store notice. Plus read-only help:
// what staff can do, and how a delivery company plugs in.
import { useEffect, useState } from "preact/hooks";
import { ROLE_PERMISSIONS, SETTINGS, type Permission, type SettingKey, type Settings as S } from "../../lib/contracts";
import { api } from "../api";
import { Field, Loading, Msg, intOrNull, useMsg, useSession } from "../ui";

type Form = Record<SettingKey, string | boolean>;
const BOOL = (k: SettingKey) => typeof SETTINGS[k] === "boolean";
const NULLABLE: SettingKey[] = ["delivery.fee_ub", "delivery.fee_countryside", "delivery.free_over"];
const INT: SettingKey[] = ["holds.qpay_minutes", "holds.bank_minutes", ...NULLABLE];

const toForm = (s: S): Form =>
  Object.fromEntries((Object.keys(SETTINGS) as SettingKey[]).map((k) => [k, BOOL(k) ? Boolean(s[k]) : s[k] === null || s[k] === undefined ? "" : String(s[k])])) as Form;

function toValue(k: SettingKey, v: string | boolean): unknown {
  if (BOOL(k)) return v;
  if (INT.includes(k)) return intOrNull(String(v));
  return String(v).trim();
}

const PERM_LABEL: Record<Permission, string> = {
  "catalog.read": "Бараа харах",
  "catalog.write": "Бараа, үнэ засах",
  "inventory.write": "Үлдэгдэл тохируулах",
  "media.write": "Зураг оруулах",
  "orders.read": "Захиалга харах",
  "orders.write": "Захиалгын төлөв солих, тэмдэглэл бичих",
  "payments.read": "Төлбөр харах",
  "payments.write": "Төлбөр баталгаажуулах",
  "delivery.read": "Хүргэлт харах",
  "delivery.write": "Хүргэлт үүсгэх, төлөв солих",
  "settings.read": "Тохиргоо харах",
  "settings.write": "Тохиргоо, webhook өөрчлөх",
  "audit.read": "Үйлдлийн түүх харах",
  "customers.read": "Хэрэглэгчийн бүртгэл харах",
  "customers.write": "Хэрэглэгчийн нууц үг сэргээх",
};

export default function Settings() {
  const { can, role } = useSession();
  const canWrite = can("settings.write");
  const [saved, setSaved] = useState<S | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const msg = useMsg();

  useEffect(() => {
    api<{ settings: S }>("/api/admin/settings").then((res) => {
      if (res.ok) { setSaved(res.data.settings); setForm(toForm({ ...SETTINGS, ...res.data.settings } as S)); } else setError(res.error);
    });
  }, []);

  if (error) return <><h1 class="a-title">Тохиргоо</h1><Msg kind="err" text={error} /></>;
  if (!form || !saved) return <Loading on />;

  const set = (k: SettingKey) => (e: Event) => {
    const t = e.currentTarget as HTMLInputElement;
    setForm({ ...form, [k]: t.type === "checkbox" ? t.checked : t.value });
  };

  async function save(e: Event) {
    e.preventDefault();
    if (!canWrite || !form || !saved) return;
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(SETTINGS) as SettingKey[]) {
      const v = toValue(k, form[k]);
      if (typeof v === "number" && Number.isNaN(v)) { msg.err(`${LABEL[k]}: бүхэл тоо оруулна уу.`); return; }
      if (v === null && !NULLABLE.includes(k)) { msg.err(`${LABEL[k]}: заавал бөглөх ёстой.`); return; }
      if (JSON.stringify(v) !== JSON.stringify(saved[k] ?? SETTINGS[k])) patch[k] = v;
    }
    if (!Object.keys(patch).length) { msg.info("Өөрчлөлт алга."); return; }
    setBusy(true);
    const res = await api<{ settings: S }>("/api/admin/settings", { method: "PUT", body: patch });
    setBusy(false);
    if (res.ok) {
      const next = { ...SETTINGS, ...res.data.settings } as S;
      setSaved(next);
      setForm(toForm(next));
      msg.ok(`Хадгаллаа (${Object.keys(patch).length} тохиргоо). Дэлгүүрт нэг минутын дотор шинэчлэгдэнэ.`);
    } else msg.err(res.error);
  }

  const bool = (k: SettingKey, text: string, hint: string) => (
    <label class="a-switch">
      <input type="checkbox" name={k} checked={form[k] as boolean} onChange={set(k)} />
      <span><b>{text}</b><span class="a-field__hint">{hint}</span></span>
    </label>
  );
  const input = (k: SettingKey, hint?: string, numeric = true, placeholder?: string) => (
    <Field label={LABEL[k]} hint={hint}>
      <input class="a-input" name={k} inputMode={numeric ? "numeric" : undefined} value={form[k] as string} placeholder={placeholder} onInput={set(k)} maxLength={numeric ? undefined : 300} />
    </Field>
  );

  return (
    <section aria-labelledby="set-h" class="a-stack">
      <h1 id="set-h" class="a-title">Тохиргоо</h1>
      {!canWrite && <Msg kind="info" text="Таны эрхээр тохиргоог зөвхөн харах боломжтой." />}

      <form onSubmit={save} data-testid="settings-form">
        <fieldset disabled={!canWrite || busy} class="a-panel a-grid">
          <legend class="a-h2">Дэлгүүр ба төлбөр</legend>
          {bool("checkout.open", "Захиалга авах", "Унтраавал дэлгүүр шинэ захиалга авахгүй (бараа харагдсаар байна).")}
          {bool("payments.qpay.enabled", "QPay-ээр төлөх", "QPay-н нууц түлхүүрүүд серверт тохируулагдсан үед л ажиллана.")}
          {bool("payments.bank.enabled", "Банкны шилжүүлгээр төлөх", "Унтраавал банкаар төлөх сонголт харагдахгүй.")}
        </fieldset>
        <fieldset disabled={!canWrite || busy} class="a-panel a-grid">
          <legend class="a-h2">Хүргэлтийн үнэ</legend>
          {input("delivery.fee_ub", "Хоосон бол үндсэн утга")}
          {input("delivery.fee_countryside", "Хоосон бол үндсэн утга")}
          {input("delivery.free_over", "Энэ дүнгээс дээш захиалгад хүргэлт үнэгүй. Хоосон бол үндсэн утга.")}
          {input("delivery.provider", "manual = гараар (одоогийн тохиргоо)", false)}
        </fieldset>
        <fieldset disabled={!canWrite || busy} class="a-panel a-grid">
          <legend class="a-h2">Банкны мэдээлэл (хэрэглэгчид харагдана)</legend>
          {input("bank.name", "Хоосон бол сайтын үндсэн утга", false, "ж: Хаан банк")}
          {input("bank.account", undefined, false, "0000 0000 00")}
          {input("bank.holder", undefined, false)}
        </fieldset>
        <fieldset disabled={!canWrite || busy} class="a-panel a-grid">
          <legend class="a-h2">Холбоо барих</legend>
          {input("contact.phone", "Сайтын доод хэсэгт харагдана", false, "+976 …")}
          {input("contact.hours_mn", undefined, false, "Даваа–Бямба · 11:00–19:00")}
          {input("contact.hours_en", undefined, false, "Mon–Sat · 11:00–19:00")}
          {input("contact.instagram", "https:// хаяг", false)}
          {input("contact.facebook", "https:// хаяг", false)}
          {input("contact.telegram", "https:// хаяг", false)}
        </fieldset>
        <fieldset disabled={!canWrite || busy} class="a-panel a-grid">
          <legend class="a-h2">Мэдэгдэл ба нөөцлөлтийн хугацаа</legend>
          <Field label={LABEL["store.notice_mn"]} hint="Сайтын дээд хэсэгт харагдана. Хоосон бол харагдахгүй. 300 тэмдэгт хүртэл." wide>
            <textarea class="a-input" name="store.notice_mn" rows={2} maxLength={300} value={form["store.notice_mn"] as string} onInput={set("store.notice_mn")} />
          </Field>
          <Field label={LABEL["store.notice_en"]} wide>
            <textarea class="a-input" name="store.notice_en" rows={2} maxLength={300} value={form["store.notice_en"] as string} onInput={set("store.notice_en")} />
          </Field>
          {input("holds.qpay_minutes", "5–10080 минут")}
          {input("holds.bank_minutes", "5–10080 минут")}
        </fieldset>
        {canWrite && <button class="a-btn a-btn--primary" type="submit" disabled={busy} data-testid="save-settings">{busy ? "Хадгалж байна…" : "Хадгалах"}</button>}
        {msg.node}
      </form>

      <aside class="a-panel a-explain" aria-labelledby="ex-h">
        <h2 id="ex-h" class="a-h2">Нуух ба түгжих 4 арга</h2>
        <dl class="a-dl">
          <dt>1. Бараа нуух</dt><dd>Бараа → засах → <b>Төлөв</b> “Нуусан” эсвэл “Ноорог”. Бараа дэлгүүрт огт харагдахгүй.</dd>
          <dt>2. Худалдаа түгжих</dt><dd>Бараа → засах → <b>Худалдаа түгжих</b>. Бараа харагдах боловч худалдан авах боломжгүй.</dd>
          <dt>3. Төлбөрийн арга унтраах</dt><dd>Дээрх <b>QPay / Банкны шилжүүлэг</b>. Зөвхөн тухайн аргаар төлөх боломжгүй болно.</dd>
          <dt>4. Захиалга зогсоох</dt><dd>Дээрх <b>Захиалга авах</b>-ыг унтраавал дэлгүүр бүхэлдээ шинэ захиалга авахгүй.</dd>
        </dl>
      </aside>

      <aside class="a-panel" aria-labelledby="roles-h" data-testid="roles">
        <h2 id="roles-h" class="a-h2">Эрхийн түвшин</h2>
        <p class="a-small a-dim" style="margin-top:-6px">Та одоо <b>{role === "owner" ? "эзэмшигч" : "ажилтан"}</b> эрхээр нэвтэрсэн байна. Ажилтны нэвтрэх мэдээллийг серверийн нууц утгаар (<code class="a-kbd">STAFF_USERNAME</code>, <code class="a-kbd">STAFF_PASSWORD</code>, <code class="a-kbd">STAFF_TOKEN</code>) тохируулна. Тохируулаагүй бол ажилтны эрхээр нэвтрэх боломжгүй.</p>
        <div class="a-scroll">
          <table class="a-table">
            <thead><tr><th scope="col">Эрх</th><th scope="col">Эзэмшигч</th><th scope="col">Ажилтан</th></tr></thead>
            <tbody>
              {(Object.keys(PERM_LABEL) as Permission[]).map((p) => (
                <tr><td>{PERM_LABEL[p]}</td><td>✓</td><td>{ROLE_PERMISSIONS.staff.includes(p) ? "✓" : <span class="a-dim">—</span>}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </aside>

      <aside class="a-panel" aria-labelledby="dlv-h">
        <h2 id="dlv-h" class="a-h2">Хүргэлтийн компани холбох</h2>
        <p class="a-small" style="margin-top:0">Одоогоор хүргэлтийг <b>гараар</b> (manual) хийж байна: захиалга төлөгдсөний дараа “Хүргэлт үүсгэх”-ээр хүргэгч, хяналтын дугаар, зардлаа оруулж, төлвийг нь өөрөө шинэчилнэ. Хүргэлт “Авч явсан” болоход захиалга “Хүргэлтэд гарсан”, “Хүргэгдсэн” болоход “Дууссан” болно.</p>
        <p class="a-small">Хүргэлтийн компани сонгосны дараа холбох алхам:</p>
        <ol class="a-small" style="margin:0;padding-left:18px;display:grid;gap:4px">
          <li>Компаниас API баримт бичиг, туршилтын (sandbox) хаяг, API түлхүүр, webhook-ийн гарын үсгийн дүрмийг авна.</li>
          <li>Хөгжүүлэгч <code class="a-kbd">src/lib/delivery/adapters/</code> хавтсанд тухайн компанийн adapter бичнэ (create, cancel, track, parseWebhook). Загвар: <code class="a-kbd">src/lib/delivery/README.md</code>.</li>
          <li>Серверт нууц утга тохируулна: <code class="a-kbd">DELIVERY_BASE_URL</code>, <code class="a-kbd">DELIVERY_API_KEY</code>, <code class="a-kbd">DELIVERY_WEBHOOK_SECRET</code>.</li>
          <li>Компанид webhook хаяг өгнө: <code class="a-kbd">{location.origin}/api/delivery/webhook/&lt;компанийн-код&gt;</code>. Ирсэн дуудлага бүр “Хүргэлт → Ирсэн webhook” хэсэгт харагдана.</li>
          <li>Дээрх “Хүргэлтийн компани (код)”-д компанийн кодыг оруулж хадгална. Шинэ хүргэлт автоматаар компанид илгээгдэж, амжилтгүй бол 8 хүртэл удаа дахин оролдоно.</li>
        </ol>
      </aside>
    </section>
  );
}

const LABEL: Record<SettingKey, string> = {
  "checkout.open": "Захиалга авах",
  "payments.qpay.enabled": "QPay",
  "payments.bank.enabled": "Банкны шилжүүлэг",
  "holds.qpay_minutes": "QPay захиалгыг нөөцлөх хугацаа (минут)",
  "holds.bank_minutes": "Банкны захиалгыг нөөцлөх хугацаа (минут)",
  "delivery.fee_ub": "Улаанбаатар доторх хүргэлт ₮",
  "delivery.fee_countryside": "Орон нутгийн хүргэлт ₮",
  "delivery.free_over": "Үнэгүй хүргэлтийн босго ₮",
  "delivery.provider": "Хүргэлтийн компани (код)",
  "store.notice_mn": "Мэдэгдэл (монгол)",
  "store.notice_en": "Мэдэгдэл (англи)",
  "bank.name": "Банк",
  "bank.account": "Дансны дугаар",
  "bank.holder": "Данс эзэмшигч",
  "contact.phone": "Утас",
  "contact.hours_mn": "Ажлын цаг (монгол)",
  "contact.hours_en": "Ажлын цаг (англи)",
  "contact.instagram": "Instagram",
  "contact.facebook": "Facebook",
  "contact.telegram": "Telegram",
};
