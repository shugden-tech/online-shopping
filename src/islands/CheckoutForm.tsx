import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { navigate } from "astro:transitions/client";
import { cartCheck, cartItems, cartOpen, deliveryFor, type CartItem } from "../lib/cart";
import { useSig } from "../lib/use-signal";
import { formatPrice } from "../lib/price";
import { Bottle, initialOf } from "./Bottle";
import {
  FIELD_ORDER, validateOrderForm, type FormErrors, type OrderField, type OrderFormValues,
} from "../lib/order-validate";
import { fill, type Dict, type Locale } from "../i18n/lite";
import type { StoreMeta } from "../lib/store-state";

type Tr = Dict["checkout"];
type CartTr = Pick<Dict["cart"], "removed" | "capped" | "priceUpdated" | "checking">;

export interface CheckoutFormProps {
  locale: Locale;
  tr: Tr;
  ml: string;
  districts: { id: string; label: string }[];
  cartTr: CartTr;
  delivery: { fee: number; freeThreshold: number };
  siteKey: string;
  shopHref: string;
  successHref: string;
}

type FormError = keyof Tr["errors"];
const PAYS = ["bank", "qpay"] as const;

/* Submitting (live re-check, Idempotency-Key, POST /api/orders, error mapping) lives in ../lib/cart-checkout,
 * loaded on submit so it stays out of this page's initial JS. Prices come from the live store state. */

/* Turnstile (the challenge widget) is loaded by ../scripts/turnstile on demand. */
const EMPTY: OrderFormValues = {
  name: "", phone: "", phone2: "", city: "ub", district: "", khoroo: "", address: "", note: "", payment: "bank",
};

