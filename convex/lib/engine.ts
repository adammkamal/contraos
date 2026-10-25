/** Pure financial rules. All values are integer cents; no model controls these outcomes. */
export type CompanyCode = "A" | "B" | "C";
export const CODES: CompanyCode[] = ["A", "B", "C"];
export type Obligation = { code: string; debtor: CompanyCode; creditor: CompanyCode; amountCents: number; disputedCents: number };
export type Position = { company: CompanyCode; cents: number };
export type Transfer = { from: CompanyCode; to: CompanyCode; cents: number };
export type ProposalTerms = { obligationCodes: string[]; positions: Position[]; transfers: Transfer[]; hasDisputeExclusions: boolean; settleBy: number };
export type PolicyTerms = {
  company: CompanyCode; maxNetPayCents?: number; minNetReceiveCents?: number;
  allowedObligations: string[]; allowDisputeExclusions: boolean; expiresAt: number; settleBy: number;
};
export function cents(n: number, allowZero = true): number {
  if (!Number.isSafeInteger(n) || n < 0 || (!allowZero && n === 0)) throw new Error("INVALID_CENTS");
  return n;
}
export function safeAdd(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new Error("CENT_OVERFLOW");
  return result;
}
export function calculate(obligations: Obligation[]): { positions: Position[]; transfers: Transfer[]; hasDisputeExclusions: boolean } {
  if (obligations.length === 0) throw new Error("NO_OBLIGATIONS");
  const totals: Record<CompanyCode, number> = { A: 0, B: 0, C: 0 };
  const seen = new Set<string>();
  let hasDisputeExclusions = false;
  for (const o of obligations) {
    if (!CODES.includes(o.debtor) || !CODES.includes(o.creditor) || o.debtor === o.creditor) throw new Error("INVALID_COUNTERPARTY");
    if (!o.code || seen.has(o.code)) throw new Error("DUPLICATE_OBLIGATION");
    seen.add(o.code);
    cents(o.amountCents, false); cents(o.disputedCents);
    if (o.disputedCents > o.amountCents) throw new Error("OVERDISPUTED");
    const eligible = o.amountCents - o.disputedCents;
    totals[o.debtor] = safeAdd(totals[o.debtor], -eligible);
    totals[o.creditor] = safeAdd(totals[o.creditor], eligible);
    if (o.disputedCents > 0) hasDisputeExclusions = true;
  }
  const positions = CODES.map(company => ({ company, cents: totals[company] }));
  if (positions.reduce((s, p) => safeAdd(s, p.cents), 0) !== 0) throw new Error("NOT_BALANCED");
  const debtors = positions.filter(p => p.cents < 0).map(p => ({ ...p, remaining: -p.cents }));
  const creditors = positions.filter(p => p.cents > 0).map(p => ({ ...p, remaining: p.cents }));
  const transfers: Transfer[] = [];
  for (const d of debtors) for (const c of creditors) {
    const amount = Math.min(d.remaining, c.remaining);
    if (!amount) continue;
    if (d.company === c.company) throw new Error("SELF_TRANSFER");
    transfers.push({ from: d.company, to: c.company, cents: cents(amount, false) });
    d.remaining -= amount;
    c.remaining -= amount;
  }
  if (debtors.some(d => d.remaining !== 0) || creditors.some(c => c.remaining !== 0)) throw new Error("UNSETTLED");
  validateTransfers(transfers, positions);
  return { positions, transfers, hasDisputeExclusions };
}
export function validateTransfers(transfers: Transfer[], positions: Position[]): void {
  if (positions.length !== CODES.length || CODES.some(c => positions.filter(p => p.company === c).length !== 1)) throw new Error("INVALID_POSITIONS");
  const computed: Record<CompanyCode, number> = { A: 0, B: 0, C: 0 };
  for (const t of transfers) {
    if (!CODES.includes(t.from) || !CODES.includes(t.to) || t.from === t.to) throw new Error("INVALID_TRANSFER_PARTIES");
    cents(t.cents, false);
    computed[t.from] = safeAdd(computed[t.from], -t.cents);
    computed[t.to] = safeAdd(computed[t.to], t.cents);
  }
  for (const p of positions) {
    if (!Number.isSafeInteger(p.cents) || computed[p.company] !== p.cents) throw new Error("TRANSFER_MISMATCH");
  }
}
export function validateProposal(terms: ProposalTerms, obligations: Obligation[]): void {
  const fresh = calculate(obligations);
  const expectedCodes = obligations.map(o => o.code).sort();
  if (JSON.stringify([...terms.obligationCodes].sort()) !== JSON.stringify(expectedCodes)) throw new Error("OBLIGATIONS_CHANGED");
  if (terms.hasDisputeExclusions !== fresh.hasDisputeExclusions) throw new Error("EVIDENCE_MISMATCH");
  if (CODES.some(code => terms.positions.find(p => p.company === code)?.cents !== fresh.positions.find(p => p.company === code)?.cents)) throw new Error("STALE_POSITION");
  validateTransfers(terms.transfers, fresh.positions);
  // Convex canonicalizes persisted object keys. Compare typed fields, not JSON text.
  // This deliberately retains the deterministic transfer order and exact amounts.
  if (terms.transfers.length !== fresh.transfers.length ||
      terms.transfers.some((t, i) =>
        t.from !== fresh.transfers[i].from ||
        t.to !== fresh.transfers[i].to ||
        t.cents !== fresh.transfers[i].cents)) {
    throw new Error("TRANSFER_CHANGED");
  }
}
export function evaluatePolicy(policy: PolicyTerms | null, terms: ProposalTerms, now: number): string[] {
  if (!policy) return ["POLICY_NOT_GRANTED"];
  const reasons: string[] = [];
  if (!CODES.includes(policy.company)) reasons.push("UNKNOWN_COMPANY");
  if (policy.expiresAt <= now || !Number.isSafeInteger(policy.expiresAt)) reasons.push("POLICY_EXPIRED");
  if (policy.settleBy < terms.settleBy || !Number.isSafeInteger(terms.settleBy)) reasons.push("SETTLEMENT_DATE_OUT_OF_SCOPE");
  if (terms.obligationCodes.some(code => !policy.allowedObligations.includes(code))) reasons.push("OBLIGATION_OUT_OF_SCOPE");
  if (terms.hasDisputeExclusions && !policy.allowDisputeExclusions) reasons.push("REVISION_NOT_PERMITTED");
  const position = terms.positions.find(p => p.company === policy.company);
  if (!position) reasons.push("MISSING_POSITION");
  else if (position.cents < 0 && (policy.maxNetPayCents === undefined || -position.cents > policy.maxNetPayCents)) reasons.push("PAYMENT_LIMIT_EXCEEDED");
  else if (position.cents > 0 && (policy.minNetReceiveCents === undefined || position.cents < policy.minNetReceiveCents)) reasons.push("RECEIPT_FLOOR_NOT_MET");
  return reasons;
}
export type EvidenceVerdict = { status: "SUPPORTED" | "UNSUPPORTED" | "INSUFFICIENT_EVIDENCE" | "INVALID_INPUT"; cents?: number; reason: string };
export function validateEvidence(invoice: Array<{ quantity: number; unitPriceCents: number }>, deliveries: Array<{ received: number; periodComplete: boolean }>, claimedCents: number): EvidenceVerdict {
  if (!Number.isSafeInteger(claimedCents) || claimedCents <= 0) return { status: "INVALID_INPUT", reason: "Invalid claimed amount" };
  if (invoice.some(i => !Number.isSafeInteger(i.quantity) || i.quantity < 0 || !Number.isSafeInteger(i.unitPriceCents) || i.unitPriceCents <= 0) || deliveries.some(d => !Number.isSafeInteger(d.received) || d.received < 0)) return { status: "INVALID_INPUT", reason: "Invalid structured evidence" };
  if (invoice.length !== 1 || deliveries.length !== 1 || !deliveries[0].periodComplete) return { status: "INSUFFICIENT_EVIDENCE", reason: "Delivery record missing, incomplete or ambiguous" };
  const i = invoice[0], d = deliveries[0];
  if (d.received >= i.quantity) return { status: "UNSUPPORTED", reason: "No recorded shortfall" };
  const amount = (i.quantity - d.received) * i.unitPriceCents;
  if (!Number.isSafeInteger(amount)) return { status: "INVALID_INPUT", reason: "Amount overflow" };
  if (amount !== claimedCents) return { status: "UNSUPPORTED", reason: "Claim does not match calculated shortfall" };
  return { status: "SUPPORTED", cents: amount, reason: "Invoice quantity exceeds completed-period received quantity" };
}
