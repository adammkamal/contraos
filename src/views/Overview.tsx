import { auditLabel, grossCents, limitGap, money, positionOf, readingNote, reasonText, requirement, sum, transferTotal, type Code, type Session } from "../model";
import { actorLabel, auditNewestFirst, changeText, explainRevision, historyNote, nextStep, shortName, type View } from "../story";
import { DecisionMark, Section } from "../ui";

const list = (codes: string[]) => (codes.length > 1 ? `${codes.slice(0, -1).join(", ")} and ${codes.at(-1)}` : codes.join(""));

/** One company's breach in plain numbers, or the stored reason when it is not a limit problem. */
function breach(v: View, code: Code): string | undefined {
  const policy = v.policies[code];
  const position = positionOf(v.current, code);
  const r = requirement(position, policy);
  const gap = limitGap(position, policy);
  const who = shortName(v.names, code);
  if (gap !== undefined && gap > 0 && r.bound !== undefined) {
    return r.kind === "pay"
      ? `${who} would pay ${money(r.amount)}, ${money(gap)} over its ${money(r.bound)} maximum.`
      : `${who} would receive ${money(r.amount)}, ${money(gap)} below its ${money(r.bound)} minimum.`;
  }
  const reasons = v.decisions.find((d) => d.code === code)?.decision?.reasons ?? [];
  return reasons.length ? `${who}: ${reasons.map(reasonText).join("; ")}.` : undefined;
}

type Tone = "ok" | "warn" | "plain";
/** The single statement of the proposal's state. "Authorized" is the server's stored status and nothing more. */
function status(v: View): { lead: string; tone: Tone; rest: string } {
  const reopened = v.reopened ? "A policy change withdrew the earlier authorization. " : "";
  const who = (codes: Code[]) => list(codes.map((c) => shortName(v.names, c)));
  switch (v.phase) {
    case "authorized":
      return v.consistent
        ? { lead: "Proposal authorized.", tone: "ok", rest: "Three current agent acceptances. No payment executed." }
        : { lead: "Proposal authorized, but the record is inconsistent.", tone: "warn", rest: "A recorded decision does not match its company's current policy. No payment executed." };
    case "blocked":
      return { lead: `Blocked on ${who(v.escalated)}.`, tone: "warn", rest: v.escalated.map((c) => breach(v, c)).filter(Boolean).join(" ") };
    case "reevaluating":
      return { lead: "Waiting for re-evaluation.", tone: "plain", rest: `${reopened}${who(v.stale)}'s policy changed, so its agent must decide again.` };
    case "pending_authorization":
      return { lead: "Not authorized yet.", tone: "plain", rest: `${reopened}Every agent accepts, but the server has not recorded authorization.` };
    case "evaluating":
      return { lead: "Evaluating.", tone: "plain", rest: `${reopened}Waiting for ${v.missing.length === 3 ? "every agent" : who(v.missing)} to decide under its current policy.` };
    case "superseded":
      return { lead: "Superseded.", tone: "plain", rest: "The session's current proposal is marked superseded; waiting for a replacement." };
    default:
      return { lead: "No proposal.", tone: "plain", rest: "" };
  }
}

