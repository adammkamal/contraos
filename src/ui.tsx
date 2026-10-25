import { createContext, useContext, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Code, DecisionKind, DecisionReading } from "./model";

/** When this client last received data from Convex. Truthful: set by the app when a new snapshot arrives. */
export const UpdatedContext = createContext<Date | undefined>(undefined);

export const firstName = (names: Record<Code, string>, c: Code) => (names[c] ?? c).split(" ")[0];

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="20" fill="#0e1e3a" />
      <path d="M20 11.5 12.5 26.5h15L20 11.5Z" stroke="#2fd39a" strokeWidth="2" strokeLinejoin="round" fill="none" />
      <circle cx="20" cy="11.5" r="2.6" fill="#2fd39a" />
      <circle cx="12.5" cy="26.5" r="2.6" fill="#2fd39a" />
      <circle cx="27.5" cy="26.5" r="2.6" fill="#2fd39a" />
    </svg>
  );
}

export function Mark({ code, small }: { code: Code; small?: boolean }) {
  return <span className={"mark" + (small ? " mark--sm" : "")} aria-hidden="true">{code}</span>;
}

type CardTone = "plain" | "navy" | "mint" | "warn";
export function Card({ tone = "plain", hero, className = "", children, label }: { tone?: CardTone; hero?: boolean; className?: string; children: ReactNode; label?: string }) {
  return (
    <section className={`card ${tone === "plain" ? "" : "card--" + tone} ${hero ? "card--hero" : ""} ${className}`} aria-label={label}>
      <div className="card__core">{children}</div>
    </section>
  );
}

export type PillTone = "ok" | "warn" | "danger" | "info" | "idle" | "live";
export function Pill({ tone = "idle", children, className = "" }: { tone?: PillTone; children: ReactNode; className?: string }) {
  return (
    <span className={"state" + (tone === "idle" ? "" : " state--" + tone) + (className ? " " + className : "")}>
      <i className="state__dot" aria-hidden="true" />
      {children}
    </span>
  );
}

const DECISION: Record<DecisionKind, { tone: PillTone; label: string }> = {
  current_accept: { tone: "ok", label: "Accepted" },
  current_escalate: { tone: "warn", label: "Escalated" },
  stale: { tone: "warn", label: "Stale decision" },
  missing: { tone: "idle", label: "No decision yet" },
  historical: { tone: "idle", label: "Earlier proposal" },
};
/** The one place a decision reading becomes visible text. Colour never carries the meaning alone: the word does. */
export function DecisionPill({ reading, suffix = "" }: { reading: DecisionReading; suffix?: string }) {
  const d = DECISION[reading.kind];
  return <Pill tone={d.tone}>{d.label}{suffix}</Pill>;
}

export function Btn({ kind = "primary", island, children, ...rest }: { kind?: "primary" | "mint" | "outline" | "ghost" | "ghost-dark"; island?: boolean; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={`btn btn--${kind} ${rest.className ?? ""}`}>
      {children}
      {island && <span className="btn__island" aria-hidden="true">↗</span>}
    </button>
  );
}

export function Field({ label, hint, unit, prefix, children }: { label: string; hint?: string; unit?: string; prefix?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <span className="field__shell">
        {prefix && <span className="field__prefix" aria-hidden="true">{prefix}</span>}
        {children}
        {unit && <span className="field__unit">{unit}</span>}
      </span>
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}

export function PageHead({ title, sub, action, compact }: { title: string; sub: string; action?: ReactNode; compact?: boolean }) {
  const updated = useContext(UpdatedContext);
  const time = updated?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return (
    <header className={"page-head" + (compact ? " page-head--compact" : "")}>
      <div>
        <h1 className="page-head__title">{title}</h1>
        <p className="page-head__sub">{time ? `Updated ${time} from Convex. ` : ""}{sub}</p>
      </div>
      {action}
    </header>
  );
}

/** Proportional meter with a limit/floor marker, scaled so the larger of amount and limit sits at ~83%. */
export function Meter({ amount, bound, boundLabel, tone }: { amount: number; bound?: number; boundLabel: string; tone: "ok" | "warn" | "navy" }) {
  const scale = Math.max(amount, bound ?? 0) * 1.2 || 1;
  const pct = (n: number) => Math.min(100, Math.max(0, (n / scale) * 100));
  return (
    <div className="meter" role="img" aria-label={`${boundLabel}: amount ${amount / 100} dollars`}>
      <span className={"meter__fill" + (tone === "ok" ? "" : " meter__fill--" + tone)} style={{ width: pct(amount) + "%" }} />
      {bound !== undefined && <span className="meter__mark" style={{ left: pct(bound) + "%" }} />}
      {bound !== undefined && <span className="meter__label" style={{ left: pct(bound) + "%" }}>{boundLabel}</span>}
    </div>
  );
}

export function Footer({ names }: { names: Record<Code, string> }) {
  return (
    <footer className="footer">
      <span>Synthetic data for {firstName(names, "A")}, {firstName(names, "B")} and {firstName(names, "C")}. ContraOS never executes a payment.</span>
      <span className="footer__tag">Agents coordinate, and humans govern</span>
    </footer>
  );
}
