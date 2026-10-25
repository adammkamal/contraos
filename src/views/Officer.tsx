import { CODES, TARGET, derive, describeRequirement, disputeReadiness, ledger, money, positionOf, readingNote, reasonText, requirement, type Code, type Session } from "../model";
import { DecisionMark, Field, Section, StateMark } from "../ui";

type View = ReturnType<typeof derive>;

export function Officer({ data, view: v, company, onCompany, token, setToken, limit, setLimit, busy, onGrant, onDispute, onManual }: {
  data: Session; view: View; company: Code; onCompany: (c: Code) => void; token: string; setToken: (t: string) => void;
  limit: string; setLimit: (l: string) => void; busy: string; onGrant: () => void; onDispute: () => void; onManual: () => void;
}) {
  const policy = v.policies[company];
  const pays = company === "A";
  const position = positionOf(v.current, company);
  const { decision, reading } = v.decisions.find((d) => d.code === company)!;
  const note = readingNote(reading);
  const req = requirement(position, policy);
  const amount = Math.round(Number(limit) * 100);
  const validAmount = limit.trim() !== "" && Number.isSafeInteger(amount) && amount >= 0;
  const current = policy ? (pays ? policy.maxNetPayCents : policy.minNetReceiveCents) : undefined;
  const target = ledger(data, TARGET.obligation).rows.find((r) => r.lineId === TARGET.line);
  const credentialOk = token.length >= 16;
  const blockingHere = v.phase === "blocked" && reading.kind === "current_escalate";
  const pendingHere = v.current?.status === "open" && reading.kind === "stale";
  const waitingOn = v.phase === "blocked" ? v.escalated : v.phase === "reevaluating" ? v.stale : [];
  const waitingElsewhere = !blockingHere && !pendingHere && waitingOn.length > 0 && !waitingOn.includes(company);
  const readiness = disputeReadiness(data);
  const disputeWhy = v.disputeFiled ? "A dispute for this line has already been filed." : !readiness.ok ? readiness.reason : company !== "C" ? "Only Company C can file this dispute. Select Company C." : !credentialOk ? "Enter the Company C officer credential." : "";

  return (
    <>
      <div className="scope" role="group" aria-label="Company scope">
        <div className="seg">
          {CODES.map((c) => (
            <button key={c} aria-pressed={company === c} className={company === c ? "on" : ""} onClick={() => onCompany(c)}>
              <b>{c}</b> <span className="seg-name">{v.names[c]}</span>
            </button>
          ))}
        </div>
        <p>
          Acting for <strong>Company {company}, {v.names[company]}</strong>. The server identifies the company from the officer credential, not from this selection.
        </p>
        <div className="actions">
          <Field label={`Company ${company} officer credential`} hint="Sent with each action and checked on the server. This page does not store it.">
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Officer secret (16+ characters)" />
          </Field>
        </div>
      </div>

      {pendingHere && v.current && (
        <div className="callout" role="status">
          <div>
            <h2>Company {company} re-evaluation pending</h2>
            <p>Policy v{policy?.version} has been granted, but the agent's decision on proposal V{v.current.version} was made under v{decision?.policyVersion ?? "none"}. That decision does not count; the proposal stays unauthorized until the agent decides again under the current policy.</p>
          </div>
        </div>
      )}
      {blockingHere && v.current && (
        <div className="callout" role="status">
          <div>
            <h2>Company {company} authorization needed</h2>
            <p>
              Proposal V{v.current.version} requires Company {company} to {req.kind === "pay" ? "pay" : "receive"} {money(req.amount)}. The granted {req.kind === "pay" ? "maximum" : "minimum"} is {req.bound === undefined ? "not set" : money(req.bound)}
              {policy ? ` (policy v${policy.version})` : ""}. Amending the limit below makes the agent re-evaluate immediately; authorization still needs all three current accepts.
            </p>
          </div>
        </div>
      )}
      {waitingElsewhere && (
        <p className="note">Proposal V{v.current?.version} is waiting on Company {waitingOn.join(" and ")}. Select that company to review its authority.</p>
      )}

      <Section title="Delegated authority" note="Set by the company's human officer. The agent cannot change its own limits.">
        <dl className="facts">
          <div><dt>Policy version</dt><dd>{policy ? `v${policy.version}` : "None granted"}</dd></div>
          <div><dt>{pays ? "Maximum net payment" : "Minimum net receipt"}</dt><dd className="mono">{current === undefined ? "—" : money(current)}</dd></div>
          <div><dt>Current proposal needs</dt><dd className="mono">{v.current ? describeRequirement(position, policy) : "—"}</dd></div>
          <div>
            <dt>Agent decision</dt>
            <dd>
              <DecisionMark reading={reading} />
              {reading.kind === "current_escalate" && decision && <small className="warn">{decision.reasons.map(reasonText).join("; ")}</small>}
              {note && <small className="warn">{note}</small>}
            </dd>
          </div>
        </dl>

        <div className="actions">
          <Field label={pays ? "Maximum net payment (USD)" : "Minimum net receipt (USD)"}>
            <input type="number" inputMode="decimal" min="0" step="1" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </Field>
          {validAmount && current !== undefined && amount !== current && (
            <p className="diff mono">{pays ? "Max pay" : "Min receive"} {money(current)} → {money(amount)}</p>
          )}
          <p className="warning">This changes what Company {company}'s agent may accept on its behalf. It takes effect immediately and schedules a new agent decision.</p>
          <div className="btn-row">
            <button className={"btn " + (blockingHere ? "primary" : "")} disabled={!!busy || !credentialOk || !validAmount} onClick={onGrant}>
              {policy ? "Amend authority" : "Grant authority"}
            </button>
          </div>
        </div>
      </Section>

      <Section title="Evidence dispute" note="Only Company C, the debtor on this obligation, can place a validated discrepancy on hold.">
        <div className="dispute">
          <div>
            <strong>{TARGET.obligation} · line {TARGET.line}</strong>
            <p className={readiness.ok ? "mono" : "warn"}>{readiness.ok && target ? `${target.shortUnits} units short × ${money(target.unitPriceCents)} = ${money(target.shortCents)}` : readiness.reason}</p>
          </div>
          <StateMark tone={v.disputeFiled ? "ok" : readiness.ok ? "muted" : "stale"} label={v.disputeFiled ? "Filed" : readiness.ok ? "Available" : "Not supported"} />
        </div>
        <div className="btn-row">
          <button className="btn primary" disabled={!!busy || !!disputeWhy} onClick={onDispute}>File {readiness.ok ? money(readiness.cents) + " " : ""}dispute</button>
          <button className="btn" disabled={!!busy || !!disputeWhy} onClick={onManual}>Prepare manual fallback</button>
        </div>
        {disputeWhy && <p className="note">{disputeWhy}</p>}
      </Section>
    </>
  );
}
