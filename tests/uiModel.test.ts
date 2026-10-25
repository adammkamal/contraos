import { describe, expect, it } from "vitest";
import { authorizationHistory, derive, disputeReadiness, formContext, grossCents, interpretDecision, latestPolicies, ledger, limitGap, money, readingNote, signedMoney, type Code, type Session } from "../src/model";

type Scene = "blocked" | "stale" | "authorized";
const T = 1_700_000_000_000;

const dec = (company: Code, decision: "accept" | "escalate", policyVersion: number | undefined, proposalId = "p2", reasons: string[] = decision === "escalate" ? ["PAYMENT_LIMIT_EXCEEDED"] : []) =>
  ({ _id: `d-${proposalId}-${company}`, proposalId, company, decision, reasons, policyVersion, decidedAt: T });
const pol = (company: Code, version: number, cents: number) => ({ company, version, ...(company === "A" ? { maxNetPayCents: cents } : { minNetReceiveCents: cents }) });
const patch = (data: Session, changes: Record<string, unknown>) => ({ ...data, ...changes }) as unknown as Session;
const v1Authorized = { _id: "a1", kind: "proposal_authorized", message: "Proposal V1 authorized — no funds transferred", actor: "System", createdAt: T };
const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ _id: `f${i}`, kind: "agent_decided", message: `event ${i}`, actor: "Agent A", createdAt: T + i }));

// Hand-built read model shaped like api.workflow.getSession; no backend involved.
function session(scene: Scene): Session {
  const v2Status = scene === "authorized" ? "authorized" : "open";
  const policyA = scene === "blocked" ? [pol("A", 1, 900_000)] : [pol("A", 1, 900_000), pol("A", 2, 1_000_000)];
  return {
    session: { id: "s", slug: "demo", label: "demo", evidenceVersion: 2, currentProposalId: "p2" },
    companies: [{ code: "A", name: "Atlas" }, { code: "B", name: "Beacon" }, { code: "C", name: "Cedar" }],
    obligations: [
      { code: "O1", debtor: "A", creditor: "B", amountCents: 2_000_000, disputedCents: 0 },
      { code: "O2", debtor: "B", creditor: "C", amountCents: 1_500_000, disputedCents: 0 },
      { code: "O3", debtor: "C", creditor: "A", amountCents: 1_200_000, disputedCents: 200_000 },
    ],
    proposals: [
      { _id: "p1", version: 1, status: "superseded", obligationCodes: ["O1", "O2", "O3"], hasDisputeExclusions: false, evidenceVersion: 1,
        positions: [{ company: "A", cents: -800_000 }, { company: "B", cents: 500_000 }, { company: "C", cents: 300_000 }],
        transfers: [{ from: "A", to: "B", cents: 500_000 }, { from: "A", to: "C", cents: 300_000 }] },
      { _id: "p2", version: 2, status: v2Status, obligationCodes: ["O1", "O2", "O3"], hasDisputeExclusions: true, evidenceVersion: 2,
        positions: [{ company: "A", cents: -1_000_000 }, { company: "B", cents: 500_000 }, { company: "C", cents: 500_000 }],
        transfers: [{ from: "A", to: "B", cents: 500_000 }, { from: "A", to: "C", cents: 500_000 }] },
    ],
    decisions: [
      scene === "authorized" ? dec("A", "accept", 2) : dec("A", "escalate", 1),
      dec("B", "accept", 1),
      dec("C", "accept", 1),
    ],
    policies: [...policyA, pol("B", 1, 400_000), pol("C", 1, 200_000)],
    audit: [v1Authorized],
    candidates: [],
    disputes: [{ sessionId: "s", obligationCode: "O3", lineId: "L1", cents: 200_000, filedBy: "C", createdAt: T }],
    evidence: {
      invoices: [{ sessionId: "s", obligationCode: "O3", lineId: "L1", quantity: 100, unitPriceCents: 5000, sourceRef: "INV-003:L1" }],
      deliveries: [{ sessionId: "s", obligationCode: "O3", lineId: "L1", received: 60, periodComplete: true, sourceRef: "DEL-003:L1" }],
    },
  } as unknown as Session;
}

