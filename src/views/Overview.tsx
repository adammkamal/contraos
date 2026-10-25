import { useState } from "react";
import { AUDIT_WINDOW, grossCents, limitGap, money, positionOf, readingNote, reasonText, requirement, signedMoney, transferTotal, type Code, type Session } from "../model";
import { actorLabel, auditNewestFirst, changeText, nextStep, type View } from "../story";
import { Btn, Card, DecisionPill, Footer, Mark, Meter, PageHead, Pill, firstName, type PillTone } from "../ui";
import { NettingMap } from "./NettingMap";

const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs.join(""));
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Copy for the hero, composed from the stored records only. */
function heroCopy(data: Session, v: View) {
  const { current, prior } = v;
  const F = (c: Code) => firstName(v.names, c);
  const n = current ? `V${current.version}` : "";
  const accepted = v.decisions.filter((d) => d.reading.approved).map((d) => F(d.code));
  switch (v.phase) {
    case "blocked": {
      const first = v.escalated[0];
      const hold = data.disputes[0];
      const ob = hold && data.obligations.find((o) => o.code === hold.obligationCode);
      const credPos = ob ? positionOf(current, ob.creditor) : 0;
      const raised = !!prior && !!ob && credPos < 0 && positionOf(prior, ob.creditor) > credPos;
      const policy = v.policies[first];
      const gap = limitGap(positionOf(current, first), policy);
      const bound = policy ? (policy.maxNetPayCents ?? policy.minNetReceiveCents) : undefined;
      const lead = raised && ob && hold ? `${F(hold.filedBy)}'s ${money(hold.cents)} dispute raised what ${F(ob.creditor)} owes to ${money(-credPos)} net` : `${F(first)}'s position under ${n}`;
      const limit = gap !== undefined && gap > 0 && bound !== undefined ? `, which is ${money(gap)} ${positionOf(current, first) < 0 ? "over the" : "below the"} ${money(bound)} limit in its policy` : "";
      const people = v.escalated.length === 1 ? "one person" : `${v.escalated.length} people`;
      return {
        eyebrow: `Proposal ${n} · Blocked`,
        title: `Blocked on Company ${list(v.escalated)} until ${v.escalated.length > 1 ? "their officers grant" : "its officer grants"} more authority`,
        text: `${lead}${limit}. ${accepted.length ? `${list(accepted)} accepted, so ` : ""}${n} is waiting on ${people}.`,
        sub: `Each agent judged proposal ${n} on its own, against the limit its officer set.`,
      };
    }
    case "authorized": {
      const am = v.amendments[0];
      const verb = am && am.to > am.from ? "raised" : "changed";
      const text = !v.consistent
        ? "The server reports authorization, yet a recorded decision does not match its company's current policy. Check the audit trail. No payment has been made."
        : am
          ? `${F(am.code)}'s officer ${verb} its limit to ${money(am.to)}, Agent ${am.code} re-evaluated under policy v${Math.max(...v.decisions.map((d) => d.reading.currentPolicy ?? 1))} and the server checked every current decision. No payment has been made, and a later policy change would withdraw this authorization.`
          : `Every agent accepted ${n} under its current policy and the server checked every current decision. No payment has been made, and a later policy change would withdraw this authorization.`;
      return { eyebrow: `Proposal ${n} · Authorized`, title: "Authorized by all three agents, with nothing executed", text, sub: `All three agents accepted proposal ${n} under their current policies.` };
    }
    case "reevaluating":
      return { eyebrow: `Proposal ${n} · Re-evaluating`, title: `Waiting for ${list(v.stale.map(F))}'s agent to decide again`, text: `${v.reopened ? "A policy change withdrew the earlier authorization. " : ""}The policy changed, so an earlier decision no longer counts. Authorization needs a fresh decision under the current policy.`, sub: `Waiting for re-evaluation of proposal ${n} under the new policy.` };
    case "pending_authorization":
      return { eyebrow: `Proposal ${n} · Not authorized yet`, title: "Every agent accepts; the server has not recorded authorization", text: `${v.reopened ? "A policy change withdrew the earlier authorization. " : ""}The server is checking the current decisions. ${n} is not authorized until it records that.`, sub: `Waiting for the server to record authorization of proposal ${n}.` };
    case "evaluating":
      return { eyebrow: `Proposal ${n} · Evaluating`, title: "Agents are deciding", text: `Waiting for ${v.missing.length === 3 ? "every agent" : list(v.missing.map(F))} to decide under its current policy.`, sub: `Waiting for agent decisions on proposal ${n}.` };
    default:
      return { eyebrow: "No proposal", title: "No current proposal", text: "", sub: "" };
  }
}

