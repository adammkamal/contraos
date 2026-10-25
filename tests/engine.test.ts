import { describe, expect, it } from "vitest";
import { calculate, evaluatePolicy, validateEvidence, validateProposal, validateTransfers, type Obligation, type PolicyTerms } from "../convex/lib/engine";

const obligations: Obligation[] = [
  { code: "O1", debtor: "A", creditor: "B", amountCents: 2_000_000, disputedCents: 0 },
  { code: "O2", debtor: "B", creditor: "C", amountCents: 1_500_000, disputedCents: 0 },
  { code: "O3", debtor: "C", creditor: "A", amountCents: 1_200_000, disputedCents: 0 }
];
const policy: PolicyTerms = {
  company: "A", maxNetPayCents: 900_000, allowedObligations: ["O1", "O2", "O3"],
  allowDisputeExclusions: true, expiresAt: Date.UTC(2026, 10, 1),
  settleBy: Date.UTC(2026, 9, 31)
};
describe("financial and policy invariants", () => {
  it("V1 balances and yields $8k of net transfers", () => {
    const result = calculate(obligations);
    expect(result.positions.map(p => p.cents)).toEqual([-800000, 500000, 300000]);
    expect(result.transfers.map(t => t.cents)).toEqual([500000, 300000]);
    expect(evaluatePolicy(policy, { ...result, obligationCodes: obligations.map(o => o.code), settleBy: policy.settleBy }, Date.UTC(2026, 9, 24))).toEqual([]);
  });
  it("V2 exceeds A's delegated payment limit", () => {
    const changed = obligations.map(o => o.code === "O3" ? { ...o, disputedCents: 200000 } : o);
    const result = calculate(changed);
    expect(result.positions.map(p => p.cents)).toEqual([-1000000, 500000, 500000]);
    expect(evaluatePolicy(policy, { ...result, obligationCodes: changed.map(o => o.code), settleBy: policy.settleBy }, Date.UTC(2026, 9, 24))).toContain("PAYMENT_LIMIT_EXCEEDED");
    expect(evaluatePolicy({ ...policy, maxNetPayCents: 1000000 }, { ...result, obligationCodes: changed.map(o => o.code), settleBy: policy.settleBy }, Date.UTC(2026, 9, 24))).toEqual([]);
  });
  it("rejects malformed financial data, transfers and stale versions", () => {
    expect(() => calculate([...obligations, obligations[0]])).toThrow("DUPLICATE_OBLIGATION");
    expect(() => calculate([{ ...obligations[0], amountCents: 0.1 }])).toThrow();
    const old = calculate(obligations);
    expect(() => validateTransfers([{from:"A",to:"B",cents:1}],old.positions)).toThrow("TRANSFER_MISMATCH");
    const changed = obligations.map(o => o.code === "O3" ? { ...o, disputedCents: 200000 } : o);
    expect(() => validateProposal({ ...old, obligationCodes: obligations.map(o => o.code), settleBy: policy.settleBy }, changed)).toThrow();
  });
  it("confirms the source-backed $2000 shortfall only", () => {
    const invoice = [{ quantity: 100, unitPriceCents: 5000 }];
    const delivery = [{ received: 60, periodComplete: true }];
    expect(validateEvidence(invoice, delivery, 200000).status).toBe("SUPPORTED");
    expect(validateEvidence(invoice, delivery, 500000).status).toBe("UNSUPPORTED");
    expect(validateEvidence(invoice, [], 200000).status).toBe("INSUFFICIENT_EVIDENCE");
    expect(validateEvidence(invoice, [{received: -1, periodComplete:true}], 200000).status).toBe("INVALID_INPUT");
  });
});
