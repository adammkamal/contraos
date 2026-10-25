import type { ReactNode } from "react";
import type { DecisionKind, DecisionReading } from "./model";

export function Section({ title, note, aside, children }: { title: string; note?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <div>
          <h2>{title}</h2>
          {note && <p>{note}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

export type Tone = "ok" | "warn" | "muted";

/** Status is carried by text colour and wording alone: no dots, pills or glows. */
export function State({ tone, label }: { tone: Tone; label: string }) {
  return <span className={"st st-" + tone}>{label}</span>;
}

const DECISION: Record<DecisionKind, { tone: Tone; label: string }> = {
  current_accept: { tone: "ok", label: "Accepted" },
  current_escalate: { tone: "warn", label: "Escalated" },
  stale: { tone: "warn", label: "Stale decision" },
  missing: { tone: "muted", label: "No decision yet" },
  historical: { tone: "muted", label: "Earlier proposal" },
};

/** The one place a decision reading becomes visible text; Overview and Officer both use it. */
export function DecisionMark({ reading }: { reading: DecisionReading }) {
  return <State {...DECISION[reading.kind]} />;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
