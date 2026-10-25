/// <reference types="vite/client" />
// Feeds real getSession snapshots from the in-memory Convex backend through the frontend's derive().
// Hand-built fixtures can describe states the backend never produces; this cannot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { derive, disputeReadiness, formContext, type Session } from "../src/model";
import { explainRevision, nextStep } from "../src/story";

const modules = import.meta.glob("../convex/**/*.ts");
const setupKey = "long-admin-secret-for-integration-tests";
const tokens = { A: "valid-test-secret-company-A-2026", B: "valid-test-secret-company-B-2026", C: "valid-test-secret-company-C-2026" };

describe("frontend derive() against the real Convex lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T05:30:00Z"));
    vi.stubEnv("CONTRAOS_SETUP_KEY", setupKey);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("AI_PROVIDER", "gemini");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("never reads a state as approved unless the server stored authorized, across the whole flow", async () => {
    const t = convexTest(schema, modules);
    const snap = async () => (await t.query(api.workflow.getSession, { slug: "demo" }))! as Session;
    const settle = () => t.finishAllScheduledFunctions(vi.runAllTimers);
    const grant = async (company: "A" | "B" | "C", dollars: number) =>
      t.mutation(api.workflow.grantPolicy, { sessionId: (await snap()).session.id, officerToken: tokens[company], ...(company === "A" ? { maxNetPayCents: dollars * 100 } : { minNetReceiveCents: dollars * 100 }) });
    const seen: Array<{ label: string; data: Session }> = [];
    const note = async (label: string) => seen.push({ label, data: await snap() });

    await t.mutation(api.workflow.initialize, { setupKey, slug: "demo", officerA: tokens.A, officerB: tokens.B, officerC: tokens.C });
    await settle();
    await note("seeded, no policies");
    await grant("A", 9000); await grant("B", 4000); await grant("C", 2000);
    await note("policies granted, decisions pending");
    await settle();
    const v1 = derive(await snap());
    expect(v1.phase).toBe("authorized");
    expect(v1.steps[0]).toMatchObject({ label: "V1 authorized", state: "done" });
    await note("V1 authorized");

    await t.mutation(api.workflow.fileDispute, { sessionId: (await snap()).session.id, officerToken: tokens.C, obligationCode: "O3", lineId: "L1", claimedCents: 200000 });
    await note("dispute filed, V2 decisions pending");
    await settle();
    const blocked = derive(await snap());
    expect(blocked.phase).toBe("blocked");
    expect(blocked.escalated).toEqual(["A"]);
    expect(blocked.steps[0]).toMatchObject({ label: "V1 authorized" });
    // Real audit messages, not fixtures: the story and next step must match what the backend writes.
    const blockedStory = explainRevision(await snap(), blocked);
    expect(blockedStory.rows.map((r) => r.label)).toEqual(["Dispute", "Effect"]);
    expect(blockedStory.rows[0].text).toBe("Cedar (C) disputed $2,000 of O3 (invoice line L1). Its eligible obligation to Atlas (A) fell from $12,000 to $10,000.");
    expect(blockedStory.rows[1].text).toContain("Atlas (A) is owed $2,000 less, so its net payment rose from $8,000 to $10,000.");
    expect(nextStep(await snap(), blocked)).toMatchObject({ officer: "A" });
    await note("V2 blocked");

    await grant("A", 10000);
    await note("A amended, re-evaluation pending");
    const pending = derive(await snap());
    expect(pending.phase).toBe("reevaluating");
    expect(pending.stale).toEqual(["A"]);
    await settle();
    const v2 = derive(await snap());
    expect(v2.phase).toBe("authorized");
    expect(v2.consistent).toBe(true);
    expect(v2.amendments).toEqual([{ code: "A", from: 900_000, to: 1_000_000, kind: "max" }]);
    const authorizedStory = explainRevision(await snap(), v2);
    expect(authorizedStory.rows.map((r) => r.label)).toEqual(["Dispute", "Effect", "Limit", "Outcome"]);
    expect(authorizedStory.rows[2].text).toBe("Agent A escalated: Atlas (A)'s $10,000 payment exceeded its $9,000 limit. Its officer then raised the limit.");
    expect(authorizedStory.rows[2].detail).toBe("Atlas delegated limit: $9,000 (v1) → $10,000 (v2)");
    expect(authorizedStory.rows[3].text).toBe("Agent A re-evaluated under v2 and accepted; the server then authorized V2.");
    expect(authorizedStory.gaps).toEqual([]);
    await note("V2 authorized");

    // The backend reopens authorization in the same transaction as the policy change.
    await grant("A", 9000);
    const reopened = derive(await snap());
    expect((await snap()).proposals.find((p) => p.version === 2)?.status).toBe("open");
    expect(reopened.phase).toBe("reevaluating");
    expect(reopened.reopened).toBe(true);
    expect(reopened.stale).toEqual(["A"]);
    await note("V2 reopened by a policy change");
    await settle();
    const reblocked = derive(await snap());
    expect(reblocked.phase).toBe("blocked");
    expect(reblocked.reopened).toBe(true);
    expect(reblocked.escalated).toEqual(["A"]);
    const reblockedStory = explainRevision(await snap(), reblocked);
    expect(reblockedStory.rows.find((r) => r.label === "Limit")!.detail).toBe("Atlas delegated limit: $9,000 (v1) → $10,000 (v2) → $9,000 (v3)");
    expect(reblockedStory.rows.find((r) => r.label === "Outcome")!.text).toBe("A policy change withdrew V2's earlier authorization. Agent A escalated under v3.");
    await note("V2 blocked again");

    // Invariants over every real snapshot taken.
    for (const { label, data } of seen) {
      const v = derive(data);
      const status = data.proposals.find((p) => p._id === data.session.currentProposalId)?.status;
      expect({ label, authorizedPhase: v.phase === "authorized" }).toEqual({ label, authorizedPhase: status === "authorized" });
      if (v.phase === "authorized") expect({ label, consistent: v.consistent }).toEqual({ label, consistent: true });
      for (const d of v.decisions) if (d.reading.approved) expect(d.decision?.decision).toBe("accept");
    }
  });

  it("builds dispute readiness and company forms from the real seeded records", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.workflow.initialize, { setupKey, slug: "demo", officerA: tokens.A, officerB: tokens.B, officerC: tokens.C });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const data = (await t.query(api.workflow.getSession, { slug: "demo" }))! as Session;
    expect(disputeReadiness(data)).toEqual({ ok: true, cents: 200_000, reason: "" });
    expect(formContext(data.policies, "A")).toEqual({ company: "A", token: "", limit: "9000" });
  });
});
