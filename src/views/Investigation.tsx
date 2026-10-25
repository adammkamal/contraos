import { TARGET, derive, disputeReadiness, ledger, money, type Session } from "../model";
import { shortName } from "../story";
import { Field, Section, State } from "../ui";

type View = ReturnType<typeof derive>;

export function Investigation({ data, view: v, token, setToken, busy, onRun, onFile }: {
  data: Session; view: View; token: string; setToken: (t: string) => void; busy: string; onRun: () => void; onFile: () => void;
}) {
  const L = ledger(data, TARGET.obligation);
  const target = L.rows.find((r) => r.lineId === TARGET.line);
  const readiness = disputeReadiness(data);
  const obligation = data.obligations.find((o) => o.code === TARGET.obligation);
  const nm = (c: Parameters<typeof shortName>[1]) => shortName(v.names, c);
  const filer = nm(obligation?.debtor ?? "C");
  const cand = [...data.candidates].sort((a, b) => a.createdAt - b.createdAt).at(-1);
  const manual = cand?.modelName === "MANUAL_FALLBACK";
  const matches = !!cand && cand.computedCents !== undefined && cand.claimedCents === cand.computedCents;
  const hold = data.disputes.find((d) => d.obligationCode === TARGET.obligation && d.lineId === TARGET.line);
  const shortfall = L.rows.reduce((total, r) => total + r.shortCents, 0);

  return (
    <>
      <header className="head">
        <div>
          <h1>{L.invoiceId ? `${L.invoiceId} against ${L.deliveryId}` : "Evidence"}</h1>
          <p className="lead-line">
            {readiness.ok && target
              ? <><b>{target.shortUnits} of {target.quantity} units on line {target.lineId} were not received</b>, a shortfall of {money(readiness.cents)}.</>
              : <><b className="warn">The ledger does not support a shortfall.</b> {readiness.reason}</>}
            {obligation && <> Obligation {obligation.code}: {nm(obligation.debtor)} owes {nm(obligation.creditor)} {money(obligation.amountCents)}.</>}
          </p>
        </div>
        {!hold && readiness.ok && <button className="btn primary" disabled={!!busy} onClick={onFile}>Continue to dispute filing</button>}
      </header>

      <Section title="Reconciliation" note="Billed quantities from the invoice against the receiving report, line by line.">
        <div className="table-wrap">
          <table className="data stack">
            <thead>
              <tr><th>Line</th><th className="num">Billed qty</th><th className="num">Unit price</th><th className="num">Billed</th><th className="num">Received</th><th className="num">Short</th><th className="num">Shortfall</th><th>Sources</th></tr>
            </thead>
            <tbody>
              {L.rows.map((r) => (
                <tr key={r.lineId} className={r.lineId === TARGET.line ? "target" : undefined}>
                  <td className="full">{r.lineId}</td>
                  <td className="num" data-label="Billed qty">{r.quantity}</td>
                  <td className="num" data-label="Unit price">{money(r.unitPriceCents)}</td>
                  <td className="num" data-label="Billed">{money(r.amountCents)}</td>
                  <td className="num" data-label="Received">{r.delivery ? r.delivery.received : "—"}</td>
                  <td className="num" data-label="Short">{r.shortUnits ? <span className="st st-warn">{r.shortUnits}</span> : <span className="dim">0</span>}</td>
                  <td className="num strong" data-label="Shortfall">{r.shortCents ? money(r.shortCents) : <span className="dim">—</span>}</td>
                  <td className="full"><div className="refs"><span>{r.sourceRef}</span>{r.delivery && <span>{r.delivery.sourceRef}</span>}</div></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td className="full">Total</td><td /><td /><td className="num" data-label="Billed">{money(L.invoiceTotal)}</td><td /><td /><td className="num" data-label="Shortfall">{money(shortfall)}</td><td className="dim" data-label="Delivery period">{L.periodComplete ? "Complete" : "Not complete"}</td></tr>
            </tfoot>
          </table>
        </div>
      </Section>

      <Section title="What the finding rests on" note={`A model may propose a discrepancy. The server recomputes the amount from the ledger, and only ${filer}'s officer can file it.`}>
        <div className="table-wrap">
          <table className="data stack">
            <thead><tr><th>Stage</th><th>By</th><th className="num">Amount</th><th>Basis</th></tr></thead>
            <tbody>
              <tr>
                <td className="full stage">{manual ? "Entered manually" : "Proposed by model"}</td>
                <td className="full" data-label="By">{!cand ? <span className="dim">No finding yet</span> : manual ? <>An officer, not an AI result</> : <span className="mono">{cand.modelName}</span>}</td>
                <td className="num full" data-label="Amount">{cand ? money(cand.claimedCents) : "—"}</td>
                <td className="full basis">{cand ? <><p>{cand.rationale}</p><div className="refs">{cand.sourceRefs.map((r) => <span key={r}>{r}</span>)}</div></> : <p className="muted">Run the investigator, or prepare a manual entry as Company C.</p>}</td>
              </tr>
              <tr>
                <td className="full stage">Validated by the server</td>
                <td className="full" data-label="By">{cand ? <State tone={cand.status === "SUPPORTED" ? "ok" : "warn"} label={cand.status === "SUPPORTED" ? "Supported" : cand.status.toLowerCase().replaceAll("_", " ")} /> : <span className="dim">Not run</span>}</td>
                <td className="num full" data-label="Amount">{cand ? (cand.computedCents === undefined ? "Not supported" : money(cand.computedCents)) : "—"}</td>
                <td className="full basis">
                  {cand && target && readiness.ok
                    ? <p>{target.shortUnits} × {money(target.unitPriceCents)} = {money(target.shortCents)}. {L.periodComplete ? "Delivery period complete." : "Delivery period not complete."} {matches ? "Matches the proposed amount." : "Does not match the proposed amount."}</p>
                    : <p className="muted">{readiness.ok && target ? `Ledger arithmetic gives ${money(target.shortCents)}; it is not a validated finding until proposed. The server revalidates when a dispute is filed.` : readiness.reason}</p>}
                </td>
              </tr>
              <tr>
                <td className="full stage">Dispute filed</td>
                <td className="full" data-label="By">{hold ? `${nm(hold.filedBy)} officer` : <span className="dim">Not filed</span>}</td>
                <td className="num full" data-label="Amount">{hold ? money(hold.cents) : "—"}</td>
                <td className="full basis"><p className={hold ? undefined : "muted"}>{hold ? `Hold on ${hold.obligationCode} line ${hold.lineId}. The proposal that was current was superseded.` : `Only ${filer}'s officer can file this dispute.`}</p></td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <details className="fold">
        <summary>Run the AI investigator</summary>
        <div className="form">
          <Field label={`${filer} officer credential`} hint="Required. The model can only propose; it cannot file a dispute.">
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Officer secret (16+ characters)" />
          </Field>
          <div className="btn-row"><button className="btn" disabled={!!busy || token.length < 16} onClick={onRun}>{busy === "AI investigation" ? "Investigating…" : "Run investigator"}</button></div>
        </div>
      </details>
    </>
  );
}
