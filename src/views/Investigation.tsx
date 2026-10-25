import { TARGET, derive, disputeReadiness, ledger, money, type Session } from "../model";
import { Field, Section, StateMark } from "../ui";

type View = ReturnType<typeof derive>;

export function Investigation({ data, view: v, token, setToken, busy, onRun, onFile }: {
  data: Session; view: View; token: string; setToken: (t: string) => void; busy: string; onRun: () => void; onFile: () => void;
}) {
  const L = ledger(data, TARGET.obligation);
  const target = L.rows.find((r) => r.lineId === TARGET.line);
  const readiness = disputeReadiness(data);
  const cand = [...data.candidates].sort((a, b) => a.createdAt - b.createdAt).at(-1);
  const manual = cand?.modelName === "MANUAL_FALLBACK";
  const obligation = data.obligations.find((o) => o.code === TARGET.obligation);
  const matches = !!cand && cand.computedCents !== undefined && cand.claimedCents === cand.computedCents;

  return (
    <>
      <div className="band band-plain">
        <div className="band-main">
          <h2>{readiness.ok && target ? `${target.shortUnits} units billed but not received` : "The ledger does not support a shortfall"}</h2>
          <p>
            {L.invoiceId} against {L.deliveryId}, obligation {TARGET.obligation}
            {obligation ? `: Company ${obligation.debtor} owes Company ${obligation.creditor} ${money(obligation.amountCents)}` : ""}. {readiness.ok ? "Only a Company C officer can turn a validated finding into a dispute." : readiness.reason}
          </p>
        </div>
        <div className="band-figure">
          <span className="label">Shortfall per ledger</span>
          <strong className="figure">{readiness.ok ? money(readiness.cents) : "—"}</strong>
          <span className="caveat">{v.disputeFiled ? `Filed: ${money(v.holdCents)} hold recorded` : "Not filed yet"}</span>
        </div>
      </div>

      <div className="split even">
        <Section title={`Invoice ${L.invoiceId ?? ""}`} note={`Issued by Company ${obligation?.creditor ?? ""}`}>
          <div className="table-wrap">
            <table className="data doc">
              <thead><tr><th>Line</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Amount</th><th>Source</th></tr></thead>
              <tbody>
                {L.rows.map((r) => (
                  <tr key={r.lineId} className={r.lineId === TARGET.line ? "target" : undefined}>
                    <td>{r.lineId}</td>
                    <td className="num mono">{r.quantity}</td>
                    <td className="num mono">{money(r.unitPriceCents)}</td>
                    <td className="num mono">{money(r.amountCents)}</td>
                    <td className="mono muted">{r.sourceRef}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={3}>Invoice total</td><td className="num mono">{money(L.invoiceTotal)}</td><td /></tr></tfoot>
            </table>
          </div>
        </Section>
        <Section title={`Receiving report ${L.deliveryId ?? ""}`} note={`Company ${obligation?.debtor ?? ""} receiving ledger`}>
          <div className="table-wrap">
            <table className="data doc">
              <thead><tr><th>Line</th><th className="num">Billed</th><th className="num">Received</th><th className="num">Short</th><th>Source</th></tr></thead>
              <tbody>
                {L.rows.map((r) => (
                  <tr key={r.lineId} className={r.lineId === TARGET.line ? "target" : undefined}>
                    <td>{r.lineId}</td>
                    <td className="num mono">{r.quantity}</td>
                    <td className="num mono">{r.delivery ? r.delivery.received : "—"}</td>
                    <td className={"num mono" + (r.shortUnits ? " warn" : "")}>{r.shortUnits ? `−${r.shortUnits}` : "0"}</td>
                    <td className="mono muted">{r.delivery?.sourceRef ?? "no record"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={4}>Delivery period</td><td>{L.periodComplete ? "Complete" : "Not complete"}</td></tr></tfoot>
            </table>
          </div>
        </Section>
      </div>

      <Section title="Finding and validation" note="A model may propose a discrepancy. Trusted server code recomputes the supported amount from the ledger.">
        <div className="verify">
          <div className="verify-col">
            <span className="tag tag-model">{manual ? "Manual fallback" : "Model-proposed"}</span>
            {!cand ? (
              <p className="muted">No finding has been proposed yet. Run the investigator with the Company C officer credential.</p>
            ) : (
              <>
                <span className="source">{manual ? "Prepared by an officer; this is not an AI result" : cand.modelName}</span>
                <strong className="figure md">{money(cand.claimedCents)}</strong>
                <p>{cand.rationale}</p>
                <ul className="refs">{cand.sourceRefs.map((r) => <li key={r} className="mono">{r}</li>)}</ul>
              </>
            )}
          </div>
          <div className="verify-col">
            <span className="tag tag-verified">Backend-validated</span>
            {cand ? (
              <>
                <span className="source"><StateMark tone={cand.status === "SUPPORTED" ? "ok" : "warn"} label={cand.status === "SUPPORTED" ? "Supported" : cand.status.toLowerCase().replaceAll("_", " ")} /></span>
                <strong className="figure md">{cand.computedCents === undefined ? "Not supported" : money(cand.computedCents)}</strong>
                {readiness.ok && target && <p className="mono">{target.shortUnits} units × {money(target.unitPriceCents)} = {money(target.shortCents)}</p>}
                <ul className="checks">
                  <li data-ok={cand.status === "SUPPORTED"}>Server status: {cand.status.toLowerCase().replaceAll("_", " ")}</li>
                  <li data-ok={matches}>Claimed amount equals recomputed amount</li>
                  <li data-ok={L.periodComplete}>Delivery period complete</li>
                </ul>
              </>
            ) : (
              <>
                <span className="source">Ledger arithmetic only</span>
                <strong className="figure md">{readiness.ok ? money(readiness.cents) : "—"}</strong>
                {readiness.ok && target ? <p className="mono">{target.shortUnits} units × {money(target.unitPriceCents)}</p> : <p className="warn">{readiness.reason}</p>}
                <p className="muted">Not yet validated as a candidate. The server revalidates the evidence when a dispute is filed.</p>
              </>
            )}
          </div>
        </div>

        <div className="actions">
          <Field label="Company C officer credential" hint="Required to run the investigator. The model cannot file disputes.">
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Officer secret (16+ characters)" />
          </Field>
          <div className="btn-row">
            <button className="btn primary" disabled={!!busy || token.length < 16} onClick={onRun}>{busy === "AI investigation" ? "Investigating…" : "Run AI investigator"}</button>
            <button className="btn" disabled={!!busy || v.disputeFiled} onClick={onFile}>{v.disputeFiled ? "Dispute already filed" : "Continue to dispute filing"}</button>
          </div>
        </div>
      </Section>
    </>
  );
}