export function Overview({ data, view: v, onReviewAuthority, onOpenEvidence }: { data: Session; view: View; onReviewAuthority: (c: Code) => void; onOpenEvidence: () => void }) {
  const { current, prior } = v;
  if (!current) return <p className="muted">No current proposal has been created for this session.</p>;
  const s = status(v);
  const next = nextStep(data, v);
  const story = explainRevision(data, v);
  const events = auditNewestFirst(data.audit);
  const hold = data.disputes[0];
  const inProposal = data.obligations.filter((o) => current.obligationCodes.includes(o.code));
  const eligible = (o: (typeof inProposal)[number]) => (current.hasDisputeExclusions ? o.amountCents - o.disputedCents : o.amountCents);
  const stamp = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  return (
    <>
      <header className="head">
        <div>
          <h1>Settlement proposal V{current.version}</h1>
          <p className="lead-line">
            <b className={s.tone === "plain" ? undefined : s.tone}>{s.lead}</b> {s.rest}
          </p>
          {next && (
            <p className="next">
              {next.text}
              {next.evidence && <> <button className="link" onClick={onOpenEvidence}>Review the evidence</button></>}
            </p>
          )}
        </div>
        {next?.officer && <button className="btn primary" onClick={() => onReviewAuthority(next.officer!)}>Review {shortName(v.names, next.officer)}'s limit</button>}
      </header>

      {story.rows.length > 0 && (
        <section className="story" aria-label={`Why V${current.version} exists`}>
          <h2>Why V{current.version} exists</h2>
          <dl>
            {story.rows.map((row, i) => (
              <div key={row.label + i}>
                <dt>{row.label}</dt>
                <dd>
                  {row.text}
                  {row.detail && <span className="chain">{row.detail}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <dl className="figures">
        <div>
          <dt>Proposed net transfers</dt>
          <dd>{money(transferTotal(current))}<span className="sub">{prior ? `V${prior.version} was ${money(transferTotal(prior))}` : "Netted from the obligations"}</span></dd>
        </div>
        <div>
          <dt>Eligible obligations</dt>
          <dd>{money(grossCents(current, data.obligations))}<span className="sub">{prior ? `V${prior.version} was ${money(grossCents(prior, data.obligations))}` : "Before netting"}</span></dd>
        </div>
        <div>
          <dt>Disputed hold</dt>
          <dd>{hold ? money(v.holdCents) : "None"}<span className="sub">{hold ? `Excluded from eligible · ${hold.obligationCode} line ${hold.lineId}` : "No dispute filed"}</span></dd>
        </div>
      </dl>

      <Section title="Positions and agent decisions" note="Each agent decides alone, under the limit its own officer set.">
        <div className="table-wrap">
          <table className="data stack">
            <thead>
              <tr>
                <th>Company</th>
                {prior && <th className="num">V{prior.version}<small>{prior.status}</small></th>}
                <th className="num">V{current.version}<small>current</small></th>
                {prior && <th className="num">Change</th>}
                <th>Delegated limit<small>set by the officer</small></th>
                <th>Agent decision</th>
              </tr>
            </thead>
            <tbody>
              {v.decisions.map(({ code, decision, reading }) => {
                const pos = positionOf(current, code);
                const policy = v.policies[code];
                const gap = limitGap(pos, policy);
                const r = requirement(pos, policy);
                const note = readingNote(reading);
                const dir = (cents: number) => <><span className="dir">{cents < 0 ? "Pays" : cents > 0 ? "Receives" : "Settled"}</span>{money(Math.abs(cents))}</>;
                const margin = gap === undefined ? "" : gap === 0 ? " · at limit, no margin" : gap < 0 ? ` · ${money(-gap)} margin` : "";
                return (
                  <tr key={code}>
                    <td className="full"><span className="co">{code}</span>{v.names[code]}</td>
                    {prior && <td className="num" data-label={`V${prior.version}`}>{dir(positionOf(prior, code))}</td>}
                    <td className="num strong" data-label={`V${current.version}`}>{dir(pos)}</td>
                    {prior && <td className="num" data-label="Change">{positionOf(prior, code) === pos ? <span className="dim">None</span> : changeText(positionOf(prior, code), pos)}</td>}
                    <td className="full" data-label="Delegated limit">
                      {policy ? `${policy.maxNetPayCents !== undefined ? "Max pay" : "Min receive"} ${money((policy.maxNetPayCents ?? policy.minNetReceiveCents) as number)}` : "None granted"}
                      {policy && <small>Policy v{policy.version}{reading.kind === "current_accept" ? margin : ""}</small>}
                    </td>
                    <td className="full" data-label="Agent decision">
                      <DecisionMark reading={reading} />
                      {reading.kind === "current_escalate" && (gap !== undefined && gap > 0
                        ? <small>{money(gap)} {r.kind === "pay" ? "over the maximum" : "below the minimum"}</small>
                        : <small>{(decision?.reasons ?? []).map(reasonText).join("; ")}</small>)}
                      {note && <small>{note}</small>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="split">
        <Section title="Proposed transfers" note="Netted from the obligations.">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>From → to</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {current.transfers.map((t) => (
                  <tr key={t.from + t.to}><td>{shortName(v.names, t.from)} → {shortName(v.names, t.to)}</td><td className="num">{money(t.cents)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr><td>Total</td><td className="num">{money(transferTotal(current))}</td></tr></tfoot>
            </table>
          </div>
        </Section>
        <Section title="Obligations" aside={hold ? <button className="link" onClick={onOpenEvidence}>View evidence</button> : undefined}>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Obligation</th><th className="num">Owed</th><th className="num">Held</th><th className="num">Eligible</th></tr></thead>
              <tbody>
                {inProposal.map((o) => (
                  <tr key={o.code}>
                    <td>{o.code} <span className="dim">{o.debtor} owes {o.creditor}</span></td>
                    <td className="num">{money(o.amountCents)}</td>
                    <td className="num">{o.disputedCents ? money(o.disputedCents) : <span className="dim">—</span>}</td>
                    <td className="num">{money(eligible(o))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td>Total</td><td className="num">{money(sum(inProposal.map((o) => o.amountCents)))}</td><td /><td className="num">{money(grossCents(current, data.obligations))}</td></tr></tfoot>
            </table>
          </div>
        </Section>
      </div>

      <Section title="History" note={historyNote(events.length)}>
        <ul className="log">
          {events.map((e) => (
            <li key={e._id}>
              <time>{stamp(e.createdAt)}</time>
              <span className="kind">{auditLabel(e.kind)}</span>
              <span>{e.message}</span>
              <span className="who">{actorLabel(e.actor, v.names)}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
