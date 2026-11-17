// Store controls (GET/PUT /api/admin/settings). PUT sends only the changed keys.
import { useEffect, useState } from "preact/hooks";
import { SETTINGS, type SettingKey, type Settings as S } from "../../lib/contracts";
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

export default function Settings() {
  const { can } = useSession();
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

  if (error) return <><h1 class="a-title">Дэлгүүрийн тохиргоо</h1><Msg kind="err" text={error} /></>;
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
      if (v === null && !NULLABLE.includes(k)) { msg.err(`${LABEL[k]}: заавал бөглөнө.`); return; }
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
      msg.ok(`Хадгаллаа (${Object.keys(patch).length} тохиргоо).`);
    } else msg.err(res.error);
  }

  const bool = (k: SettingKey, text: string, hint: string) => (
    <label class="a-switch">
      <input type="checkbox" name={k} checked={form[k] as boolean} onChange={set(k)} />
      <span><b>{text}</b><span class="a-field__hint">{hint}</span></span>
    </label>
  );
  const input = (k: SettingKey, hint?: string, numeric = true) => (
    <Field label={LABEL[k]} hint={hint}>
      <input class="a-input" name={k} inputMode={numeric ? "numeric" : undefined} value={form[k] as string} onInput={set(k)} />
    </Field>
  );

  return (
    <section aria-labelledby="set-h" class="a-stack">
      <h1 id="set-h" class="a-title">Дэлгүүрийн тохиргоо</h1>
      {!canWrite && <Msg kind="info" text="Таны эрхээр тохиргоог зөвхөн харах боломжтой." />}

      <aside class="a-panel a-explain" aria-labelledby="ex-h">
        <h2 id="ex-h" class="a-h2">Нуух / түгжих 4 удирдлага</h2>
        <dl class="a-dl">
          <dt>1. Бараа нуух</dt><dd>Бараа → засах → <b>Барааны төлөв</b> “Нуусан” эсвэл “Ноорог”. Бараа дэлгүүрт огт харагдахгүй.</dd>
          <dt>2. Худалдаа түгжих</dt><dd>Бараа → засах → <b>Худалдаа түгжих</b>. Бараа харагдана, гэхдээ сагсанд нэмэх/худалдан авах боломжгүй.</dd>
          <dt>3. Төлбөрийн арга унтраах</dt><dd>Доорх <b>QPay / Банкны шилжүүлэг</b>. Зөвхөн тэр аргаар төлөх боломжгүй болно.</dd>
          <dt>4. Захиалга хаах</dt><dd>Доорх <b>Захиалга авах</b>. Унтраавал бүх дэлгүүрт шинэ захиалга авахгүй.</dd>
        </dl>
      </aside>

      <form onSubmit={save} data-testid="settings-form">
        <fieldset disabled={!canWrite || busy} class="a-panel a-grid">
          <legend class="a-h2">Захиалга ба төлбөр</legend>
          {bool("checkout.open", "Захиалга авах (checkout нээлттэй)", "Унтраавал = захиалга хаалттай.")}
          {bool("payments.qpay.enabled", "QPay төлбөр идэвхтэй", "QPay-н нууц түлхүүрүүд серверт тохируулагдсан үед л ажиллана.")}
          {bool("payments.bank.enabled", "Банкны шилжүүлэг идэвхтэй", "Унтраавал банкаар төлөх сонголт харагдахгүй.")}
        </fieldset>
        <fieldset disabled={!canWrite || busy} class="a-panel a-grid">
          <legend class="a-h2">Нөөц хадгалах хугацаа</legend>
          {input("holds.qpay_minutes", "5–10080 минут")}
          {input("holds.bank_minutes", "5–10080 минут")}
        </fieldset>
        <fieldset disabled={!canWrite || busy} class="a-panel a-grid">
          <legend class="a-h2">Хүргэлт</legend>
          {input("delivery.fee_ub", "Хоосон = үндсэн тохиргоо")}
          {input("delivery.fee_countryside", "Хоосон = үндсэн тохиргоо")}
          {input("delivery.free_over", "Хоосон = үндсэн тохиргоо")}
          {input("delivery.provider", "manual = гараар трак оруулна", false)}
        </fieldset>
        <fieldset disabled={!canWrite || busy} class="a-panel a-grid">
          <legend class="a-h2">Дэлгүүрийн мэдэгдэл</legend>
          <Field label={LABEL["store.notice_mn"]} hint="Хоосон = харуулахгүй. 300 тэмдэгт хүртэл." wide>
            <textarea class="a-input" name="store.notice_mn" rows={2} maxLength={300} value={form["store.notice_mn"] as string} onInput={set("store.notice_mn")} />
          </Field>
          <Field label={LABEL["store.notice_en"]} wide>
            <textarea class="a-input" name="store.notice_en" rows={2} maxLength={300} value={form["store.notice_en"] as string} onInput={set("store.notice_en")} />
          </Field>
        </fieldset>
        {canWrite && <button class="a-btn a-btn--primary" type="submit" disabled={busy} data-testid="save-settings">{busy ? "Хадгалж байна…" : "Хадгалах"}</button>}
        {msg.node}
      </form>
    </section>
  );
}

const LABEL: Record<SettingKey, string> = {
  "checkout.open": "Захиалга авах",
  "payments.qpay.enabled": "QPay",
  "payments.bank.enabled": "Банкны шилжүүлэг",
  "holds.qpay_minutes": "QPay захиалгын нөөц (минут)",
  "holds.bank_minutes": "Банкны захиалгын нөөц (минут)",
  "delivery.fee_ub": "Улаанбаатар хүргэлт ₮",
  "delivery.fee_countryside": "Орон нутаг хүргэлт ₮",
  "delivery.free_over": "Үнэгүй хүргэлтийн босго ₮",
  "delivery.provider": "Хүргэлтийн компани (код)",
  "store.notice_mn": "Мэдэгдэл (монгол)",
  "store.notice_en": "Мэдэгдэл (англи)",
};
