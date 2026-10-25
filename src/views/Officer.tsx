import { useState } from "react";
import { CODES, TARGET, decisionOf, disputeReadiness, interpretDecision, ledger, limitGap, money, positionOf, readingNote, reasonText, requirement, signedMoney, transferTotal, type Code, type Session } from "../model";
import { type View } from "../story";
import { Btn, Card, DecisionPill, Field, Footer, Mark, PageHead, Pill, firstName } from "../ui";

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function Officer({ data, view: v, company, onCompany, token, setToken, limit, setLimit, busy, onGrant, onDispute, onManual }: {
  data: Session; view: View; company: Code; onCompany: (c: Code) => void; token: string; setToken: (t: string) => void;
  limit: string; setLimit: (l: string) => void; busy: string; onGrant: () => void; onDispute: () => void; onManual: () => void;
}) {
  // Review step is local to this screen and resets when the company or amount changes.
  const [review, setReview] = useState<{ company: Code; limit: string } | null>(null);
  const [open, setOpen] = useState(false);
  const F = (c: Code) => firstName(v.names, c);
  const { current, prior } = v;
  const policy = v.policies[company];
  const pays = company === "A";
  const position = positionOf(current, company);
  const { decision, reading } = v.decisions.find((d) => d.code === company)!;
  const req = requirement(position, policy);
  const gap = limitGap(position, policy);
  const note = readingNote(reading);
  const amount = Math.round(Number(limit) * 100);
  const validAmount = limit.trim() !== "" && Number.isSafeInteger(amount) && amount >= 0;
  const granted = policy ? (pays ? policy.maxNetPayCents : policy.minNetReceiveCents) : undefined;
  const credentialOk = token.length >= 16;
  const blockingHere = v.phase === "blocked" && reading.kind === "current_escalate";
  const pendingHere = current?.status === "open" && reading.kind === "stale";
  const waitingOn = v.phase === "blocked" ? v.escalated : v.phase === "reevaluating" ? v.stale : [];
  const waitingElsewhere = !blockingHere && !pendingHere && waitingOn.length > 0 && !waitingOn.includes(company);
  const readiness = disputeReadiness(data);
  const L = ledger(data, TARGET.obligation);
  const row = L.rows.find((r) => r.lineId === TARGET.line);
  const ob = data.obligations.find((o) => o.code === TARGET.obligation);
  const canDispute = company === "C" && !v.disputeFiled;
  const showForm = open || blockingHere || pendingHere;
  const nextVersion = (policy?.version ?? 0) + 1;
  const reviewing = !!review && review.company === company && review.limit === limit;
  const disputeWhy = !readiness.ok ? readiness.reason : !credentialOk ? `Enter the ${F("C")} officer credential.` : "";
  const noun = pays ? "maximum net payment" : "minimum net receipt";
  const word = pays ? "Maximum net payment" : "Minimum net receipt";
  const ver = current ? `V${current.version}` : "";
  const hold = data.disputes.find((d) => d.obligationCode === TARGET.obligation && d.lineId === TARGET.line);

  const changeCompany = (c: Code) => { setReview(null); setOpen(false); onCompany(c); };
  const setAmount = (value: string) => { setReview(null); setLimit(value); };

  // Slider: where the current limit sits against what the proposal needs; scaled like the reference (needs at ~83%).
  const typed = validAmount ? amount : req.amount;
  const scale = Math.max(req.amount, granted ?? 0, typed) * 1.2 || 1;
  const at = (n: number) => `${Math.min(100, Math.max(0, (n / scale) * 100))}%`;

  const title = blockingHere
    ? pays ? `Raise ${F(company)}'s limit to ${money(req.amount)} so Agent ${company} can accept ${ver}` : `Lower ${F(company)}'s floor to ${money(req.amount)} or less so Agent ${company} can accept ${ver}`
    : pendingHere ? `Agent ${company} must decide again under policy v${policy?.version}`
      : granted === undefined ? `${F(company)} has no ${noun} yet` : `${F(company)}'s ${noun} covers ${ver}`;

  const history = [...data.proposals].sort((a, b) => b.version - a.version).slice(0, 2).map((p) => {
    const d = decisionOf(data, p, company);
    const pol = d?.policyVersion !== undefined ? data.policies.find((x) => x.company === company && x.version === d.policyVersion) : undefined;
    const bound = pol ? (pol.maxNetPayCents ?? pol.minNetReceiveCents) : undefined;
    const pos = positionOf(p, company);
    return { p, d, reading: interpretDecision(d, v.policies[company], p._id), bound, pos };
  });
  const showPendingNext = company === "C" && !hold && !!current && !data.proposals.some((p) => p.version > current.version);

  return (
    <>
      <PageHead
        compact
        title="Officer portal"
        sub={`Acting for ${F(company)}. The server works out which company you represent from your credential, so switching here only changes the view.`}
        action={
          <div className="switch" role="group" aria-label="Company">
            {CODES.map((c) => (
              <button key={c} className="switch__item" aria-pressed={company === c} onClick={() => changeCompany(c)}><Mark code={c} small /><span className="switch__name">{F(c)}</span></button>
            ))}
          </div>
        }
      />

      {waitingElsewhere && <p className="note">{ver} is waiting on {waitingOn.map((c) => `Company ${c}`).join(" and ")}. Select that company to review its limit.</p>}

      <div className={"officer" + (company === "C" ? " officer--c" : "")}>
        <div className="officer__side">
          {company === "C" && (
            <Card tone="navy" hero className="card--dispute" label="Evidence dispute">
              <span className="eyebrow">{hold ? "Dispute filed" : readiness.ok ? "Validated finding · ready to file" : "Finding not supported"}</span>
              <h2 className="officer__title">
                {hold ? `${money(hold.cents)} is on hold on ${TARGET.obligation} line ${TARGET.line}` : readiness.ok && row ? `Hold ${money(readiness.cents)} on ${TARGET.obligation} line ${TARGET.line} for the ${row.shortUnits} units ${F("C")} never received` : "The ledger does not support a dispute"}
              </h2>
              <p className="hero__text" style={{ maxWidth: 760 }}>
                {hold ? `Filed by ${F(hold.filedBy)}'s officer. The earlier proposal was superseded, and its decisions stay in the record.`
                  : readiness.ok ? `The server already matched this amount to ${L.invoiceId} and ${L.deliveryId}, and it checks the evidence again the moment you file. Filing supersedes ${ver}${current?.status === "authorized" ? `, which was authorized at ${money(transferTotal(current))}` : ""}.`
                    : readiness.reason}
              </p>
              {row && row.quantity > 0 && row.quantity <= 200 && (
                <>
                  <div className="strip" style={{ gridTemplateColumns: `repeat(${row.quantity}, 1fr)` }} role="img" aria-label={`${row.delivery?.received ?? 0} of ${row.quantity} units received, ${row.shortUnits} missing`}>
                    {Array.from({ length: row.quantity }, (_, i) => <i key={i} className={"strip__seg" + (i < (row.delivery?.received ?? 0) ? "" : " strip__seg--miss")} />)}
                  </div>
                  <div className="strip__legend"><span className="ok">{row.delivery?.received ?? 0} received</span><span className="miss num">{row.shortUnits} missing × {money(row.unitPriceCents)} = {money(row.shortCents)}</span></div>
                </>
              )}
              {canDispute && (
                <>
                  <Field label={`Company C officer credential`}>
                    <input className="field__input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="16+ characters" />
                  </Field>
                  <div className="btn-row">
                    <Btn kind="mint" island disabled={!!busy || !!disputeWhy} onClick={onDispute}>File {readiness.ok ? money(readiness.cents) + " " : ""}dispute</Btn>
                    <Btn kind="ghost-dark" disabled={!!busy || !!disputeWhy} onClick={onManual}>Prepare manual fallback</Btn>
                  </div>
                  {disputeWhy ? <p className="hero__text" style={{ fontSize: 13 }}>{disputeWhy}</p> : <p className="hero__text" style={{ fontSize: 13 }}>The manual fallback records a finding you prepared when the model is unavailable, and it is labelled so nobody reads it as an AI result.</p>}
                </>
              )}
            </Card>
          )}

          {(company !== "C" || showForm) && (
          <Card hero className="card--main" label={`${word}`}>
            <span className="eyebrow">{F(company)} · {word}</span>
            <h2 className="officer__title">{blockingHere && pays ? <><span className="t-full">{title}</span><span className="t-short">Raise the limit to {money(req.amount)}</span></> : title}</h2>
            {pendingHere && <p className="note note--warn">{note}</p>}
            {granted !== undefined && req.amount > 0 && (
              <div className="slider" role="img" aria-label={`Current ${noun} ${money(granted)}; ${ver} needs ${money(req.amount)}`}>
                <div className="slider__track">
                  <span className="slider__now" style={{ left: at(granted) }}>Now {money(granted)}</span>
                  <span className="slider__fill" style={{ width: at(granted) }} />
                  {req.amount > granted && <span className="slider__zone" style={{ left: at(granted), width: `calc(${at(req.amount)} - ${at(granted)})` }} />}
                  <span className="slider__mark" style={{ left: at(granted) }} />
                  <span className="slider__handle" style={{ left: at(typed) }} />
                </div>
                <div className="slider__labels"><span style={{ left: 0 }}>$0</span><span className="slider__need" style={{ left: at(req.amount) }}>{ver} needs {money(req.amount)}</span><span style={{ right: 0 }}>{money(Math.round(scale))}</span></div>
              </div>
            )}
            {!showForm ? (
              <Btn kind="outline" onClick={() => setOpen(true)}>Change {noun}…</Btn>
            ) : (
              <>
                <div className="amount-row">
                  <Field label={`New ${noun}`} unit="USD" prefix="$">
                    <input className="field__input field__input--big num" type="number" inputMode="decimal" min="0" step="1" value={limit} onChange={(e) => setAmount(e.target.value)} aria-label={`New ${noun} (USD)`} />
                  </Field>
                  <div className="diff"><span className="diff__label">Policy v{policy?.version ?? 0} → v{nextVersion}</span><b className="num">{granted === undefined ? "None" : money(granted)} → {validAmount ? money(amount) : "—"}</b></div>
                </div>
                <Field label={`Company ${company} officer credential`} hint="Sent with the change and checked by the server; this page does not store it.">
                  <input className="field__input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="16+ characters" />
                </Field>
                {!reviewing ? (
                  <div className="btn-row">
                    <Btn island disabled={!!busy || !credentialOk || !validAmount} onClick={() => setReview({ company, limit })}>Review change</Btn>
                    <span className="note">Takes effect immediately and asks Agent {company} to decide on {ver} again.</span>
                    {!blockingHere && !pendingHere && <Btn kind="ghost" onClick={() => { setOpen(false); setReview(null); }}>Cancel</Btn>}
                  </div>
                ) : (
                  <div className="review" role="group" aria-label="Confirm authority change">
                    <h3>Confirm change to {F(company)}'s authority</h3>
                    <div className="change"><span>{granted === undefined ? "None" : money(granted)}</span><span className="arrow">→</span><span>{money(amount)}</span><small>{noun}, policy v{nextVersion}</small></div>
                    <p>This takes effect immediately. {F(company)}'s agent will decide again on {ver} under the new policy; authorization still needs three current accepts.</p>
                    <div className="btn-row">
                      <Btn island disabled={!!busy || !credentialOk || !validAmount} onClick={() => { setReview(null); setOpen(false); onGrant(); }}>Amend authority</Btn>
                      <Btn kind="outline" onClick={() => setReview(null)}>Back</Btn>
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
          )}
        </div>

        <div className="officer__side">
          {blockingHere ? (
            <Card tone="warn" className="card--alert" label="Escalation">
              <h2 className="alert__head"><span aria-hidden="true">⚠</span>Agent {company} escalated {ver}</h2>
              <div className="alert__nums"><div><span>{ver} requires</span><b className="num">{money(req.amount)}</b></div><div><span>Granted in v{policy?.version ?? 0}</span><b className="warn num">{granted === undefined ? "None" : money(granted)}</b></div></div>
              {decision && <div className="btn-row">{decision.reasons.map((r) => <span key={r} className="code">{r}</span>)}</div>}
              <p className="agent__why">Authorization stays blocked until a policy version {pays ? "covers" : "allows"} {money(req.amount)} and Agent {company} accepts under it.{decision && decision.reasons.some((r) => !/LIMIT|FLOOR/.test(r)) ? ` (${decision.reasons.map(reasonText).join("; ")})` : ""}</p>
            </Card>
          ) : (
            <Card className="card--alert" label={`${F(company)}'s agent today`}>
              <div className="head-row"><h2 className="section__title" style={{ fontSize: 16 }}>{F(company)}'s agent today</h2><DecisionPill reading={reading} /></div>
              <p className="agent__amount num" style={{ color: pays ? "var(--c-navy)" : "var(--c-money)" }}>{signedMoney(position)}<span className="agent__was">{ver ? `under ${ver}` : ""}</span></p>
              <dl className="kvs">
                <div className="kv"><dt>{word}</dt><dd className="num">{granted === undefined ? "None granted" : `${money(granted)} · policy v${policy?.version}`}</dd></div>
                <div className="kv"><dt>{pays ? "Pays under" : "Would receive under"} {ver}</dt><dd className="num">{money(Math.abs(position))}</dd></div>
                {company !== "C" && <div className="kv"><dt>Against the limit</dt><dd>{gap === undefined ? "No limit set" : gap > 0 ? `${money(gap)} ${pays ? "over" : "short"}` : gap === 0 ? "At the limit, no margin" : `${money(-gap)} to spare`}</dd></div>}
              </dl>
              {company === "C" && !showForm && <button className="link" onClick={() => setOpen(true)}>Change {noun}…</button>}
            </Card>
          )}
          {company === "C" ? (
            <Card className="card--aside" label="What filing sets off">
              <h2 className="section__title" style={{ fontSize: 16 }}>What filing sets off</h2>
              <ol className="steps">
                <li className="steps__item steps__item--first"><span className="steps__n">1</span><div><h3>Hold recorded</h3><p>{row && ob ? `${money(row.shortCents)} comes off ${TARGET.obligation}, leaving ${money(ob.amountCents - row.shortCents)}` : "The held amount comes off the obligation"}</p></div></li>
                <li className="steps__item"><span className="steps__n">2</span><div><h3>{prior ? `V${prior.version}` : "The current proposal"} superseded</h3><p>Its decisions stay in the record</p></div></li>
                <li className="steps__item"><span className="steps__n">3</span><div><h3>A new proposal is built</h3><p>The engine re-nets the obligations</p></div></li>
                <li className="steps__item"><span className="steps__n">4</span><div><h3>Agents decide</h3><p>Each one checks it against its policy</p></div></li>
              </ol>
            </Card>
          ) : (
            <Card className="card--aside" label="Policy details">
              <h2 className="section__title" style={{ fontSize: 16 }}>What policy v{policy?.version ?? 0} records</h2>
              <dl className="kvs">
                <div className="kv"><dt>Policy version</dt><dd>{policy ? `v${policy.version}` : "None granted"}</dd></div>
                <div className="kv"><dt>{word}</dt><dd className="num">{granted === undefined ? "—" : money(granted)}</dd></div>
                <div className="kv"><dt>Policy expires</dt><dd>{policy ? new Date(policy.expiresAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "—"}</dd></div>
              </dl>
            </Card>
          )}
        </div>
      </div>

      <Card label="Decision history">
        <div className="hist">
          <div><h2 className="section__title">{F(company)}'s decision history</h2><p className="section__sub" style={{ marginTop: 6 }}>Every decision is tied to the proposal and policy version it was made under.</p></div>
          {history.map(({ p, d, reading: r, bound, pos }) => (
            <div key={p._id} className="hist__row">
              <div className="hist__top"><span>Proposal V{p.version}</span>{d ? <DecisionPill reading={{ ...r, kind: r.kind === "historical" ? (d.decision === "accept" ? "current_accept" : "current_escalate") : r.kind }} /> : <Pill>No decision</Pill>}</div>
              <p className="num">{d ? `Policy v${d.policyVersion ?? "none"}${bound !== undefined ? ` · ${pays ? "limit" : "floor"} ${money(bound)}` : ""} · ${pos < 0 ? "pays" : "receives"} ${money(Math.abs(pos))}` : "No decision is recorded for this proposal"}</p>
              {d && <p className="when num">{clock(d.decidedAt)} · recorded by the server</p>}
            </div>
          ))}
          {showPendingNext && <div className="hist__row hist__row--pending"><div className="hist__top"><span>Proposal V{(current?.version ?? 0) + 1}</span></div><p>Appears here after you file</p></div>}
        </div>
      </Card>
      <Footer names={v.names} />
    </>
  );
}
