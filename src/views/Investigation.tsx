import { TARGET, disputeReadiness, ledger, money, type Code, type Session } from "../model";
import { type View } from "../story";
import { Btn, Card, Field, Footer, PageHead, Pill, firstName } from "../ui";

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function Investigation({ data, view: v, token, setToken, busy, onRun, onFile }: {
  data: Session; view: View; token: string; setToken: (t: string) => void; busy: string; onRun: () => void; onFile: () => void;
}) {
  const L = ledger(data, TARGET.obligation);
  const target = L.rows.find((r) => r.lineId === TARGET.line);
  const others = L.rows.filter((r) => r.lineId !== TARGET.line);
  const readiness = disputeReadiness(data);
  const ob = data.obligations.find((o) => o.code === TARGET.obligation);
  const F = (c: Code) => firstName(v.names, c);
  const cand = [...data.candidates].sort((a, b) => a.createdAt - b.createdAt).at(-1);
  const manual = cand?.modelName === "MANUAL_FALLBACK";
  const supported = cand?.status === "SUPPORTED";
  const matches = !!cand && cand.computedCents !== undefined && cand.claimedCents === cand.computedCents;
  const hold = data.disputes.find((d) => d.obligationCode === TARGET.obligation && d.lineId === TARGET.line);
  const billed = target?.quantity ?? 0, received = target?.delivery?.received ?? 0, short = target?.shortUnits ?? 0;
  const filer = F(ob?.debtor ?? "C");
  const gridable = billed > 0 && billed <= 200;
  const focusCredential = () => { const el = document.getElementById("inv-cred") as HTMLInputElement | null; el?.scrollIntoView({ behavior: "smooth", block: "center" }); el?.focus(); };
  const sub = !readiness.ok ? readiness.reason
    : cand ? (manual ? `A manual entry on ${TARGET.obligation} is recorded, and the server has checked it against the ledger.` : `The model suggested a discrepancy on ${TARGET.obligation} and the server has checked it against the ledger.`)
      : `The ledger shows a shortfall on ${TARGET.obligation}. No finding has been proposed yet.`;

  return (
    <>
      <PageHead title="Investigation" sub={sub} action={<Btn island onClick={focusCredential}>Run AI investigator</Btn>} />

      <div className="inv">
        <Card hero label="What the evidence shows">
          <div className="inv-hero">
            <div className="inv-hero__copy">
              <span className="eyebrow">Obligation {TARGET.obligation}{ob ? ` · ${F(ob.debtor)} owes ${F(ob.creditor)}` : ""}</span>
              <h2 className="hero__title" style={{ color: "var(--c-navy)" }}>{readiness.ok && target ? `${short} of the ${billed} units ${ob ? F(ob.creditor) : ""} billed never reached ${ob ? F(ob.debtor) : ""}` : "The ledger does not support a shortfall"}</h2>
              <p className="section__sub" style={{ fontSize: 15 }}>
                {target ? `Invoice ${L.invoiceId} charges for ${billed} units at ${money(target.unitPriceCents)} each, and the receiving report ${L.deliveryId} logs ${target.delivery ? received : "no record"} for the same line, in a delivery period that is ${L.periodComplete ? "already closed" : "not yet closed"}.` : "No invoice line is recorded for this obligation."}
              </p>
              <div className="grid__legend"><span className="grid__key">{received} received</span><span className="grid__key grid__key--miss">{short} missing</span></div>
            </div>
            {gridable && (
              <div className="grid-wrap" role="img" aria-label={`${received} of ${billed} billed units received, ${short} missing`}>
                <div className="grid">
                  {Array.from({ length: billed }, (_, i) => <i key={i} className={"grid__box " + (i < received ? "grid__box--ok" : "grid__box--miss")} />)}
                </div>
              </div>
            )}
          </div>
        </Card>
        <div className="inv__side">
          <Card tone={supported ? "mint" : "plain"} label="Server verdict">
            <div className="head-row"><span className="section__sub" style={{ fontWeight: 600, color: "inherit" }}>Server verdict</span><Pill tone={supported ? "idle" : cand ? "warn" : "info"}>{cand ? (supported ? "Supported" : cand.status.toLowerCase().replaceAll("_", " ")) : "Not yet proposed"}</Pill></div>
            <p className="verdict__amount num">{cand ? (cand.computedCents === undefined ? "Not supported" : money(cand.computedCents)) : readiness.ok ? money(readiness.cents) : "—"}</p>
            <p className="verdict__text">{target && readiness.ok ? `${short} units × ${money(target.unitPriceCents)}, recomputed from the stored rows` : readiness.reason}</p>
            <p className="verdict__text" style={{ marginTop: "auto" }}>{supported && matches ? `Matches the ${manual ? "manual entry" : "model's claim"} to the cent, so ${filer}'s officer is allowed to file it.` : cand ? "The recomputed amount does not confirm the claim." : "Ledger arithmetic only; the server revalidates when a dispute is filed."}</p>
          </Card>
          <Card label="Dispute status">
            <div className="head-row"><h2 className="section__title" style={{ fontSize: 16 }}>Dispute on {TARGET.obligation} line {TARGET.line}</h2><Pill tone={hold ? "ok" : "info"}>{hold ? "Filed" : "Not filed yet"}</Pill></div>
            <p className="section__sub">{hold ? `Filed by ${F(hold.filedBy)}'s officer: ${money(hold.cents)} on hold. The earlier proposal was superseded.` : `Only ${filer}'s officer can file it, and filing would supersede the current proposal.`}</p>
          </Card>
        </div>
      </div>

      <div className="docs">
        <Card label="Invoice">
          <div className="doc__top"><div><h2 className="doc__title">Invoice {L.invoiceId}</h2><p className="doc__sub">Issued by {ob ? `${F(ob.creditor)} (Company ${ob.creditor})` : ""}</p></div>{target && <span className="doc__code">{target.sourceRef}</span>}</div>
          {target && (
            <>
              <div className="doc__line"><div><b>Line {target.lineId}</b><span className="doc__sub">{money(target.unitPriceCents)} per unit</span></div><div className="doc__big num">{billed}<span>units billed</span></div></div>
              <dl className="kvs">
                <div className="kv"><dt>Unit price</dt><dd className="num">{money(target.unitPriceCents)}</dd></div>
                <div className="kv"><dt>Line total</dt><dd className="num">{money(target.amountCents)}</dd></div>
                <div className="kv"><dt>Obligation</dt><dd>{TARGET.obligation}{ob ? `, ${F(ob.debtor)} owes ${F(ob.creditor)} ${money(ob.amountCents)}` : ""}</dd></div>
                {others.length > 0 && <div className="kv"><dt>Other lines</dt><dd className="num">{others.map((o) => `${o.lineId}: ${o.quantity} × ${money(o.unitPriceCents)}`).join("; ")}</dd></div>}
              </dl>
            </>
          )}
        </Card>
        <Card label="Receiving report">
          <div className="doc__top"><div><h2 className="doc__title">Receiving report {L.deliveryId}</h2><p className="doc__sub">Logged by {ob ? `${F(ob.debtor)} (Company ${ob.debtor})` : ""}</p></div>{target?.delivery && <span className="doc__code">{target.delivery.sourceRef}</span>}</div>
          {target && (
            <>
              <div className="doc__line doc__line--warn"><div><b>Line {target.lineId}</b><span className="doc__sub">Received against {target.sourceRef}</span></div><div className="doc__big doc__big--warn num">{target.delivery ? received : "—"}<span>units received</span></div></div>
              <dl className="kvs">
                <div className="kv"><dt>Shortfall</dt><dd className="num">{short} units</dd></div>
                <div className="kv"><dt>Delivery period</dt><dd>{L.periodComplete ? "Closed" : "Not closed"}</dd></div>
                <div className="kv"><dt>Value of shortfall</dt><dd className="num">{money(target.shortCents)}</dd></div>
                {others.length > 0 && <div className="kv"><dt>Other lines</dt><dd className="num">{others.map((o) => `${o.lineId}: ${o.delivery ? o.delivery.received : "no record"} received`).join("; ")}</dd></div>}
              </dl>
            </>
          )}
        </Card>
      </div>

      <div className="inv2">
        <Card label="Proposed versus checked">
          <h2 className="section__title">What the model proposed, and what the server checked</h2>
          <div className="cmp">
            <div className="cmp__col">
              <span className="cmp__who">{!cand ? "No finding yet" : manual ? "Manual entry · not an AI result" : "Recorded provider finding"}</span>
              {cand && !manual && <span className="mono">{cand.modelName}</span>}
              <span className="cmp__amt num">{cand ? `${money(cand.claimedCents)} claimed` : "—"}</span>
              <span className="cmp__note">{cand ? cand.rationale : "Run the investigator, or prepare a manual entry as Company C."}</span>
              {cand && <span className="refs">{cand.sourceRefs.map((r) => <span key={r} className="mono">{r}</span>)}</span>}
              {cand && <span className="section__sub">Recorded {clock(cand.createdAt)} by the server</span>}
            </div>
            <div className={"cmp__col" + (supported ? " cmp__col--ok" : "")}>
              <span className="cmp__who">validateEvidence · server</span>
              <span className="cmp__amt num">{cand ? (cand.computedCents === undefined ? "Not supported" : `${money(cand.computedCents)} recomputed`) : "Not run"}</span>
              {supported ? (
                <ul className="checks">
                  <li className="check">Claimed and recomputed amounts match</li>
                  <li className="check">Delivery period is closed</li>
                  <li className="check">Every ledger value is in range</li>
                  <li className="check">Both source lines exist</li>
                </ul>
              ) : <span className="cmp__note">{cand ? `Server status: ${cand.status.toLowerCase().replaceAll("_", " ")}` : "No candidate to validate."}</span>}
            </div>
          </div>
        </Card>
        <Card label="Run or file">
          <h2 className="section__title">Run it again or move to filing</h2>
          <Field label={`Company ${ob?.debtor ?? "C"} officer credential`} hint={`The investigator runs under ${filer}'s officer, and the model can never file a dispute itself.`}>
            <input id="inv-cred" className="field__input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Officer secret (16+ characters)" />
          </Field>
          <div className="btn-row">
            <Btn island disabled={!!busy || token.length < 16} onClick={onRun}>{busy === "AI investigation" ? "Investigating…" : "Run AI investigator"}</Btn>
            <Btn kind="outline" disabled={!!busy || !!hold || !readiness.ok} onClick={onFile}>{hold ? "Dispute already filed" : "Go to dispute filing"}</Btn>
          </div>
        </Card>
      </div>
      <Footer names={v.names} />
    </>
  );
}
