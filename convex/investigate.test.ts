/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";

/*
 * Database-backed tests of the tool-using investigator. The "provider" is a mocked fetch that returns responses shaped
 * like Gemini generateContent function calls. These tests prove the trusted server side (authorization, session scope,
 * read-only tools, persistence, evidence freshness, financial invariants). They do not prove live model behavior.
 */
const modules = import.meta.glob("./**/*.ts");
const setupKey = "long-admin-secret-for-integration-tests";
const tokens = { A: "valid-test-secret-company-A-2026", B: "valid-test-secret-company-B-2026", C: "valid-test-secret-company-C-2026" };
const otherTokens = { A: "other-session-secret-company-A-26", B: "other-session-secret-company-B-26", C: "other-session-secret-company-C-26" };
const GEMINI_KEY = "fake-gemini-key-must-never-leak";
const REF = ["INV-003:L1", "DEL-003:L1"];

type Call = { id?: string; name: string; args: unknown };
const modelReply = (calls: Call[], sig = "c2lnbmF0dXJl") => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: calls.map((c, i) => ({ functionCall: { ...(c.id ? { id: c.id } : {}), name: c.name, args: c.args }, ...(i === 0 ? { thoughtSignature: sig } : {}) })) } }] }), { status: 200 });
const read = (name: string, args: Record<string, unknown> = { obligationCode: "O3" }, id?: string): Call => ({ name, args, ...(id ? { id } : {}) });
const finding = (cents = 200000, refs = REF): Call => ({ name: "submitFinding", args: { lineId: "L1", claimedCents: cents, rationale: "Billed quantity exceeds received quantity.", citedRefs: refs } });
const noFinding = (reason = "No supported shortfall."): Call => ({ name: "submitNoFinding", args: { reason } });
const happyScript = (): Array<Call[]> => [[read("getObligation", { obligationCode: "O3" }, "c1")], [read("getInvoiceLines", { obligationCode: "O3", lineId: "L1" }, "c2")], [read("getDeliveryRecords", { obligationCode: "O3", lineId: "L1" }, "c3")], [finding()]];

