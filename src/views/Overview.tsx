import { useState } from "react";
import { auditLabel, derive, describeRequirement, grossCents, money, positionOf, readingNote, reasonText, requirement, signedMoney, sum, transferTotal, type Code, type Session } from "../model";
import { DecisionMark, Section } from "../ui";

type View = ReturnType<typeof derive>;

const list = (codes: string[]) => (codes.length > 1 ? `${codes.slice(0, -1).join(", ")} and ${codes.at(-1)}` : codes.join(""));

function headline(v: View) {
  const n = v.current ? `V${v.current.version}` : "";
  if (v.phase === "authorized") return `Proposal ${n} is authorized`;
  if (v.phase === "blocked") return `Proposal ${n} is blocked on Company ${list(v.escalated)}`;
  if (v.phase === "reevaluating") return `Proposal ${n} is awaiting re-evaluation`;
  if (v.phase === "pending_authorization") return `Proposal ${n} is not authorized yet`;
  if (v.phase === "superseded") return `Proposal ${n} has been superseded`;
  if (v.phase === "evaluating") return `Proposal ${n} is being evaluated`;
  return "No proposal yet";
}

function explanation(v: View): string {
  if (v.phase === "authorized") {
    if (!v.consistent) return "The server reports this proposal as authorized, but not every recorded decision matches its company's current policy. A policy change reopens authorization, so treat this record as inconsistent and check the audit trail. No payment was executed.";
    return "All three agents accepted under their current policy versions. This is a coordination record: no payment was executed.";
  }
  const reopened = v.reopened ? "A policy change invalidated the earlier authorization. " : "";
  if (v.phase === "pending_authorization") return reopened + "All three agents have a current accept, but the server has not recorded authorization. This proposal is not approved until it does.";
  if (v.phase === "reevaluating") return reopened + `Company ${list(v.stale)} ${v.stale.length > 1 ? "have" : "has"} a decision made under an older policy version. It does not count; authorization waits for a fresh decision under the current policy.`;
  if (v.phase === "evaluating") return reopened + `Waiting for ${v.missing.length === 3 ? "each agent" : `Company ${list(v.missing)}`} to decide under its company's current policy.`;
  if (v.phase === "superseded") return "The session's current proposal is marked superseded; waiting for a replacement.";
  if (v.phase !== "blocked" || !v.current) return "";
  const lines = v.escalated.map((code) => {
    const d = v.decisions.find((x) => x.code === code)?.decision;
    const policy = v.policies[code];
    const r = requirement(positionOf(v.current, code), policy);
    const why = d?.reasons.map(reasonText).join("; ") ?? "";
    return `Agent ${code} escalated: ${why}` + (r.bound !== undefined ? ` (${r.kind === "pay" ? "pays" : "receives"} ${money(r.amount)}, granted ${r.kind === "pay" ? "max" : "min"} ${money(r.bound)}, policy v${policy?.version}).` : ".");
  });
  const accepted = v.decisions.filter((d) => d.reading.approved).map((d) => d.code);
  const notCounted = v.decisions.filter((d) => ["stale", "missing"].includes(d.reading.kind)).map((d) => d.code);
  const tail = (accepted.length ? ` ${list(accepted)} accepted.` : "") + (notCounted.length ? ` ${list(notCounted)} ${notCounted.length > 1 ? "have" : "has"} no current decision.` : "");
  return lines.join(" ") + tail + " Only that company's officer can grant more authority.";
}