export function Overview({ data, view: v, onReviewAuthority, onOpenEvidence }: { data: Session; view: View; onReviewAuthority: (c: Code) => void; onOpenEvidence: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const { current, prior } = v;
  if (!current) return <p className="empty">No current proposal has been created for this session.</p>;
  const F = (c: Code) => firstName(v.names, c);
  const hero = heroCopy(data, v);
  const next = nextStep(data, v);
  const authorized = v.phase === "authorized" && v.consistent;
  const hold = data.disputes[0];
  const inProposal = data.obligations.filter((o) => current.obligationCodes.includes(o.code));
  const eligible = (o: (typeof inProposal)[number]) => (current.hasDisputeExclusions ? o.amountCents - o.disputedCents : o.amountCents);
  const gross = grossCents(current, data.obligations), net = transferTotal(current);
  const events = auditNewestFirst(data.audit);
  const shown = showAll ? events : events.slice(0, 5);
  const payers = [...new Set(current.transfers.map((t) => t.from))];
  const approved = v.decisions.filter((d) => d.reading.approved).length;
  const openAudit = () => { setShowAll(true); document.getElementById("audit")?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const rings: Partial<Record<Code, "ok" | "warn">> = {};
  for (const d of v.decisions) { if (d.reading.kind === "current_escalate") rings[d.code] = "warn"; else if (authorized && d.code === payers[0]) rings[d.code] = "ok"; }
  const acceptPill: { tone: PillTone; text: string } = authorized ? { tone: "ok", text: "Complete" } : v.escalated.length ? { tone: "warn", text: `Waiting on ${list(v.escalated)}` } : { tone: "info", text: v.phase === "pending_authorization" ? "Awaiting server" : "In progress" };
  const acceptNote = authorized ? "Every decision matches its company's latest policy."
    : v.escalated.length ? `${v.escalated.map((c) => `Agent ${c}`).join(" and ")} ${v.escalated.length > 1 ? "need" : "needs"} a new policy version before ${v.escalated.length > 1 ? "they" : "it"} can accept.`
      : v.stale.length ? `${v.stale.map((c) => `Agent ${c}`).join(" and ")} must decide again under the new policy.` : v.phase === "pending_authorization" ? "All decisions are current; the server records authorization." : "Waiting for agent decisions.";
  const dir = prior ? (net > transferTotal(prior) ? "up from" : net < transferTotal(prior) ? "down from" : "unchanged from") : "";
  const dotKind = (e: (typeof events)[number]) => (/escalated|invalidated/.test(e.message) || e.kind === "dispute_filed" ? "warn" : e.kind === "policy_granted" ? "navy" : "ok");

  return (
    <>
      <PageHead title="Settlement" sub={hero.sub} action={next?.officer ? <Btn island onClick={() => onReviewAuthority(next.officer!)}>Review Company {next.officer} authority</Btn> : authorized ? <Btn island onClick={openAudit}>Open the audit trail</Btn> : undefined} />

      <div className="row-top">
        <Card tone="navy" hero className="card--split" label="Proposal state">
          <div className="hero">
            <div className="hero__copy">
              <span className={"eyebrow" + (v.phase === "blocked" ? " eyebrow--warn" : "")}>{hero.eyebrow}</span>
              <h2 className="hero__title">{hero.title}</h2>
              <p className="hero__text">{hero.text}</p>
              <div className="hero__actions">
                {next?.officer ? <Btn kind="mint" island onClick={() => onReviewAuthority(next.officer!)}>Review authority</Btn> : authorized ? <Btn kind="mint" island onClick={openAudit}>Open audit trail</Btn> : null}
                <Btn kind="ghost-dark" onClick={onOpenEvidence}>View evidence</Btn>
              </div>
            </div>
            <div className="map">
              <div className="map__text">
                <p className="map__head">{money(gross)} gross nets to {money(net)}</p>
                <p className="map__sub">in {current.transfers.length === 1 ? "one transfer" : `${current.transfers.length} transfers`}{payers.length ? ` paid by ${list(payers.map(F))}` : ""}</p>
              </div>
              <NettingMap
                names={v.names}
                obligations={inProposal.map((o) => ({ code: o.code, debtor: o.debtor, creditor: o.creditor, owed: o.amountCents, held: current.hasDisputeExclusions ? o.disputedCents : 0 }))}
                transfers={current.transfers}
                rings={rings}
              />
            </div>
          </div>
        </Card>

        <div className="col-stack">
          <Card tone={authorized ? "mint" : "plain"} label="Current accepts">
            <div className="gate__top"><h2 className="gate__title">Current accepts</h2><Pill tone={authorized ? "idle" : acceptPill.tone}>{acceptPill.text}</Pill></div>
            <p><span className="gate__value num">{approved}</span><span className="gate__of">of 3 agents</span></p>
            <div className="gate__segs" aria-hidden="true">
              {v.decisions.map((d) => <i key={d.code} className={"seg " + (d.reading.approved ? (authorized ? "seg--dark" : "seg--ok") : d.reading.kind === "current_escalate" ? "seg--warn" : "")} />)}
            </div>
            <div className="gate__names">{v.decisions.map((d) => <span key={d.code} className={d.reading.kind === "current_escalate" ? "warn" : ""}>Agent {d.code}</span>)}</div>
            <p className="gate__note">{acceptNote}</p>
          </Card>
          <Card label="Net transfers">
            <h2 className="gate__title" style={{ color: "var(--c-slate)", fontWeight: 500 }}>Net transfers in {`V${current.version}`}</h2>
            <p><span className="net__value num">{money(net)}</span>{prior && <span className="net__up">{dir} {money(transferTotal(prior))} in V{prior.version}</span>}</p>
            <p className="section__sub">{prior && hold ? `Gross obligations ${gross < grossCents(prior, data.obligations) ? "fell" : "rose"} from ${money(grossCents(prior, data.obligations))} to ${money(gross)} after the hold on ${hold.obligationCode}` : "Netted from the obligations"}</p>
          </Card>
        </div>
      </div>

      <div className="agents">
        {v.decisions.map(({ code, reading, decision }) => {
          const pos = positionOf(current, code), priorPos = prior ? positionOf(prior, code) : undefined;
          const policy = v.policies[code], r = requirement(pos, policy), gap = limitGap(pos, policy);
          const escalated = reading.kind === "current_escalate";
          const am = v.amendments.find((a) => a.code === code);
          const tone = escalated ? "warn" : pos < 0 ? "navy" : "ok";
          const bound = r.bound;
          const why = reading.kind === "stale" || reading.kind === "missing" ? readingNote(reading) ?? ""
            : pos < 0
              ? gap !== undefined && gap > 0 && bound !== undefined ? `Pays ${money(r.amount)} against a ${money(bound)} maximum, so the agent escalated to its officer` : bound !== undefined ? `Pays ${money(r.amount)} within its ${am ? "new " : ""}${money(bound)} maximum` : `Pays ${money(r.amount)}; no maximum is granted`
              : bound !== undefined ? `Receives ${money(r.amount)}, ${gap !== undefined && gap > 0 ? "below" : gap === 0 ? "at" : "above"} its ${money(bound)} floor` : `Receives ${money(r.amount)}; no floor is granted`;
          return (
            <Card key={code} label={`${F(code)} agent`}>
              <div className="agent__head">
                <Mark code={code} />
                <div><h2 className="agent__name">{F(code)}</h2><p className="agent__role">{pos < 0 ? "Payer" : pos > 0 ? "Receiver" : ""} agent</p></div>
                <DecisionPill reading={reading} />
              </div>
              <p className={"agent__amount num agent__amount--" + (escalated ? "warn" : pos < 0 ? "navy" : "ok")}>
                {signedMoney(pos)}
                {priorPos !== undefined && <span className="agent__was">{priorPos === pos ? "no change from V" + prior!.version : `was ${signedMoney(priorPos)} in V${prior!.version}`}</span>}
              </p>
              <Meter amount={Math.abs(pos)} bound={bound} boundLabel={`${pos < 0 ? "Limit" : "Floor"} ${bound !== undefined ? money(bound) : ""}`} tone={tone} />
              <p className={"agent__why" + (escalated ? " agent__why--warn" : "")}>{why}</p>
              {escalated && decision && gap !== undefined && gap <= 0 && <p className="agent__why">{decision.reasons.map(reasonText).join("; ")}</p>}
              <p className="agent__policy">{policy ? `Policy v${policy.version}` : "No policy granted"}{am ? ` · ${am.to > am.from ? "raised" : "changed"} by ${F(code)}'s officer` : pos < 0 && policy ? " · maximum net payment" : ""}</p>
            </Card>
          );
        })}
      </div>

      <Card label="How the proposal got here">
        <div className="head-row"><h2 className="section__title">How V1 became V{current.version}</h2><span className="section__sub">Derived from the server's records</span></div>
        <ol className="life">
          {v.steps.map((s) => (
            <li key={s.label} className={"life__step" + (s.state === "current" ? " life__step--warn" : s.state === "done" ? "" : " life__step--empty")}>
              <div className="life__rail"><span className="life__dot" aria-hidden="true">{s.state === "done" ? "✓" : s.state === "current" ? "•" : ""}</span><i className="life__line" /></div>
              <h3 className="life__title">{s.label}</h3>
              <p className="life__text">{s.detail}</p>
              <span className="sr">{s.state}</span>
            </li>
          ))}
        </ol>
      </Card>

      <div className="row-bottom">
        <Card label="Obligations">
          <div className="head-row"><h2 className="section__title">Obligations in V{current.version}</h2><span className="section__sub">Gross {money(gross)}{hold ? ` after the ${money(v.holdCents)} hold` : ""}</span></div>
          <table className="ob" style={{ borderCollapse: "collapse" }}>
            <caption className="sr">Obligations in the current proposal</caption>
            <thead className="sr"><tr><th>Obligation</th><th>Parties</th><th>Billed</th><th>On hold</th><th>In proposal</th></tr></thead>
            <tbody style={{ display: "contents" }}>
              {inProposal.map((o) => (
                <tr key={o.code} className={"ob__row" + (o.disputedCents && current.hasDisputeExclusions ? " ob__row--hold" : "")} style={{ display: "grid" }}>
                  <th scope="row" className="ob__who" style={{ textAlign: "left" }}><span className="ob__code">{o.code}</span><span className="ob__title">{F(o.debtor)} owes {F(o.creditor)}</span></th>
                  <td className="ob__col num">{money(o.amountCents)}<i>billed</i></td>
                  <td className={"ob__col num" + (o.disputedCents && current.hasDisputeExclusions ? " ob__col--hold" : "")}>{o.disputedCents && current.hasDisputeExclusions ? money(o.disputedCents) : "–"}<i>on hold</i></td>
                  <td className="ob__col ob__col--strong num">{money(eligible(o))}<i>in V{current.version}</i></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card label="Audit trail" className="audit-card">
          <div className="head-row" id="audit"><h2 className="section__title">Audit trail</h2><button className="link" onClick={() => setShowAll((s) => !s)}>{showAll ? "Show recent" : `All ${events.length} events →`}</button></div>
          <ul className="audit">
            {shown.map((e) => (
              <li key={e._id} className={"audit__item audit__item--" + dotKind(e)}>
                <i className="audit__dot" aria-hidden="true" />
                <div><p className="audit__title">{e.message}</p><p className="audit__time num">{clock(e.createdAt)} · recorded by the server · {actorLabel(e.actor, v.names)}</p></div>
              </li>
            ))}
          </ul>
          <p className="audit__note">Newest first. Same-time events are ordered by record creation.{events.length >= AUDIT_WINDOW ? ` Showing the ${events.length} most recent events; earlier events are not included in this view.` : ""}</p>
        </Card>
      </div>

      <Card label="Positions table">
        <details style={{ width: "100%" }}>
          <summary className="section__title" style={{ cursor: "pointer" }}>Positions and transfers as a table</summary>
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <caption className="sr">Net positions by company and proposed transfers</caption>
              <thead><tr>{["Company", prior ? `V${prior.version} (${prior.status})` : "", `V${current.version} (current)`, prior ? "Change" : "", "Delegated limit", "Agent decision"].filter(Boolean).map((h) => <th key={h} scope="col" style={{ textAlign: "left", padding: "8px 12px 8px 0", color: "#5a6678", fontWeight: 500 }}>{h}</th>)}</tr></thead>
              <tbody>
                {v.decisions.map(({ code, reading }) => {
                  const pos = positionOf(current, code), pol = v.policies[code];
                  const dirWord = (c: number) => `${c < 0 ? "Pays" : c > 0 ? "Receives" : "Settled"} ${money(Math.abs(c))}`;
                  return (
                    <tr key={code} style={{ borderTop: "1px solid rgba(14,30,58,.07)" }}>
                      <th scope="row" style={{ textAlign: "left", padding: "10px 12px 10px 0", fontWeight: 600 }}>{v.names[code]}</th>
                      {prior && <td>{dirWord(positionOf(prior, code))}</td>}
                      <td style={{ fontWeight: 600 }}>{dirWord(pos)}</td>
                      {prior && <td>{changeText(positionOf(prior, code), pos)}</td>}
                      <td>{pol ? `${pol.maxNetPayCents !== undefined ? "Max pay" : "Min receive"} ${money((pol.maxNetPayCents ?? pol.minNetReceiveCents) as number)} (policy v${pol.version})` : "None granted"}</td>
                      <td>{reading.kind === "current_accept" ? "Accepted" : reading.kind === "current_escalate" ? "Escalated" : reading.kind === "stale" ? "Stale decision" : "No decision yet"}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr><th scope="row" style={{ textAlign: "left", paddingTop: 10 }}>Proposed transfers</th><td colSpan={5} style={{ paddingTop: 10 }}>{current.transfers.map((t) => `${F(t.from)} pays ${F(t.to)} ${money(t.cents)}`).join("; ")}</td></tr></tfoot>
            </table>
          </div>
        </details>
      </Card>
      <Footer names={v.names} />
    </>
  );
}
