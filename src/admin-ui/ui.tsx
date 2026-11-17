// Small shared pieces for the admin views: session context, async loader, messages, badges, confirm.
import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";
import type { Permission, Role } from "../lib/contracts";
import { api, rows, type Res } from "./api";

export interface Ctx { role: Role; can: (p: Permission) => boolean }
export const SessionCtx = createContext<Ctx>({ role: "staff", can: () => false });
export const useSession = () => useContext(SessionCtx);

export const go = (hash: string) => { location.hash = hash; };

/** Runs `fn` on mount and whenever deps change; `reload()` re-runs it. Ignores stale responses. */
export function useLoad<T>(fn: () => Promise<Res<T>>, deps: unknown[]) {
  const [state, set] = useState<{ loading: boolean; res: Res<T> | null }>({ loading: true, res: null });
  const seq = useRef(0);
  const run = useCallback(async () => {
    const n = ++seq.current;
    set((s) => ({ loading: true, res: s.res }));
    const res = await fn();
    if (n === seq.current) set({ loading: false, res });
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, [run]);
  return { loading: state.loading, res: state.res, data: state.res?.ok ? state.res.data : null, error: state.res && !state.res.ok ? state.res.error : "", reload: run };
}

export function Msg({ text, kind = "info" }: { text: string; kind?: "info" | "ok" | "err" }) {
  if (!text) return null;
  return <p class={`a-msg a-msg--${kind}`} role={kind === "err" ? "alert" : "status"}>{text}</p>;
}

/** A message slot that also remembers success/failure of the last action. */
export function useMsg() {
  const [m, setM] = useState<{ text: string; kind: "info" | "ok" | "err" }>({ text: "", kind: "info" });
  return {
    node: <Msg text={m.text} kind={m.kind} />,
    ok: (text: string) => setM({ text, kind: "ok" }),
    err: (text: string) => setM({ text, kind: "err" }),
    info: (text: string) => setM({ text, kind: "info" }),
    clear: () => setM({ text: "", kind: "info" }),
  };
}

export function Badge({ value, labels, tone }: { value: string; labels: Record<string, string>; tone?: string }) {
  return <span class="a-badge" data-s={tone ?? value}>{labels[value] ?? value ?? "—"}</span>;
}

export function Loading({ on }: { on: boolean }) {
  return on ? <p class="a-dim" role="status">Ачаалж байна…</p> : null;
}

export function Empty({ show, text = "Мэдээлэл алга." }: { show: boolean; text?: string }) {
  return show ? <p class="a-dim a-empty">{text}</p> : null;
}

/** Two-step confirm for destructive actions: first click asks, second confirms. Esc / "Болих" backs out. */
export function ConfirmButton(props: { label: string; question: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; danger?: boolean; testid?: string }) {
  const [asking, setAsking] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (asking) yes.current?.focus(); }, [asking]);
  if (!asking) {
    return (
      <button type="button" class={`a-btn${props.danger ? " a-btn--danger" : ""}`} disabled={props.disabled} data-testid={props.testid} onClick={() => setAsking(true)}>
        {props.label}
      </button>
    );
  }
  return (
    <span class="a-confirm" role="group" aria-label={props.question} onKeyDown={(e) => e.key === "Escape" && setAsking(false)}>
      <span class="a-confirm__q">{props.question}</span>
      <button ref={yes} type="button" class="a-btn a-btn--danger" data-confirm onClick={() => { setAsking(false); props.onConfirm(); }}>{props.confirmLabel}</button>
      <button type="button" class="a-btn a-btn--ghost" onClick={() => setAsking(false)}>Болих</button>
    </span>
  );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ComponentChildren; wide?: boolean }) {
  return (
    <label class={`a-field${wide ? " a-field--wide" : ""}`}>
      <span class="a-field__label">{label}</span>
      {children}
      {hint && <span class="a-field__hint">{hint}</span>}
    </label>
  );
}

export function Table({ head, children, label }: { head: string[]; children: ComponentChildren; label: string }) {
  return (
    <div class="a-scroll" role="region" aria-label={label} tabIndex={0}>
      <table class="a-table">
        <thead><tr>{head.map((h) => <th scope="col">{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Keyset list (`{ items, nextCursor }`): first page on deps change, `more()` appends the next one. */
export function useKeyset<T>(path: (cursor: string | number | null) => string, deps: unknown[], map: (r: any) => T = (r) => r) {
  const [s, set] = useState<{ items: T[]; cursor: string | number | null; loading: boolean; error: string }>({ items: [], cursor: null, loading: true, error: "" });
  const seq = useRef(0);
  async function load(reset: boolean, cursor: string | number | null) {
    const n = ++seq.current;
    set((p) => ({ ...p, loading: true }));
    const res = await api(path(reset ? null : cursor));
    if (n !== seq.current) return;
    if (!res.ok) { set((p) => ({ ...p, loading: false, error: res.error })); return; }
    const list = rows(res.data).map(map);
    set((p) => ({ items: reset ? list : [...p.items, ...list], cursor: res.data.nextCursor ?? null, loading: false, error: "" }));
  }
  useEffect(() => { load(true, null); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...s, more: () => load(false, s.cursor), reload: () => load(true, null) };
}

/** Integer from a text input: "" -> null, otherwise a whole number or NaN. */
export const intOrNull = (v: string): number | null => {
  const t = v.trim().replace(/[\s,]/g, "");
  if (!t) return null;
  return /^-?\d+$/.test(t) ? Number(t) : NaN;
};