export default function CheckoutForm(props: CheckoutFormProps) {
  const { locale, tr, ml, districts, cartTr, delivery, siteKey, shopHref, successHref } = props;
  const items = useSig(cartItems);
  const check = useSig(cartCheck);
  const [mounted, setMounted] = useState(false);
  /** Live switches (checkout open, payment methods); null until the store state loads. */
  const [meta, setMeta] = useState<StoreMeta | null>(null);
  const [lineErr, setLineErr] = useState<{ sku: string; kind: string; name: string } | null>(null);
  const [values, setValues] = useState<OrderFormValues>(EMPTY);
  const [province, setProvince] = useState("");
  const [ubDistrict, setUbDistrict] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<FormError | null>(null);
  const [sending, setSending] = useState(false);
  const [token, setToken] = useState("");
  const tsBox = useRef<HTMLDivElement>(null);
  const tsW = useRef<{ reset(): void; remove(): void }>();
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const live = check.status === "ok";
  const money = (n: number) => (live ? formatPrice(n, locale) : <i class="live-ph live-ph--sm" aria-hidden="true" />);
  const sync = () => import("../lib/cart-sync");
  const refresh = (fresh = false) =>
    sync().then(async (m) => {
      await m.revalidateCart(ml, fresh);
      setMeta(m.storeMeta());
    });

  /* re-check the cart against the live store state: prices, stock, lines that can no longer be bought */
  useEffect(() => {
    setMounted(true);
    void refresh();
    // signed in: fill empty fields from the profile + default address (lazy, only with the gz_in hint cookie)
    if (/(^|; )gz_in=1/.test(document.cookie)) import("../scripts/account-prefill").then((m) => m.apply(setValues, setUbDistrict, setProvince), () => {});
  }, []);

  const empty = mounted && items.length === 0;
  const closed = meta?.checkoutOpen === false;
  const pays = PAYS.filter((p) => !meta || meta.payments[p]);
  const noPay = meta !== null && pays.length === 0;
  const blocked = closed || noPay;
  // keep the chosen payment method one that is switched on
  useEffect(() => {
    if (pays.length && !pays.includes(values.payment as (typeof PAYS)[number])) setValues((s) => ({ ...s, payment: pays[0]! }));
  }, [meta]);

  /* Turnstile widget (../scripts/turnstile, lazy): render explicitly, clean up on unmount (view transitions swap the page) */
  useEffect(() => {
    if (!mounted || empty) return;
    let w: { reset(): void; remove(): void } | undefined;
    let dead = false;
    import("../scripts/turnstile")
      .then((m) => m.mount(tsBox.current!, siteKey, locale, "dark", (t) => {
        setToken(t);
        if (t) setErrors((e) => (e.turnstile ? { ...e, turnstile: undefined } : e));
      }))
      .then((x) => (dead ? x.remove() : (tsW.current = w = x)), (err) => console.warn(err));
    return () => {
      dead = true;
      w?.remove();
      tsW.current = undefined;
    };
  }, [mounted, empty]);

  const resetTurnstile = () => {
    setToken("");
    tsW.current?.reset();
  };

  const subtotal = items.reduce((n, i) => n + i.price * i.qty, 0);
  const fee = deliveryFor(subtotal, delivery.fee, delivery.freeThreshold);
  const total = subtotal + fee;

  const set = (field: OrderField) => (e: JSX.TargetedEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const v = e.currentTarget.value;
    setValues((s) => ({ ...s, [field]: v }));
    if (errors[field]) setErrors((x) => ({ ...x, [field]: undefined }));
  };

  const current = (): OrderFormValues => ({
    ...values,
    district: values.city === "ub" ? ubDistrict : province,
  });

  const focusFirst = (errs: FormErrors) => {
    const first = FIELD_ORDER.find((f) => errs[f]);
    if (!first) return;
    requestAnimationFrame(() => {
      const el = formRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`);
      el?.focus();
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };

  const showFormError = (k: FormError) => {
    setFormError(k);
    requestAnimationFrame(() => alertRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };

  async function onSubmit(e: Event) {
    e.preventDefault();
    if (sending) return;
    if (empty) return showFormError("empty");
    if (closed) return showFormError("closed");
    const v = current();
    const errs = validateOrderForm(v);
    if (!token) errs.turnstile = "turnstileMissing";
    if (Object.values(errs).some(Boolean)) {
      setErrors(errs);
      setFormError("fix");
      focusFirst(errs);
      return;
    }
    setErrors({});
    setFormError(null);
    setLineErr(null);
    setSending(true);
    const website = (formRef.current?.elements.namedItem("website") as HTMLInputElement | null)?.value ?? "";
    let r: Awaited<ReturnType<typeof import("../lib/cart-checkout").placeOrder>>;
    try {
      const m = await import("../lib/cart-checkout");
      r = await m.placeOrder(v, { locale, turnstileToken: token, website, ml, fields: FIELD_ORDER });
    } catch {
      r = { ok: false, form: "network", meta: null };
    }
    if (r.ok) {
      // the success page clears the cart; keep it until we know the order is stored
      const url = `${successHref}?no=${encodeURIComponent(r.orderNo)}`;
      try {
        await navigate(url);
      } catch {
        location.assign(url);
      }
      return;
    }
    setSending(false);
    resetTurnstile();
    if (r.meta) setMeta(r.meta);
    if (r.sku) setLineErr({ sku: r.sku, kind: r.form, name: r.name ?? "" });
    setErrors(r.fields ?? {});
    if (r.form === "fix") {
      setFormError("fix");
      focusFirst(r.fields ?? {});
    } else showFormError(r.form in tr.errors ? (r.form as FormError) : "server");
  }

  /* ---------- small render helpers ---------- */
  const errId = (f: string) => `co-${f}-err`;
  const fieldProps = (f: OrderField | "turnstile") => ({
    id: `co-${f}`,
    "data-field": f,
    "aria-invalid": errors[f] ? ("true" as const) : undefined,
    "aria-describedby": errors[f] ? errId(f) : undefined,
  });
  const Err = ({ f }: { f: OrderField | "turnstile" }) =>
    errors[f] ? (
      <p class="field-error" id={errId(f)}>
        {tr.errors[errors[f]!]}
      </p>
    ) : null;
  const inv = (f: OrderField | "turnstile") => (errors[f] ? "" : undefined);
  const optional = <span class="co__opt">({tr.optional})</span>;

  /* ---------- order summary ---------- */
  const summary = (
    <aside class="co__summary" aria-labelledby="co-sum-title">
      <div class="co__sum-head">
        <h2 class="t-title" id="co-sum-title">{tr.summary}</h2>
        {mounted && items.length > 0 && (
          <button
            type="button"
            class="co__edit text-link"
            data-cart-open
            onClick={() => (cartOpen.value = true)}
          >
            {tr.editCart}
          </button>
        )}
      </div>
      {!mounted ? (
        <div class="co__skel" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </div>
      ) : (
        <>
          {(check.removed.length > 0 || check.capped.length > 0 || check.priceChanged) && (
            <div class="co__notice t-small" role="status">
              {check.removed.length > 0 && <p>{fill(cartTr.removed, { items: check.removed.join(", ") })}</p>}
              {check.capped.length > 0 && <p>{fill(cartTr.capped, { items: check.capped.join(", ") })}</p>}
              {check.priceChanged && <p>{cartTr.priceUpdated}</p>}
            </div>
          )}
          {check.status === "checking" && <p class="sr-only" role="status">{cartTr.checking}</p>}
          <ul class="co__lines">
            {items.map((i: CartItem) => {
              const bad = lineErr?.sku === i.sku ? lineErr.kind : null;
              return (
                <li class="co__line" key={i.sku} data-sku={i.sku} data-unavailable={bad ? "" : undefined}>
                  <div class="co__thumb">
                    <Bottle shape={i.shape} family={i.family} initial={initialOf(i.brand)} img={i.img} />
                    <span class="co__qty" aria-hidden="true">{i.qty}</span>
                  </div>
                  <div class="co__line-text">
                    <p class="co__brand">{i.brand}</p>
                    <p class="co__name">{i.name}</p>
                    {i.parts && i.parts.length > 0 && (
                      <ul class="co__parts">
                        {i.parts.map((p) => <li>{p}</li>)}
                      </ul>
                    )}
                    <p class="co__meta">
                      {i.ml} {ml} × {i.qty}
                    </p>
                    {bad && <p class="co__line-err">{bad === "stockLine" ? tr.lineStock : tr.lineUnavailable}</p>}
                  </div>
                  <p class="co__line-sum">{money(i.price * i.qty)}</p>
                </li>
              );
            })}
          </ul>
          <dl class="co__totals">
            <div>
              <dt>{tr.subtotal}</dt>
              <dd>{money(subtotal)}</dd>
            </div>
            <div>
              <dt>{tr.delivery}</dt>
              <dd class={fee === 0 ? "t-gold" : undefined}>{fee === 0 ? tr.free : money(fee)}</dd>
            </div>
            <div class="co__total">
              <dt>{tr.total}</dt>
              <dd data-total>{money(total)}</dd>
            </div>
          </dl>
        </>
      )}
    </aside>
  );

  if (empty) {
    return (
      <div class="co__empty">
        <p class="t-h3">{tr.emptyCart}</p>
        <a class="btn btn--gold" href={shopHref}>
          {tr.emptyCta}
        </a>
      </div>
    );
  }

  const isUb = values.city === "ub";

  return (
    <div class="co__grid">
      {summary}

      <form class="co__form" ref={formRef} noValidate onSubmit={onSubmit} aria-busy={sending ? "true" : undefined}>
        {blocked && (
          <p class="co__closed" role="status">
            {closed ? tr.closed : tr.noPayment}
          </p>
        )}
        <div class="co__alert" ref={alertRef} role="alert" aria-live="assertive">
          {formError && <p>{fill(tr.errors[formError], { name: lineErr?.name ?? "" })}</p>}
        </div>

        <fieldset class="co__set">
          <legend class="t-title">{tr.contact}</legend>
          <div class="field" data-invalid={inv("name")}>
            <label for="co-name">{tr.name}</label>
            <input
              {...fieldProps("name")}
              class="input"
              name="name"
              autocomplete="name"
              placeholder={tr.namePh}
              maxLength={80}
              value={values.name}
              onInput={set("name")}
              required
            />
            <Err f="name" />
          </div>
          <div class="co__row">
            <div class="field" data-invalid={inv("phone")}>
              <label for="co-phone">{tr.phone}</label>
              <input
                {...fieldProps("phone")}
                class="input"
                name="phone"
                type="tel"
                inputMode="numeric"
                autocomplete="tel-national"
                maxLength={8}
                placeholder={tr.phonePh}
                value={values.phone}
                onInput={set("phone")}
                required
              />
              <Err f="phone" />
            </div>
            <div class="field" data-invalid={inv("phone2")}>
              <label for="co-phone2">
                {tr.phone2} {optional}
              </label>
              <input
                {...fieldProps("phone2")}
                class="input"
                name="phone2"
                type="tel"
                inputMode="numeric"
                autocomplete="off"
                maxLength={8}
                value={values.phone2}
                onInput={set("phone2")}
              />
              <Err f="phone2" />
            </div>
          </div>
        </fieldset>

        <fieldset class="co__set">
          <legend class="t-title">{tr.deliverySection}</legend>
          <div class="field">
            <span class="label" id="co-city-label">{tr.city}</span>
            <div class="co__cities" role="radiogroup" aria-labelledby="co-city-label">
              {(["ub", "countryside"] as const).map((c, n) => (
                <label class="co__city">
                  <input
                    type="radio"
                    name="city"
                    value={c}
                    data-field={n === 0 ? "city" : undefined}
                    checked={values.city === c}
                    onChange={() => {
                      setValues((s) => ({ ...s, city: c }));
                      setErrors((x) => ({ ...x, district: undefined, city: undefined }));
                    }}
                  />
                  <span class="chip">{tr[c]}</span>
                </label>
              ))}
            </div>
          </div>

          {isUb ? (
            <div class="co__row">
              <div class="field" data-invalid={inv("district")}>
                <label for="co-district">{tr.district}</label>
                <select
                  {...fieldProps("district")}
                  class="select"
                  name="district"
                  value={ubDistrict}
                  onChange={(e) => {
                    setUbDistrict(e.currentTarget.value);
                    setErrors((x) => ({ ...x, district: undefined }));
                  }}
                  required
                >
                  <option value="">{tr.districtSelect}</option>
                  {districts.map((d) => (
                    <option value={d.id}>{d.label}</option>
                  ))}
                </select>
                <Err f="district" />
              </div>
              <div class="field" data-invalid={inv("khoroo")}>
                <label for="co-khoroo">
                  {tr.khoroo} {optional}
                </label>
                <input
                  {...fieldProps("khoroo")}
                  class="input"
                  name="khoroo"
                  maxLength={40}
                  placeholder={tr.khorooPh}
                  value={values.khoroo}
                  onInput={set("khoroo")}
                />
                <Err f="khoroo" />
              </div>
            </div>
          ) : (
            <div class="field" data-invalid={inv("district")}>
              <label for="co-district">{tr.province}</label>
              <input
                {...fieldProps("district")}
                class="input"
                name="province"
                maxLength={80}
                autocomplete="address-level1"
                placeholder={tr.provincePh}
                value={province}
                onInput={(e) => {
                  setProvince(e.currentTarget.value);
                  setErrors((x) => ({ ...x, district: undefined }));
                }}
                required
              />
              <Err f="district" />
              <p class="co__hint t-small">{tr.countrysideNote}</p>
            </div>
          )}

          <div class="field" data-invalid={inv("address")}>
            <label for="co-address">{tr.address}</label>
            <textarea
              {...fieldProps("address")}
              class="textarea"
              name="address"
              rows={3}
              maxLength={300}
              autocomplete="street-address"
              placeholder={isUb ? tr.addressPh : tr.addressPhCountry}
              value={values.address}
              onInput={set("address")}
              required
            />
            <Err f="address" />
          </div>
          <div class="field" data-invalid={inv("note")}>
            <label for="co-note">
              {tr.note} {optional}
            </label>
            <textarea
              {...fieldProps("note")}
              class="textarea co__note"
              name="note"
              rows={2}
              maxLength={300}
              placeholder={tr.notePh}
              value={values.note}
              onInput={set("note")}
            />
            <Err f="note" />
          </div>
        </fieldset>

        <fieldset class="co__set" aria-describedby={errors.payment ? errId("payment") : undefined}>
          <legend class="t-title">{tr.payment}</legend>
          <div class="co__pays">
            {pays.map((p, n) => (
              <label class="co__pay">
                <input
                  type="radio"
                  name="payment"
                  value={p}
                  data-field={n === 0 ? "payment" : undefined}
                  checked={values.payment === p}
                  onChange={() => {
                    setValues((s) => ({ ...s, payment: p }));
                    setErrors((x) => ({ ...x, payment: undefined }));
                  }}
                />
                <span class="co__pay-box">
                  <span class="co__pay-dot" aria-hidden="true"></span>
                  <span class="co__pay-name">{tr[p]}</span>
                  <span class="co__pay-hint">{p === "bank" ? tr.bankHint : tr.qpayHint}</span>
                </span>
              </label>
            ))}
          </div>
          <Err f="payment" />
          <p class="co__hint t-small">{tr.paymentNote}</p>
        </fieldset>

        {/* honeypot: hidden from people and assistive tech; bots tend to fill it */}
        <div class="co__hp" aria-hidden="true">
          <label for="co-website">{tr.website}</label>
          <input id="co-website" name="website" type="text" tabIndex={-1} autocomplete="off" />
        </div>

        <div class="co__verify" data-invalid={inv("turnstile")}>
          <p class="sr-only">{tr.verify}</p>
          <div
            class="co__ts"
            ref={tsBox}
            data-field="turnstile"
            tabIndex={-1}
            aria-describedby={errors.turnstile ? errId("turnstile") : undefined}
          ></div>
          <Err f="turnstile" />
        </div>

        <button type="submit" class="btn btn--gold btn--block co__submit" disabled={sending || !mounted || blocked || check.status === "checking"}>
          <span>{sending ? tr.sending : tr.submit}</span>
          {live && !sending && <span class="co__submit-sum">{money(total)}</span>}
        </button>
      </form>
    </div>
  );
}