describe("money and ledger arithmetic", () => {
  it("formats safe-integer cents without inventing precision", () => {
    expect(money(1_000_000)).toBe("$10,000");
    expect(money(1250)).toBe("$12.50");
    expect(signedMoney(-800_000)).toBe("−$8,000");
    expect(signedMoney(500_000)).toBe("+$5,000");
  });

  it("derives V1 and dispute-adjusted V2 gross obligations from live rows", () => {
    const data = session("blocked");
    expect(grossCents(data.proposals[0], data.obligations)).toBe(4_700_000);
    expect(grossCents(data.proposals[1], data.obligations)).toBe(4_500_000);
  });

  it("computes the shortfall from persisted invoice and delivery rows", () => {
    const L = ledger(session("blocked"), "O3");
    expect(L.rows[0]).toMatchObject({ shortUnits: 40, shortCents: 200_000 });
    expect(L.periodComplete).toBe(true);
    expect(L.invoiceId).toBe("INV-003");
  });
});

describe("interpretDecision", () => {
  const v1 = pol("A", 1, 900_000) as never;
  const v2 = pol("A", 2, 1_000_000) as never;
  const accept = (version: number | undefined, proposalId = "p2") => dec("A", "accept", version, proposalId) as never;

  it("reads a current accept under the current policy as approved", () => {
    expect(interpretDecision(accept(1), v1, "p2")).toMatchObject({ kind: "current_accept", approved: true });
  });

  it("reads a current escalation as not approved", () => {
    expect(interpretDecision(dec("A", "escalate", 1) as never, v1, "p2")).toMatchObject({ kind: "current_escalate", approved: false });
  });

  it("never treats a missing decision as approved", () => {
    const r = interpretDecision(undefined, v1, "p2");
    expect(r).toMatchObject({ kind: "missing", approved: false });
    expect(readingNote(r)).toMatch(/No agent decision/);
  });

  it("does not count an accept recorded under an older policy version", () => {
    const r = interpretDecision(accept(1), v2, "p2");
    expect(r).toMatchObject({ kind: "stale", approved: false, recorded: "accept", decidedUnder: 1, currentPolicy: 2 });
    expect(readingNote(r)).toMatch(/does not count until the agent decides again/);
  });

  it("does not count an escalation recorded under an older policy version as a current block", () => {
    expect(interpretDecision(dec("A", "escalate", 1) as never, v2, "p2").kind).toBe("stale");
  });

  it("moves from stale to current once the agent decides under the new policy", () => {
    expect(interpretDecision(accept(1), v2, "p2").kind).toBe("stale");
    expect(interpretDecision(accept(2), v2, "p2")).toMatchObject({ kind: "current_accept", approved: true });
  });

  it("marks decisions on an earlier proposal as historical", () => {
    expect(interpretDecision(accept(1, "p1"), v1, "p2")).toMatchObject({ kind: "historical", approved: false });
  });

  it("treats no-policy-then-policy as stale and no-policy-throughout as current", () => {
    expect(interpretDecision(dec("A", "escalate", undefined, "p2", ["POLICY_NOT_GRANTED"]) as never, undefined, "p2").kind).toBe("current_escalate");
    expect(interpretDecision(dec("A", "escalate", undefined, "p2", ["POLICY_NOT_GRANTED"]) as never, v1, "p2").kind).toBe("stale");
  });

  it("gives the same note for a stale decision regardless of proposal status", () => {
    expect(readingNote(interpretDecision(accept(1), v2, "p2"))).toMatch(/does not count until the agent decides again/);
  });
});