export function Overview({ data, view: v, onReviewAuthority, onOpenEvidence }: { data: Session; view: View; onReviewAuthority: (c: Code) => void; onOpenEvidence: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const { current, prior } = v;
  const events = showAll ? data.audit : data.audit.slice(0, 8);
  if (!current) return <p className="muted">No current proposal has been created for this session.</p>;
  const policyText = (code: Code) => {
    const p = v.policies[code];
    if (!p) return { main: "None granted", sub: "" };
    return { main: p.maxNetPayCents !== undefined ? `Max pay ${money(p.maxNetPayCents)}` : `Min receive ${money(p.minNetReceiveCents ?? 0)}`, sub: `Policy v${p.version}` };
  };
  const eligible = (code: string) => {
    const o = data.obligations.find((x) => x.code === code)!;
    return current.hasDisputeExclusions ? o.amountCents - o.disputedCents : o.amountCents;
  };

  return (
    <>
      <div className={"band band-" + v.phase}>
        <div className="band-main">
          <h2>{headline(v)}</h2>
          <p>{explanation(v)}</p>
          {v.phase === "blocked" && (
            <button className="btn primary" onClick={() => onReviewAuthority(v.escalated[0])}>
              Review Company {v.escalated[0]} authority
            </button>
          )}
        </div>
        <div className="band-figure">
          <span className="label">Proposed net transfers</span>
          <strong className="figure">{money(transferTotal(current))}</strong>
          <span className="caveat">A proposal only. No payment is executed.</span>
          {prior && (
            <dl className="compare">
              <div><dt>Net transfers</dt><dd>{money(transferTotal(prior))} <span aria-label="to">→</span> {money(transferTotal(current))}</dd></div>
              <div><dt>Gross obligations</dt><dd>{money(grossCents(prior, data.obligations))} <span aria-label="to">→</span> {money(grossCents(current, data.obligations))}</dd></div>
            </dl>
          )}
        </div>
      </div>

      <ol className="steps" aria-label="Settlement lifecycle">
        {v.steps.map((s) => (
          <li key={s.label} data-state={s.state}>
            <span className="step-mark" aria-hidden="true" />
            <b>{s.label}</b>
            <span>{s.detail}</span>
            <span className="sr">{s.state}</span>
          </li>
        ))}
      </ol>

      <Section title="Positions and agent decisions" note={`Each agent decides alone, against its own officer-granted policy, for proposal V${current.version}.`}>
        <div className="table-wrap">
          <table className="data stack">
            <thead>
              <tr>
                <th>Company</th>
                {prior && <th className="num">V{prior.version} net<small>{prior.status}</small></th>}
                <th className="num">V{current.version} net<small>current</small></th>
                <th>Authority granted</th>
                <th>Agent decision on V{current.version}</th>
              </tr>
            </thead>
            <tbody>
              {v.decisions.map(({ code, decision, reading }) => {
                const pos = positionOf(current, code);
                const pol = policyText(code);
                const note = readingNote(reading);
                return (
                  <tr key={code}>
                    <td className="stack-title"><span className="co">{code}</span> {v.names[code]}</td>
                    {prior && <td className="num mono" data-label={`V${prior.version} net`}>{signedMoney(positionOf(prior, code))}</td>}
                    <td className="num mono strong" data-label={`V${current.version} net`}>{signedMoney(pos)}</td>
                    <td data-label="Authority granted">{pol.main}<small>{pol.sub}</small></td>
                    <td className="stack-wide" data-label={`Agent decision on V${current.version}`}>
                      <DecisionMark reading={reading} />
                      <small>{describeRequirement(pos, v.policies[code])}</small>
                      {reading.kind === "current_escalate" && decision && <small className="warn">{decision.reasons.map(reasonText).join("; ")}</small>}
                      {note && <small className="warn">{note}</small>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="split">
        <Section title="Obligations" note="Reciprocal obligations in this proposal.">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Obligation</th><th className="num">Amount</th><th className="num">Held</th><th className="num">In V{current.version}</th></tr></thead>
              <tbody>
                {data.obligations.filter((o) => current.obligationCodes.includes(o.code)).map((o) => (
                  <tr key={o.code}>
                    <td>{o.code} <span className="muted">{o.debtor} → {o.creditor}</span></td>
                    <td className="num mono">{money(o.amountCents)}</td>
                    <td className="num mono">{o.disputedCents ? money(o.disputedCents) : "—"}</td>
                    <td className="num mono">{money(eligible(o.code))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td>Gross</td><td className="num mono">{money(sum(data.obligations.filter((o) => current.obligationCodes.includes(o.code)).map((o) => o.amountCents)))}</td><td /><td className="num mono">{money(grossCents(current, data.obligations))}</td></tr></tfoot>
            </table>
          </div>
        </Section>
        <Section title="Proposed transfers" note="Not executed.">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>From → to</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {current.transfers.map((t) => (
                  <tr key={t.from + t.to}><td>{t.from} → {t.to}</td><td className="num mono">{money(t.cents)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr><td>Net transfers</td><td className="num mono">{money(transferTotal(current))}</td></tr></tfoot>
            </table>
          </div>
          <button className="link" onClick={onOpenEvidence}>View the invoice evidence</button>
        </Section>
      </div>

      <Section title="Audit trail" note="Recorded by the server, newest first." aside={data.audit.length > 8 ? <button className="link" onClick={() => setShowAll((s) => !s)}>{showAll ? "Show recent" : `Show all ${data.audit.length}`}</button> : undefined}>
        <ul className="audit">
          {events.map((e) => (
            <li key={e._id}>
              <time className="mono">{new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              <span className="audit-kind">{auditLabel(e.kind)}</span>
              <span>{e.message}</span>
              <span className="muted">{e.actor}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