describe("tool-using investigator (mocked provider, real Convex functions)", () => {
  let bodies: string[];
  beforeEach(() => {
    vi.stubEnv("CONTRAOS_SETUP_KEY", setupKey);
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", GEMINI_KEY);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    bodies = [];
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  /** Mocked Gemini: each request is answered by the next script step; a step may also run a side effect first. */
  const mockProvider = (steps: Array<Call[] | Response | ((body: string) => Promise<Response | Call[]> | Response | Call[])>) => {
    let i = 0;
    const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body); bodies.push(body);
      const step = steps[Math.min(i++, steps.length - 1)];
      const out = typeof step === "function" ? await step(body) : step;
      return Array.isArray(out) ? modelReply(out) : out.clone();
    });
    vi.stubGlobal("fetch", f);
    return f;
  };

  async function world() {
    const t = convexTest(schema, modules);
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T05:30:00Z"));
    const a = await t.mutation(api.workflow.initialize, { setupKey, slug: "demo", officerA: tokens.A, officerB: tokens.B, officerC: tokens.C });
    const b = await t.mutation(api.workflow.initialize, { setupKey, slug: "other-session", officerA: otherTokens.A, officerB: otherTokens.B, officerC: otherTokens.C });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers(); // the adapter's retry sleep must use real timers
    vi.setSystemTime(new Date("2026-10-25T05:31:00Z"));
    const state = (slug = "demo") => t.query(api.workflow.getSession, { slug });
    const runs = () => t.query(api.investigate.runsForSession, { sessionId: a.sessionId });
    const investigate = (token = tokens.C) => t.action(api.investigate.investigateWithTools, { sessionId: a.sessionId, officerToken: token });
    const patch = (table: "deliveries" | "invoiceLines" | "obligations", where: (r: any) => boolean, fields: Record<string, unknown>) =>
      t.run(async ctx => { for (const r of await ctx.db.query(table).collect()) if (r.sessionId === a.sessionId && where(r)) await ctx.db.patch(r._id, fields as never); });
    // Everything financial a model must never be able to change.
    const financial = async () => {
      const s = (await state())!;
      const raw = await t.run(async ctx => ({ policies: await ctx.db.query("policies").collect(), disputes: await ctx.db.query("disputes").collect(), decisions: await ctx.db.query("agentDecisions").collect(), proposals: await ctx.db.query("proposals").collect(), obligations: await ctx.db.query("obligations").collect(), sessions: await ctx.db.query("sessions").collect(), audit: await ctx.db.query("auditEvents").collect() }));
      return JSON.stringify({ s: s.session, raw });
    };
    return { t, a, b, state, runs, investigate, patch, financial };
  }
  const kinds = (events: Array<{ kind: string; toolName?: string }>) => events.map(e => e.kind + (e.toolName ? ":" + e.toolName : ""));

  it("A. persists a causal run, a SUPPORTED $2,000 candidate labelled tool_using_gemini, and changes nothing financial", async () => {
    const w = await world();
    const before = await w.financial();
    const f = mockProvider(happyScript().map((calls, i) => (i === 3 ? calls : calls)));
    const res = await w.investigate();
    expect(res).toMatchObject({ status: "CANDIDATE_SAVED", verdict: "SUPPORTED" });
    expect(f).toHaveBeenCalledTimes(4);
    expect(JSON.parse(bodies[0]).contents).toHaveLength(1); // the first request is the task alone
    const { runs, events } = await w.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ mode: "tool_using_gemini", provider: "gemini", status: "completed", turns: 4 });
    expect(kinds(events.sort((x, y) => x.seq - y.seq))).toEqual([
      "tool_requested:getObligation", "tool_result:getObligation", "tool_requested:getInvoiceLines", "tool_result:getInvoiceLines",
      "tool_requested:getDeliveryRecords", "tool_result:getDeliveryRecords", "candidate_proposed:submitFinding", "validation"]);
    expect(events.find(e => e.kind === "tool_result" && e.toolName === "getDeliveryRecords")?.refs).toEqual(["DEL-003:L1"]);
    expect(events.at(-1)).toMatchObject({ kind: "validation", reason: "SUPPORTED" });
    const s = (await w.state())!;
    const c = s.candidates.at(-1)!;
    expect(c).toMatchObject({ status: "SUPPORTED", computedCents: 200000, claimedCents: 200000, mode: "tool_using_gemini", modelName: "gemini-3.5-flash-lite" });
    expect(c.runId).toBe(runs[0].id);
    // The saved candidate is tied to the right session, run, provider, evidence version and source references.
    const stored = await w.t.run(async ctx => ({ run: await ctx.db.get(runs[0].id), candidate: await ctx.db.get(c._id) }));
    expect(stored.run).toMatchObject({ sessionId: w.a.sessionId, provider: "gemini", model: "gemini-3.5-flash-lite", evidenceVersion: s.session.evidenceVersion, candidateId: c._id });
    expect(stored.candidate).toMatchObject({ sessionId: w.a.sessionId, runId: runs[0].id, sourceRefs: REF, obligationCode: "O3", lineId: "L1" });
    // the model really received the server's rows, via function responses that echo the earlier model turns
    expect(bodies[2]).toContain("\"quantityBilled\":100"); expect(bodies[3]).toContain("\"quantityReceived\":60");
    expect(bodies[3]).toContain("c2lnbmF0dXJl"); // thought signature echoed back
    // nothing but the candidate table (and run history) changed
    expect(await w.financial()).toBe(before);
    expect(bodies.join("")).not.toContain(tokens.C); expect(bodies.join("")).not.toContain(GEMINI_KEY);
  });

  it("requires Company C's officer BEFORE any provider call (wrong company, wrong secret, short secret, other session's secret)", async () => {
    const w = await world();
    const f = mockProvider(happyScript());
    for (const token of [tokens.A, tokens.B, "wrong-secret-wrong-secret-wrong", "short", otherTokens.C]) {
      await expect(w.investigate(token)).rejects.toThrow(/C_OFFICER_REQUIRED/);
    }
    expect(f).not.toHaveBeenCalled();
    expect((await w.runs()).runs).toHaveLength(0);
    // and C of the OTHER session cannot start a run on this one, while the real C can
    await expect(w.t.action(api.investigate.investigateWithTools, { sessionId: w.b.sessionId, officerToken: tokens.C })).rejects.toThrow(/C_OFFICER_REQUIRED/);
    expect(f).not.toHaveBeenCalled();
  });

  it("B. full delivery: the model's justified no-finding is recorded; no candidate; a wrong claim is still UNSUPPORTED", async () => {
    const w = await world();
    await w.patch("deliveries", r => r.lineId === "L1", { received: 100 });
    mockProvider([[read("getInvoiceLines")], [read("getDeliveryRecords")], [noFinding("All 100 billed units were received.")]]);
    expect(await w.investigate()).toMatchObject({ status: "NO_FINDING" });
    expect((await w.runs()).runs[0].status).toBe("no_finding");
    expect((await w.state())!.candidates).toHaveLength(0);
    mockProvider([[read("getInvoiceLines")], [read("getDeliveryRecords")], [finding(200000)]]);
    expect(await w.investigate()).toMatchObject({ status: "NO_SUPPORTED_CANDIDATE", verdict: "UNSUPPORTED" });
    const wrong = (await w.state())!.candidates.at(-1)!;
    expect(wrong.status).toBe("UNSUPPORTED"); expect(wrong.computedCents ?? null).toBeNull();
  });

  it("C. incomplete delivery period: no-finding is accepted; a claimed shortfall is INSUFFICIENT_EVIDENCE, never supported", async () => {
    const w = await world();
    await w.patch("deliveries", r => r.lineId === "L1", { periodComplete: false });
    mockProvider([[read("getInvoiceLines")], [read("getDeliveryRecords")], [noFinding("Delivery period is not complete.")]]);
    expect(await w.investigate()).toMatchObject({ status: "NO_FINDING" });
    mockProvider([[read("getInvoiceLines")], [read("getDeliveryRecords")], [finding(200000)]]);
    expect(await w.investigate()).toMatchObject({ status: "NO_SUPPORTED_CANDIDATE", verdict: "INSUFFICIENT_EVIDENCE" });
    expect((await w.state())!.candidates.every(c => c.status !== "SUPPORTED")).toBe(true);
  });

  it("D. cross-session and malicious requests never reach data outside the run's own session", async () => {
    const w = await world();
    await w.t.run(async ctx => { for (const d of await ctx.db.query("deliveries").collect()) if (d.sessionId === w.b.sessionId) await ctx.db.patch(d._id, { received: 10 }); });
    mockProvider([
      [{ name: "getDeliveryRecords", args: { obligationCode: "O3", sessionId: w.b.sessionId } }, { name: "fileDispute", args: { lineId: "L1" } }],
      [read("getDeliveryRecords")], [read("getInvoiceLines")], [finding()]]);
    const res = await w.investigate();
    expect(res).toMatchObject({ status: "CANDIDATE_SAVED" });
    const { events } = await w.runs();
    expect(events.filter(e => e.allowed === false).map(e => e.reason)).toEqual(["UNEXPECTED_ARGUMENT", "UNKNOWN_TOOL"]);
    expect(JSON.stringify(events)).not.toContain(String(w.b.sessionId));
    expect(bodies.join("")).not.toContain("\"quantityReceived\":10"); // the other session's rows were never served
    expect(bodies.join("")).toContain("\"quantityReceived\":60");
  });

  it("the read tool is scoped by the run row and refuses a finished or unknown run", async () => {
    const w = await world();
    mockProvider(happyScript());
    const done = await w.investigate();
    const closed = await w.t.query(internal.investigate.readEvidenceTool, { runId: done.runId!, name: "getObligation", obligationCode: "O3" });
    expect(closed).toEqual({ ok: false, reason: "RUN_NOT_ACTIVE" });
    await expect(w.t.mutation(internal.investigate.finalizeRun, { runId: done.runId!, outcome: { kind: "stopped", stopReason: "X" }, turns: 0, toolRequests: 0 })).rejects.toThrow(/RUN_NOT_ACTIVE/);
  });

  it("evidence changing during the run is detected by the record fingerprint even when evidenceVersion does not change", async () => {
    const w = await world();
    const version = (await w.state())!.session.evidenceVersion;
    // The delivery record is edited after the model has read it but before it submits.
    mockProvider([[read("getInvoiceLines")], [read("getDeliveryRecords")], async () => { await w.patch("deliveries", r => r.lineId === "L1", { received: 100 }); return [finding()]; }]);
    const res = await w.investigate();
    expect(res).toMatchObject({ status: "STALE_EVIDENCE", stopReason: "EVIDENCE_CHANGED" });
    const s = (await w.state())!;
    expect(s.session.evidenceVersion).toBe(version); // the version alone would have missed this
    expect(s.candidates.at(-1)!.status).toBe("STALE_EVIDENCE"); expect(s.candidates.at(-1)!.computedCents ?? null).toBeNull();
    expect(s.candidates.every(c => c.status !== "SUPPORTED")).toBe(true);
    const { runs, events } = await w.runs();
    expect(runs[0]).toMatchObject({ status: "stale", stopReason: "EVIDENCE_CHANGED" });
    expect(events.at(-1)).toMatchObject({ kind: "validation", reason: "STALE_EVIDENCE" });
  });

  it("evidence changing between two tool calls stops the run at the next read; an amount-on-hold change is also caught", async () => {
    const w = await world();
    mockProvider([[read("getInvoiceLines")], async () => { await w.patch("invoiceLines", r => r.lineId === "L1", { unitPriceCents: 9000 }); return [read("getDeliveryRecords")]; }, [finding()]]);
    expect(await w.investigate()).toMatchObject({ status: "STALE_EVIDENCE", stopReason: "EVIDENCE_CHANGED" });
    expect((await w.state())!.candidates).toHaveLength(0);
    const w2 = await world();
    mockProvider([[read("getInvoiceLines")], [read("getDeliveryRecords")], async () => { await w2.patch("obligations", r => r.code === "O3", { disputedCents: 200000 }); return [noFinding()]; }]);
    expect(await w2.investigate()).toMatchObject({ status: "STALE_EVIDENCE" });
  });

  it("E. provider failures are explicit, bounded, recorded, and never substituted with another path", async () => {
    const w = await world();
    const cases: Array<[string, Response | (() => Response), string]> = [
      ["malformed JSON", new Response("not json"), "INVALID_OUTPUT"],
      ["HTTP 500", new Response("{}", { status: 500 }), "MODEL_ERROR"],
      ["no function call", new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "It is a $2,000 shortfall" }] } }] })), "NO_FUNCTION_CALL"],
    ];
    for (const [, response, reason] of cases) {
      const f = mockProvider([response]);
      const res = await w.investigate();
      expect(res).toMatchObject({ status: "STOPPED", stopReason: reason });
      expect(f).toHaveBeenCalledTimes(1);
    }
    const { runs, events } = await w.runs();
    expect(runs.every(r => r.status === "failed")).toBe(true);
    expect(events.filter(e => e.kind === "stopped").map(e => e.reason).sort()).toEqual(["INVALID_OUTPUT", "MODEL_ERROR", "NO_FUNCTION_CALL"]);
    const s = (await w.state())!;
    expect(s.candidates).toHaveLength(0); // no manual fallback, no single-pass result, nothing fabricated
  });

  it("E. rate limit (one bounded retry) and timeout", async () => {
    const w = await world();
    const limited = mockProvider([new Response("{}", { status: 429 })]);
    expect(await w.investigate()).toMatchObject({ status: "STOPPED", stopReason: "RATE_LIMITED" });
    expect(limited).toHaveBeenCalledTimes(2);
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }));
    expect(await w.investigate()).toMatchObject({ status: "STOPPED", stopReason: "TIMEOUT" });
    expect((await w.runs()).runs.map(r => r.stopReason).sort()).toEqual(["RATE_LIMITED", "TIMEOUT"]);
  }, 20000);

  it("E. budget exhaustion: endless distinct reads stop at the turn limit and persist no candidate", async () => {
    const w = await world();
    let n = 0;
    const f = vi.fn(async () => modelReply([read("getInvoiceLines", { obligationCode: "O3", lineId: "L" + (++n) })]));
    vi.stubGlobal("fetch", f);
    const res = await w.investigate();
    expect(res).toMatchObject({ status: "STOPPED", stopReason: expect.stringMatching(/TURN_LIMIT_EXCEEDED|TOOL_BUDGET_EXHAUSTED|REPEATED_INVALID_REQUESTS/) });
    expect(f.mock.calls.length).toBeLessThanOrEqual(6);
    expect((await w.state())!.candidates).toHaveLength(0);
  });

  it("E. an interrupted run is closed as failed, and a run abandoned mid-flight is later marked interrupted", async () => {
    const w = await world();
    // the run row disappears while the model is thinking: the next write/read refuses and the run ends as UNEXPECTED_ERROR
    mockProvider([[read("getInvoiceLines")], async () => { await w.t.run(async ctx => { for (const r of await ctx.db.query("investigationRuns").collect()) await ctx.db.delete(r._id); }); return [read("getDeliveryRecords")]; }]);
    expect(await w.investigate()).toMatchObject({ status: "STOPPED", stopReason: "UNEXPECTED_ERROR" });
    // an action that died: a 'running' row left behind blocks a new run for 5 minutes, then is marked interrupted
    const ids = await w.t.mutation(internal.investigate.beginRun, { sessionId: w.a.sessionId, provider: "gemini", model: "gemini-3.5-flash-lite" });
    mockProvider(happyScript());
    await expect(w.investigate()).rejects.toThrow(/RUN_IN_PROGRESS/);
    vi.setSystemTime(new Date("2026-10-25T05:40:00Z"));
    expect(await w.investigate()).toMatchObject({ status: "CANDIDATE_SAVED" });
    const { runs, events } = await w.runs();
    expect(runs.find(r => r.id === ids.runId)).toMatchObject({ status: "interrupted", stopReason: "ACTION_INTERRUPTED" });
    expect(events.some(e => e.runId === ids.runId && e.reason === "ACTION_INTERRUPTED")).toBe(true);
  });

  it("a key stored with a trailing carriage return no longer blocks the request (the live failure), and the header is clean", async () => {
    const w = await world();
    vi.stubEnv("GEMINI_API_KEY", GEMINI_KEY + String.fromCharCode(13));
    const headers: string[] = [];
    const strict = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const value = (init?.headers as Record<string, string>)["x-goog-api-key"];
      if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("Header x-goog-api-key has an invalid value");
      headers.push(value);
      return modelReply(headers.length === 1 ? [read("getInvoiceLines")] : headers.length === 2 ? [read("getDeliveryRecords")] : [finding()]);
    });
    vi.stubGlobal("fetch", strict);
    expect(await w.investigate()).toMatchObject({ status: "CANDIDATE_SAVED" });
    expect(headers).toEqual([GEMINI_KEY, GEMINI_KEY, GEMINI_KEY]);
  });

  it("a malformed key is refused with INVALID_CREDENTIAL before any run or request exists; the message never contains it", async () => {
    const w = await world();
    vi.stubEnv("GEMINI_API_KEY", "synthetic-SECRET-line-one" + String.fromCharCode(13, 10) + "synthetic-SECRET-line-two");
    const f = mockProvider(happyScript());
    const res = await w.investigate();
    expect(res).toMatchObject({ status: "INVALID_CREDENTIAL" });
    expect(JSON.stringify(res)).not.toMatch(/SECRET|synthetic-/);
    expect(f).not.toHaveBeenCalled();
    expect((await w.runs()).runs).toHaveLength(0);
  });

  it("selected provider and configuration are honest: Anthropic is not silently routed to the new workflow; missing key is explicit", async () => {
    const w = await world();
    const f = mockProvider(happyScript());
    vi.stubEnv("AI_PROVIDER", "anthropic"); vi.stubEnv("ANTHROPIC_API_KEY", "fake-anthropic-key");
    expect(await w.investigate()).toMatchObject({ status: "UNSUPPORTED_PROVIDER" });
    vi.stubEnv("AI_PROVIDER", "gemini"); vi.stubEnv("GEMINI_API_KEY", "");
    expect(await w.investigate()).toMatchObject({ status: "NOT_CONFIGURED" });
    expect(f).not.toHaveBeenCalled();
    expect((await w.runs()).runs).toHaveLength(0);
  });

  it("existing paths are labelled with how they ran (single-pass provider run, manual fallback)", async () => {
    const w = await world();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ candidates: [{ lineId: "L1", claimedCents: 200000, rationale: "x" }] }) }] } }] }))));
    await w.t.action(api.investigate.investigate, { sessionId: w.a.sessionId, officerToken: tokens.C });
    await w.t.mutation(api.investigate.manualCandidate, { sessionId: w.a.sessionId, officerToken: tokens.C });
    expect((await w.state())!.candidates.map(c => c.mode).sort()).toEqual(["manual_fallback", "single_pass_gemini"]);
  });

  it("provider-reported token usage is stored as numbers only and shown with the run", async () => {
    const w = await world();
    const withUsage = (calls: Call[], total: number) => new Response(JSON.stringify({ usageMetadata: { promptTokenCount: total - 10, candidatesTokenCount: 10, totalTokenCount: total }, candidates: [{ content: { role: "model", parts: calls.map(c => ({ functionCall: { name: c.name, args: c.args } })) } }] }));
    mockProvider([withUsage([read("getInvoiceLines")], 100), withUsage([read("getDeliveryRecords")], 200), withUsage([finding()], 300)]);
    await w.investigate();
    expect((await w.runs()).runs[0]).toMatchObject({ totalTokens: 600, outputTokens: 30, promptTokens: 570 });
  });

  it("documents created before run tracking (no mode, no runId) are still valid under the new schema", async () => {
    const w = await world();
    await w.t.run(async ctx => { await ctx.db.insert("evidenceCandidates", { sessionId: w.a.sessionId, obligationCode: "O3", lineId: "L1", claimedCents: 200000, status: "SUPPORTED", computedCents: 200000, rationale: "legacy", sourceRefs: REF, modelName: "gemini-3.5-flash-lite", createdAt: 1 }); });
    const s = (await w.state())!;
    expect(s.candidates).toHaveLength(1); expect(s.candidates[0].mode).toBeUndefined();
    expect((await w.runs()).runs).toHaveLength(0);
  });

  describe("independent review findings: regression tests", () => {
    const flood = async (w: Awaited<ReturnType<typeof world>>) => w.t.run(async ctx => {
      for (let i = 0; i < 49; i++) await ctx.db.insert("invoiceLines", { sessionId: w.a.sessionId, obligationCode: "O3", lineId: "L0", quantity: 0, unitPriceCents: 5000, sourceRef: "INV-003:L0" });
    });

    it("[MEDIUM #1] a truncated evidence snapshot is refused BEFORE any provider request (no run, no candidate)", async () => {
      const w = await world();
      await flood(w);
      const f = mockProvider(happyScript());
      await expect(w.investigate()).rejects.toThrow(/EVIDENCE_TOO_LARGE/);
      expect(f).not.toHaveBeenCalled();
      expect((await w.runs()).runs).toHaveLength(0);
      expect((await w.state())!.candidates).toHaveLength(0);
    });

    it("[MEDIUM #1] evidence that outgrows the snapshot DURING a run is never validated as complete", async () => {
      const w = await world();
      mockProvider([[read("getInvoiceLines")], [read("getDeliveryRecords")], async () => { await flood(w); return [finding()]; }]);
      const res = await w.investigate();
      expect(res).toMatchObject({ status: "STOPPED", stopReason: "EVIDENCE_TOO_LARGE" });
      const s = (await w.state())!;
      expect(s.candidates.every(c => c.status !== "SUPPORTED")).toBe(true);
      expect((await w.runs()).runs[0]).toMatchObject({ status: "failed", stopReason: "EVIDENCE_TOO_LARGE" });
    });

    it("[MEDIUM #4] finalization checks citations against the AUTHORITATIVE records, independent of the orchestrator", async () => {
      const w = await world();
      for (const [label, citedRefs] of [["empty", [] as string[]], ["other line", ["INV-003:L2", "DEL-003:L2"]], ["invoice only", ["INV-003:L1"]], ["invented", ["INV-999:L1", "DEL-999:L1"]]] as const) {
        const { runId } = await w.t.mutation(internal.investigate.beginRun, { sessionId: w.a.sessionId, provider: "gemini", model: "gemini-3.5-flash-lite" });
        const closed = await w.t.mutation(internal.investigate.finalizeRun, { runId, outcome: { kind: "finding", lineId: "L1", claimedCents: 200000, rationale: label, citedRefs: [...citedRefs] }, turns: 2, toolRequests: 3 });
        expect(closed, label).toMatchObject({ status: "NO_SUPPORTED_CANDIDATE", verdict: "UNSUPPORTED" });
      }
      const cands = (await w.state())!.candidates;
      expect(cands).toHaveLength(4);
      expect(cands.every(c => c.status === "UNSUPPORTED")).toBe(true);
      // and a correct citation set is still supported by the same path
      const { runId } = await w.t.mutation(internal.investigate.beginRun, { sessionId: w.a.sessionId, provider: "gemini", model: "gemini-3.5-flash-lite" });
      expect(await w.t.mutation(internal.investigate.finalizeRun, { runId, outcome: { kind: "finding", lineId: "L1", claimedCents: 200000, rationale: "ok", citedRefs: REF }, turns: 2, toolRequests: 3 })).toMatchObject({ status: "CANDIDATE_SAVED", verdict: "SUPPORTED" });
    });

    it("[MEDIUM #3] provider diagnostics never reach production logs: off by default, shapes only when tracing, never the key or provider text", async () => {
      const w = await world();
      const echo = () => new Response(JSON.stringify({ error: { message: "Rejected request with credential " + GEMINI_KEY } }), { status: 400 });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      mockProvider([echo()]);
      expect(await w.investigate()).toMatchObject({ status: "STOPPED", stopReason: "MODEL_ERROR" });
      expect(log).not.toHaveBeenCalled(); // default: no provider-exchange logging at all
      vi.stubEnv("INVESTIGATOR_TRACE", "1");
      mockProvider([echo()]);
      const again = await w.investigate();
      const logged = log.mock.calls.flat().join(" ");
      expect(logged).toContain("[investigator]"); // tracing is available when an operator opts in
      expect(logged).not.toContain(GEMINI_KEY); expect(logged).not.toMatch(/Rejected request|credential/);
      expect(JSON.stringify(again)).not.toContain(GEMINI_KEY);
      // a SUCCESSFUL response whose provider-controlled fields echo the credential must not reach the trace either
      log.mockClear();
      mockProvider([new Response(JSON.stringify({ candidates: [{ finishReason: GEMINI_KEY, content: { role: "model", parts: [{ functionCall: { id: GEMINI_KEY, name: GEMINI_KEY, args: { [GEMINI_KEY]: 1 } } }] } }] }))]);
      await w.investigate();
      const traced = log.mock.calls.flat().join(" ");
      expect(traced).toContain("[investigator]"); expect(traced).not.toContain(GEMINI_KEY);
      log.mockRestore();
    });
  });

  it("the public run history exposes no credentials, hashes, fingerprints, prompts or provider content", async () => {
    const w = await world();
    mockProvider(happyScript()); await w.investigate();
    const dump = JSON.stringify(await w.runs());
    for (const secret of [tokens.A, tokens.B, tokens.C, GEMINI_KEY, "officerTokenHash", "fingerprint", "thoughtSignature", "c2lnbmF0dXJl", "systemInstruction"]) expect(dump).not.toContain(secret);
    const storedRuns = JSON.stringify(await w.t.run(async ctx => ({ r: await ctx.db.query("investigationRuns").collect(), e: await ctx.db.query("investigationEvents").collect() })));
    for (const secret of [tokens.C, GEMINI_KEY, "c2lnbmF0dXJl", "systemInstruction", "Investigate obligation"]) expect(storedRuns).not.toContain(secret);
  });
});
