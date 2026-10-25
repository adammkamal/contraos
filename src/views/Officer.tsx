import { useState } from "react";
import { CODES, TARGET, derive, disputeReadiness, limitGap, money, positionOf, readingNote, reasonText, requirement, type Code, type Session } from "../model";
import { shortName } from "../story";
import { DecisionMark, Field, State } from "../ui";

type View = ReturnType<typeof derive>;

export function Officer({ data, view: v, company, onCompany, token, setToken, limit, setLimit, busy, onGrant, onDispute, onManual }: {
  data: Session; view: View; company: Code; onCompany: (c: Code) => void; token: string; setToken: (t: string) => void;
  limit: string; setLimit: (l: string) => void; busy: string; onGrant: () => void; onDispute: () => void; onManual: () => void;
}) {
  // Review step is local to this screen and resets when the company or amount changes.
  const [review, setReview] = useState<{ company: Code; limit: string } | null>(null);
  const [open, setOpen] = useState(false);
  const policy = v.policies[company];
  const pays = company === "A";
  const position = positionOf(v.current, company);
  const { decision, reading } = v.decisions.find((d) => d.code === company)!;
  const req = requirement(position, policy);
  const gap = limitGap(position, policy);
  const note = readingNote(reading);
  const amount = Math.round(Number(limit) * 100);
  const validAmount = limit.trim() !== "" && Number.isSafeInteger(amount) && amount >= 0;
  const granted = policy ? (pays ? policy.maxNetPayCents : policy.minNetReceiveCents) : undefined;
  const credentialOk = token.length >= 16;
  const blockingHere = v.phase === "blocked" && reading.kind === "current_escalate";
  const pendingHere = v.current?.status === "open" && reading.kind === "stale";
  const waitingOn = v.phase === "blocked" ? v.escalated : v.phase === "reevaluating" ? v.stale : [];
  const waitingElsewhere = !blockingHere && !pendingHere && waitingOn.length > 0 && !waitingOn.includes(company);
  const readiness = disputeReadiness(data);
  const canDispute = company === "C" && !v.disputeFiled;
  const showForm = open || blockingHere || pendingHere;
  const nextVersion = (policy?.version ?? 0) + 1;
  const reviewing = !!review && review.company === company && review.limit === limit;
  const disputeWhy = !readiness.ok ? readiness.reason : !credentialOk ? `Enter the ${shortName(v.names, "C")} officer credential.` : "";
  const noun = pays ? "maximum net payment" : "minimum net receipt";
  const needs = pays ? "Pays" : "Receives";

  const changeCompany = (c: Code) => { setReview(null); setOpen(false); onCompany(c); };
  const setAmount = (value: string) => { setReview(null); setLimit(value); };

  return (
    <>
      <header className="head">
        <div>
          <h1>Officer portal</h1>
          <p className="lead-line">Each company's officer sets what its agent may accept. The server checks the credential, not this selection.</p>
        </div>
      </header>

      <div className="who-tabs" role="group" aria-label="Company">
        {CODES.map((c) => (
          <button key={c} aria-pressed={company === c} onClick={() => changeCompany(c)}><b>{c}</b><span className="nm">{v.names[c]}</span></button>
        ))}
      </div>

      <div className="who-head"><h2>{v.names[company]}</h2><span>Company {company}</span></div>

      {v.current ? (
        <dl className="figures four">
          <div><dt>Proposal V{v.current.version} requires</dt><dd className="sm">{needs} {money(req.amount)}</dd></div>
          <div><dt>Delegated limit</dt><dd className="sm">{granted === undefined ? "None granted" : `${pays ? "Max" : "Min"} ${money(granted)}`}<span className="sub">{policy ? `Policy v${policy.version}` : "No policy"}</span></dd></div>
          <div>
            <dt>Against the limit</dt>
            <dd className={"sm " + (gap === undefined || gap === 0 ? "" : gap > 0 ? "warn" : "ok")}>
              {gap === undefined ? "No limit set" : gap > 0 ? `${money(gap)} ${pays ? "over" : "short"}` : gap === 0 ? "At the limit" : `${money(-gap)} to spare`}{gap === 0 && <span className="sub">Accepted, with no margin</span>}
            </dd>
          </div>
          <div>
            <dt>Agent decision</dt>
            <dd className="sm"><DecisionMark reading={reading} />{reading.kind === "current_escalate" && decision && gap !== undefined && gap <= 0 && <span className="sub">{decision.reasons.map(reasonText).join("; ")}</span>}</dd>
          </div>
        </dl>
      ) : <p className="muted">No current proposal.</p>}

      {note && !pendingHere && <p className="note warn">{note}</p>}

      {blockingHere && (
        <div className="callout" role="status">
          <b>{shortName(v.names, company)} is blocking V{v.current?.version}.</b>{" "}
          {pays ? `This agent can accept only if the ${noun} is at least ${money(req.amount)}.` : `This agent can accept only if the ${noun} is at most ${money(req.amount)}.`}
        </div>
      )}
      {pendingHere && (
        <div className="callout" role="status">
          <b>Re-evaluation pending.</b> Policy v{policy?.version} is in force, but the agent's decision on V{v.current?.version} was made under v{decision?.policyVersion ?? "none"}. It does not count until the agent decides again.
        </div>
      )}
      {waitingElsewhere && <p className="note">V{v.current?.version} is waiting on {waitingOn.map((c) => shortName(v.names, c)).join(" and ")}. Select that company to review its limit.</p>}

      <section className="action">
        <h2>Change delegated limit</h2>
        {!showForm ? (
          <p><button className="btn" onClick={() => setOpen(true)}>Change {noun}…</button></p>
        ) : (
          <div className="stack-gap">
            <div className="form">
              <Field label="Officer credential" hint={`Company ${company}'s secret. Sent with the change and checked by the server; this page does not store it.`}>
                <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="16+ characters" />
              </Field>
              <Field label={`New ${noun} (USD)`}>
                <input type="number" inputMode="decimal" min="0" step="1" value={limit} onChange={(e) => setAmount(e.target.value)} />
              </Field>
            </div>
            {!reviewing ? (
              <div className="btn-row">
                <button className={"btn " + (blockingHere ? "primary" : "")} disabled={!!busy || !credentialOk || !validAmount} onClick={() => setReview({ company, limit })}>Review change</button>
                {!blockingHere && !pendingHere && <button className="btn quiet" onClick={() => { setOpen(false); setReview(null); }}>Cancel</button>}
              </div>
            ) : (
              <div className="review" role="group" aria-label="Confirm authority change">
                <h3>Confirm change to {shortName(v.names, company)}'s authority</h3>
                <div className="change">
                  <span>{granted === undefined ? "None" : money(granted)}</span><span className="arrow">→</span><span>{money(amount)}</span>
                  <small>{noun}, policy v{nextVersion}</small>
                </div>
                <p>This takes effect immediately. {shortName(v.names, company)}'s agent will decide again on V{v.current?.version} under the new policy; authorization still needs three current accepts.</p>
                <div className="btn-row">
                  <button className="btn primary" disabled={!!busy || !credentialOk || !validAmount} onClick={() => { setReview(null); setOpen(false); onGrant(); }}>Amend authority</button>
                  <button className="btn" onClick={() => setReview(null)}>Back</button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {company === "C" && (
        <section className="action">
          <h2>Evidence dispute</h2>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                <tr>
                  <td>{TARGET.obligation} line {TARGET.line}</td>
                  <td>{readiness.ok ? <span className="mono">{money(readiness.cents)} supported shortfall</span> : <span className="muted">{readiness.reason}</span>}</td>
                  <td className="num">{v.disputeFiled ? <State tone="ok" label="Filed" /> : <State tone="muted" label={readiness.ok ? "Not filed" : "Not supported"} />}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {canDispute && (
            <div className="stack-gap" style={{ marginTop: 16 }}>
              {!showForm && (
                <div className="form">
                  <Field label="Officer credential" hint="Company C's secret.">
                    <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="16+ characters" />
                  </Field>
                </div>
              )}
              <div className="btn-row">
                <button className="btn primary" disabled={!!busy || !!disputeWhy} onClick={onDispute}>File {readiness.ok ? money(readiness.cents) + " " : ""}dispute</button>
                <button className="btn" disabled={!!busy || !!disputeWhy} onClick={onManual}>Prepare manual entry</button>
              </div>
              {disputeWhy && <p className="note">{disputeWhy}</p>}
            </div>
          )}
        </section>
      )}
    </>
  );
}