describe("authorization semantics in derive", () => {
  it("reports blocked only for a current escalation", () => {
    const v = derive(session("blocked"));
    expect(v.phase).toBe("blocked");
    expect(v.escalated).toEqual(["A"]);
    expect(v.steps.map((s) => s.state)).toEqual(["done", "done", "done", "current", "waiting"]);
  });

  it("reports re-evaluation, not blocked, when the escalation predates a newer policy", () => {
    const v = derive(session("stale"));
    expect(v.phase).toBe("reevaluating");
    expect(v.stale).toEqual(["A"]);
    expect(v.escalated).toEqual([]);
    expect(v.steps[3]).toMatchObject({ label: "Officer amendment", state: "current" });
    expect(v.steps[3].detail).toMatch(/re-evaluation pending/);
  });

  it("does not call an open proposal authorized when every agent has a current accept", () => {
    const data = patch(session("blocked"), { decisions: [dec("A", "accept", 1), dec("B", "accept", 1), dec("C", "accept", 1)], policies: [pol("A", 1, 1_000_000), pol("B", 1, 400_000), pol("C", 1, 200_000)] });
    const v = derive(data);
    expect(v.phase).toBe("pending_authorization");
    expect(v.steps.at(-1)).toMatchObject({ state: "current", detail: expect.stringMatching(/server's authorization check/) });
    expect(v.steps.every((s) => s.state === "done")).toBe(false);
  });

  it("keeps an open proposal with missing decisions in evaluating", () => {
    const v = derive(patch(session("blocked"), { decisions: [dec("B", "accept", 1)] }));
    expect(v.phase).toBe("evaluating");
    expect(v.missing).toEqual(["A", "C"]);
    expect(v.steps[2].state).toBe("current");
  });

  it("with no decisions at all, nothing appears approved", () => {
    const v = derive(patch(session("blocked"), { decisions: [] }));
    expect(v.phase).toBe("evaluating");
    expect(v.decisions.every((d) => !d.reading.approved)).toBe(true);
  });

  it("takes authorization only from the persisted proposal status and traces the amendment", () => {
    const v = derive(session("authorized"));
    expect(v.phase).toBe("authorized");
    expect(v.amendments).toEqual([{ code: "A", from: 900_000, to: 1_000_000, kind: "max" }]);
    expect(v.steps.every((s) => s.state === "done")).toBe(true);
  });

  it("flags an authorized status with a non-current decision as inconsistent", () => {
    // Not a state grantPolicy can produce: it reopens authorization in the same transaction as the
    // new policy. This only checks the frontend does not present such a snapshot as healthy.
    const data = patch(session("authorized"), { policies: [pol("A", 1, 900_000), pol("A", 2, 1_000_000), pol("A", 3, 1_100_000), pol("B", 1, 400_000), pol("C", 1, 200_000)] });
    const v = derive(data);
    expect(v.phase).toBe("authorized");
    expect(v.decisions[0].reading.kind).toBe("stale");
    expect(v.consistent).toBe(false);
    expect(derive(session("authorized")).consistent).toBe(true);
  });

  it("shows a policy-invalidated authorization as reopened and re-evaluating", () => {
    const invalidated = { _id: "a9", kind: "authorization_invalidated", message: "V2 requires fresh authorization after policy change", actor: "system", createdAt: T + 10 };
    const v = derive(patch(session("stale"), { audit: [invalidated, v1Authorized] }));
    expect(v.phase).toBe("reevaluating");
    expect(v.reopened).toBe(true);
    expect(v.steps.at(-1)).toMatchObject({ state: "waiting", detail: expect.stringMatching(/Invalidated by a policy change/) });
  });

  it("ignores a superseded decision when picking the current escalation", () => {
    const data = patch(session("blocked"), { decisions: [dec("A", "escalate", 1, "p1"), dec("A", "accept", 1), dec("B", "accept", 1), dec("C", "accept", 1)], policies: [pol("A", 1, 1_000_000), pol("B", 1, 400_000), pol("C", 1, 200_000)] });
    expect(derive(data).escalated).toEqual([]);
  });
});

describe("company switching", () => {
  const policies = [pol("A", 1, 900_000), pol("A", 2, 1_000_000), pol("B", 1, 400_000)] as never;

  it("always starts with an empty credential", () => {
    for (const c of ["A", "B", "C"] as Code[]) expect(formContext(policies, c).token).toBe("");
  });

  it("prefills the latest granted limit for that company only", () => {
    expect(formContext(policies, "A")).toEqual({ company: "A", token: "", limit: "10000" });
    expect(formContext(policies, "B")).toEqual({ company: "B", token: "", limit: "4000" });
  });

  it("falls back to the scenario default when a company has no policy", () => {
    expect(formContext(policies, "C").limit).toBe("2000");
    expect(formContext([], "A").limit).toBe("9000");
  });

  it("prefills the exact required amount when reviewing a blocked company", () => {
    expect(formContext(policies, "A", 1_000_000).limit).toBe("10000");
    expect(formContext(policies, "A", 1_050).limit).toBe("10.5");
  });

  it("resolves the latest policy regardless of row order", () => {
    expect(latestPolicies([pol("A", 2, 1) , pol("A", 1, 2)] as never).A?.version).toBe(2);
  });
});

describe("disputeReadiness", () => {
  const evidence = (invoices: unknown[], deliveries: unknown[]) => patch(session("blocked"), { evidence: { invoices, deliveries } });
  const inv = { sessionId: "s", obligationCode: "O3", lineId: "L1", quantity: 100, unitPriceCents: 5000, sourceRef: "INV-003:L1" };
  const del = (over: Record<string, unknown> = {}) => ({ sessionId: "s", obligationCode: "O3", lineId: "L1", received: 60, periodComplete: true, sourceRef: "DEL-003:L1", ...over });

  it("is ready with a complete period and a positive shortfall", () => {
    expect(disputeReadiness(session("blocked"))).toEqual({ ok: true, cents: 200_000, reason: "" });
  });

  it("blocks and explains when the delivery record is missing", () => {
    const r = disputeReadiness(evidence([inv], []));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/No delivery record/);
  });

  it("blocks when the delivery period is not complete", () => {
    const r = disputeReadiness(evidence([inv], [del({ periodComplete: false })]));
    expect(r).toMatchObject({ ok: false, cents: 0 });
    expect(r.reason).toMatch(/not complete/);
  });

  it("blocks when received quantity covers the billed quantity", () => {
    for (const received of [100, 120]) {
      const r = disputeReadiness(evidence([inv], [del({ received })]));
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/no shortfall/);
    }
  });

  it("blocks when the invoice line is missing", () => {
    expect(disputeReadiness(evidence([], [del()])).reason).toMatch(/No invoice line/);
  });

  it("blocks non-whole-cent ledger values", () => {
    expect(disputeReadiness(evidence([{ ...inv, unitPriceCents: 50.5 }], [del()])).ok).toBe(false);
  });
});

describe("V1 supersession history", () => {
  it("shows V1 as authorized only when the audit trail records it", () => {
    const data = session("blocked");
    expect(authorizationHistory(data, data.proposals[0])).toBe("authorized");
    const steps = derive(data).steps;
    expect(steps[0]).toMatchObject({ label: "V1 authorized", state: "done" });
    expect(steps[1].state).toBe("done");
  });

  it("does not claim authorization for a superseded V1 with no recorded authorization", () => {
    const data = patch(session("blocked"), { audit: filler(5) });
    expect(authorizationHistory(data, data.proposals[0])).toBe("not_recorded");
    const steps = derive(data).steps;
    expect(steps[0]).toMatchObject({ label: "V1 superseded", state: "skipped", detail: "No authorization in the audit trail" });
    expect(steps[0].label).not.toMatch(/authorized/);
    expect(steps[1].state).toBe("done");
  });

  it("uses neutral wording when the audit window is full and shows no authorization", () => {
    const data = patch(session("blocked"), { audit: filler(30) });
    expect(authorizationHistory(data, data.proposals[0])).toBe("unknown");
    expect(derive(data).steps[0]).toMatchObject({ label: "V1 superseded", state: "skipped", detail: "Authorization history not available in this view" });
  });

  it("still finds the authorization when it is inside a full audit window", () => {
    const data = patch(session("blocked"), { audit: [...filler(29), v1Authorized] });
    expect(authorizationHistory(data, data.proposals[0])).toBe("authorized");
  });

  it("trusts a persisted authorized status even when the audit window lost the event", () => {
    const data = session("blocked");
    const p = { ...data.proposals[0], status: "authorized" } as never;
    expect(authorizationHistory(patch(data, { audit: filler(30) }), p)).toBe("authorized");
  });

  it("shows an open first proposal as awaiting authorization", () => {
    const data = patch(session("blocked"), { proposals: [{ ...session("blocked").proposals[0], status: "open" }], session: { ...session("blocked").session, currentProposalId: "p1" }, decisions: [], audit: [], disputes: [] });
    const v = derive(data);
    expect(v.steps[0]).toMatchObject({ label: "V1 awaiting authorization", state: "current" });
    expect(v.phase).toBe("evaluating");
  });
});

describe('limitGap', () => {
  const a = (cents: number) => pol('A', 1, cents) as never;
  const b = (cents: number) => pol('B', 1, cents) as never;

  it('is positive by exactly how far a payer is over its maximum', () => {
    expect(limitGap(-1_000_000, a(900_000))).toBe(100_000);
  });

  it('is zero at the limit and negative with margin to spare', () => {
    expect(limitGap(-1_000_000, a(1_000_000))).toBe(0);
    expect(limitGap(-800_000, a(900_000))).toBe(-100_000);
  });

  it('is positive by how far a receiver is below its minimum', () => {
    expect(limitGap(300_000, b(400_000))).toBe(100_000);
    expect(limitGap(500_000, b(400_000))).toBe(-100_000);
  });

  it('is undefined when no limit has been granted', () => {
    expect(limitGap(-1_000_000, undefined)).toBeUndefined();
    expect(limitGap(500_000, { company: 'B', version: 1 } as never)).toBeUndefined();
  });
});
