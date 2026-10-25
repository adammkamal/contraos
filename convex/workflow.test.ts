import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const setupKey = "long-admin-secret-for-integration-tests";
const tokens = {
  A: "valid-test-secret-company-A-2026",
  B: "valid-test-secret-company-B-2026",
  C: "valid-test-secret-company-C-2026",
};

describe("ContraOS live-state authorization invariants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T05:30:00Z"));
    vi.stubEnv("CONTRAOS_SETUP_KEY", setupKey);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function scenario() {
    const t = convexTest(schema, modules);
    const state = () => t.query(api.workflow.getSession, { slug: "demo" });
    async function seed() {
      const ids = await t.mutation(api.workflow.initialize, {
        setupKey, slug: "demo",
        officerA: tokens.A, officerB: tokens.B, officerC: tokens.C,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      return ids;
    }
    async function grant(company: "A" | "B" | "C", dollars: number) {
      return t.mutation(api.workflow.grantPolicy, {
        sessionId: (await state())!.session.id,
        officerToken: tokens[company],
        ...(company === "A"
          ? { maxNetPayCents: dollars * 100 }
          : { minNetReceiveCents: dollars * 100 }),
      });
    }
    async function grantInitial() {
      await grant("A", 9000);
      await grant("B", 4000);
      await grant("C", 2000);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    }
    async function fileCDispute() {
      return t.mutation(api.workflow.fileDispute, {
        sessionId: (await state())!.session.id,
        officerToken: tokens.C,
        obligationCode: "O3", lineId: "L1", claimedCents: 200000,
      });
    }
    return { t, state, seed, grant, grantInitial, fileCDispute };
  }

  it("authorizes V1, supersedes it, blocks V2, then authorizes only after A officer amends", async () => {
    const { t, state, seed, grantInitial, grant, fileCDispute } = scenario();
    await seed();
    await grantInitial();
    let data = (await state())!;
    expect(data.proposals.find(p => p.version === 1)?.status).toBe("authorized");
    expect(data.decisions.filter(d => d.proposalId === data.session.currentProposalId).map(d => d.decision).sort()).toEqual(["accept", "accept", "accept"]);

    await fileCDispute();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    data = (await state())!;
    expect(data.proposals.find(p => p.version === 1)?.status).toBe("superseded");
    expect(data.proposals.find(p => p.version === 2)?.status).toBe("open");
    const v2Decisions = data.decisions.filter(d => d.proposalId === data.session.currentProposalId);
    expect(v2Decisions.find(d => d.company === "A")).toMatchObject({ decision: "escalate", reasons: ["PAYMENT_LIMIT_EXCEEDED"] });
    expect(v2Decisions.filter(d => d.company !== "A").every(d => d.decision === "accept")).toBe(true);

    await grant("A", 10000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    data = (await state())!;
    expect(data.proposals.find(p => p.version === 2)?.status).toBe("authorized");
    expect(data.decisions.find(d => d.proposalId === data.session.currentProposalId && d.company === "A")).toMatchObject({ policyVersion: 2, decision: "accept" });
  });

  it("invalidates an already-authorized proposal atomically when an officer tightens policy", async () => {
    const { t, state, seed, grantInitial, grant, fileCDispute } = scenario();
    await seed(); await grantInitial(); await fileCDispute();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await grant("A", 10000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await state())!.proposals.find(p => p.version === 2)?.status).toBe("authorized");

    // The policy write must revoke readiness before the queued agent runs.
    await grant("A", 9000);
    let data = (await state())!;
    expect(data.proposals.find(p => p.version === 2)?.status).toBe("open");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    data = (await state())!;
    expect(data.proposals.find(p => p.version === 2)?.status).toBe("open");
    expect(data.decisions.find(d => d.proposalId === data.session.currentProposalId && d.company === "A")).toMatchObject({
      decision: "escalate", reasons: ["PAYMENT_LIMIT_EXCEEDED"], policyVersion: 3,
    });
  });

  it("rejects duplicate disputes, unrelated actor, and superseded V1 decisions", async () => {
    const { t, state, seed, grantInitial, fileCDispute } = scenario();
    const ids = await seed(); await grantInitial();
    await expect(t.mutation(api.workflow.fileDispute, {
      sessionId: ids.sessionId, officerToken: tokens.B,
      obligationCode: "O3", lineId: "L1", claimedCents: 200000,
    })).rejects.toThrow("NOT_DEBTOR");
    await fileCDispute();
    await expect(fileCDispute()).rejects.toThrow("DUPLICATE_DISPUTE");
    const before = (await state())!;
    expect(before.obligations.find(o => o.code === "O3")?.disputedCents).toBe(200000);
    const late = await t.mutation(internal.workflow.agentDecide, {
      sessionId: ids.sessionId, proposalId: ids.proposalId, company: "B",
    });
    expect(late).toHaveProperty("ignored");
    const after = (await state())!;
    expect(after.obligations.find(o => o.code === "O3")?.disputedCents).toBe(200000);
    expect(after.proposals.find(p => p.version === 1)?.status).toBe("superseded");
  });
});
