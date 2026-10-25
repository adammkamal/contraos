import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { validateEvidence } from "./lib/engine";
import { requestInvestigation, resolveProviderConfig } from "./lib/aiProviders";
import { ALL_TOOLS, geminiTurn } from "./lib/geminiTools";
import { orchestrate, type EventInput, type ReadResult } from "./lib/investigator";

/** Read-only model investigator: never authorizes anything, even if prompted to. */
export const evidenceForAgent = internalQuery({
  args: { sessionId: v.id("sessions"), officerToken: v.string() },
  handler: async (ctx, { sessionId, officerToken }) => {
    // Verify that the caller is Company C's officer before releasing data
    // to a provider-backed investigation. No credentials are logged or exported.
    if (officerToken.length < 16) throw new Error("C_OFFICER_REQUIRED");
    const hashes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(officerToken));
    const secretHash = [...new Uint8Array(hashes)].map(b => b.toString(16).padStart(2, "0")).join("");
    const companies = await ctx.db.query("companies").withIndex("by_session", q => q.eq("sessionId", sessionId)).collect();
    if (!companies.some(c => c.code === "C" && c.officerTokenHash === secretHash)) throw new Error("C_OFFICER_REQUIRED");
    const invoices = await ctx.db.query("invoiceLines").withIndex("by_obligation", q => q.eq("sessionId", sessionId).eq("obligationCode", "O3")).collect();
    const deliveries = await ctx.db.query("deliveries").withIndex("by_obligation", q => q.eq("sessionId", sessionId).eq("obligationCode", "O3")).collect();
    return { invoices: invoices.map(i => ({ lineId: i.lineId, qtyBilled: i.quantity, unitPriceCents: i.unitPriceCents, sourceRef: i.sourceRef })),
      deliveries: deliveries.map(d => ({ lineId: d.lineId, qtyReceived: d.received, periodComplete: d.periodComplete, sourceRef: d.sourceRef })) };
  }
});
export const saveCandidate = internalMutation({
  args: { sessionId: v.id("sessions"), lineId: v.string(), claimedCents: v.number(), rationale: v.string(), modelName: v.string(), mode: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const invoices = await ctx.db.query("invoiceLines").withIndex("by_obligation", q => q.eq("sessionId", args.sessionId).eq("obligationCode", "O3").eq("lineId", args.lineId)).collect();
    const deliveries = await ctx.db.query("deliveries").withIndex("by_obligation", q => q.eq("sessionId", args.sessionId).eq("obligationCode", "O3").eq("lineId", args.lineId)).collect();
    const verdict = validateEvidence(invoices, deliveries, args.claimedCents);
    const id = await ctx.db.insert("evidenceCandidates", { sessionId: args.sessionId, obligationCode: "O3", lineId: args.lineId,
      claimedCents: args.claimedCents, status: verdict.status, computedCents: verdict.cents, rationale: args.rationale.slice(0, 500),
      sourceRefs: [...invoices, ...deliveries].map(x => x.sourceRef), modelName: args.modelName, createdAt: Date.now(), mode: args.mode });
    return { candidateId: id, ...verdict };
  }
});
export const investigate = action({
  args: { sessionId: v.id("sessions"), officerToken: v.string() },
  handler: async (ctx, { sessionId, officerToken }): Promise<{status: string; candidates?: number; message?: string}> => {
    // Company C credential is verified by an internal query BEFORE any provider request.
    const evidence = await ctx.runQuery(internal.investigate.evidenceForAgent, { sessionId, officerToken });
    const config = resolveProviderConfig(process.env);
    if (!config.settings) return { status: config.error || "NOT_CONFIGURED", message: config.message };
    const result = await requestInvestigation(config.settings, evidence);
    if (result.status !== "OK") return result;
    let supported = 0;
    for (const candidate of result.candidates) {
      const verified = await ctx.runMutation(internal.investigate.saveCandidate, {
        sessionId, ...candidate, modelName: config.settings.model, mode: "single_pass_" + config.settings.provider
      });
      if (verified.status === "SUPPORTED") supported++;
    }
    return {
      status: supported ? "CANDIDATES_SAVED" : "NO_SUPPORTED_CANDIDATES",
      candidates: supported,
      message: supported ? undefined : "No evidence-supported model suggestion"
    };
  }
});
export const manualCandidate = mutation({
  args: { sessionId: v.id("sessions"), officerToken: v.string() },
  handler: async (ctx, { sessionId, officerToken }) => {
    // A demo-only fallback must still be initiated by an authorized C officer.
    const companies = await ctx.db.query("companies").withIndex("by_session", q => q.eq("sessionId", sessionId)).collect();
    const hashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(officerToken));
    const hash = [...new Uint8Array(hashBytes)].map(b => b.toString(16).padStart(2, "0")).join("");
    if (!companies.some(c => c.code === "C" && c.officerTokenHash === hash)) throw new Error("C_OFFICER_REQUIRED");
    const invoices = await ctx.db.query("invoiceLines").withIndex("by_obligation", q => q.eq("sessionId", sessionId).eq("obligationCode", "O3").eq("lineId", "L1")).collect();
    const deliveries = await ctx.db.query("deliveries").withIndex("by_obligation", q => q.eq("sessionId", sessionId).eq("obligationCode", "O3").eq("lineId", "L1")).collect();
    const verdict = validateEvidence(invoices, deliveries, 200000);
    if (verdict.status !== "SUPPORTED") throw new Error("MANUAL_EVIDENCE_" + verdict.status);
    return await ctx.db.insert("evidenceCandidates", { sessionId, obligationCode: "O3", lineId: "L1", claimedCents: 200000,
      computedCents: verdict.cents, status: verdict.status, rationale: "Manually verified example: 100 invoiced, 60 received, $50/unit",
      sourceRefs: [...invoices, ...deliveries].map(x => x.sourceRef), modelName: "MANUAL_FALLBACK", createdAt: Date.now(), mode: "manual_fallback" });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Tool-using investigation. The model requests read-only tools; this module is the trusted execution boundary.
// Session scope comes from the run row (never from model arguments), tools only read, and a finding is persisted
// only after the deterministic validator re-reads the authoritative records. Nothing here can touch policies,
// disputes, proposals, decisions or payments.
// ---------------------------------------------------------------------------------------------------------------
const TARGET_OBLIGATION = "O3";
const STALE_RUN_MS = 5 * 60 * 1000;
const MAX_ROWS = 20;
const MAX_EVIDENCE_ROWS = 50;
const TRACE_FINISH = new Set(["STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "OTHER", "MALFORMED_FUNCTION_CALL", "MISSING_THOUGHT_SIGNATURE", "FINISH_REASON_UNSPECIFIED"]);

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function isCompanyCOfficer(ctx: QueryCtx | MutationCtx, sessionId: Id<"sessions">, token: string): Promise<boolean> {
  if (token.length < 16) return false;
  const hash = await sha256(token);
  const companies = await ctx.db.query("companies").withIndex("by_session", q => q.eq("sessionId", sessionId)).take(10);
  return companies.some(c => c.code === "C" && c.officerTokenHash === hash);
}
/**
 * The records an O3 shortfall finding depends on, plus a fingerprint over their actual contents (ids, creation times,
 * quantities, prices, references, period state, amounts already on hold) and the session evidence version.
 * evidenceVersion alone is not trusted to notice every change, so the fingerprint compares the records themselves.
 */
async function loadEvidence(ctx: QueryCtx | MutationCtx, sessionId: Id<"sessions">) {
  const session = await ctx.db.get(sessionId);
  if (!session) throw new Error("SESSION_NOT_FOUND");
  const obligation = await ctx.db.query("obligations").withIndex("by_session_code", q => q.eq("sessionId", sessionId).eq("code", TARGET_OBLIGATION)).first();
  // One row more than the cap is read so an overflowing set is DETECTED, never silently validated as if it were complete.
  const invoicesRead = await ctx.db.query("invoiceLines").withIndex("by_obligation", q => q.eq("sessionId", sessionId).eq("obligationCode", TARGET_OBLIGATION)).take(MAX_EVIDENCE_ROWS + 1);
  const deliveriesRead = await ctx.db.query("deliveries").withIndex("by_obligation", q => q.eq("sessionId", sessionId).eq("obligationCode", TARGET_OBLIGATION)).take(MAX_EVIDENCE_ROWS + 1);
  const truncated = invoicesRead.length > MAX_EVIDENCE_ROWS || deliveriesRead.length > MAX_EVIDENCE_ROWS;
  const invoices = invoicesRead.slice(0, MAX_EVIDENCE_ROWS), deliveries = deliveriesRead.slice(0, MAX_EVIDENCE_ROWS);
  const snapshot = {
    evidenceVersion: session.evidenceVersion,
    obligation: obligation ? [obligation._id, obligation.amountCents, obligation.disputedCents] : null,
    invoices: invoices.map(i => JSON.stringify([i._id, i._creationTime, i.lineId, i.quantity, i.unitPriceCents, i.sourceRef])).sort(),
    deliveries: deliveries.map(d => JSON.stringify([d._id, d._creationTime, d.lineId, d.received, d.periodComplete, d.sourceRef])).sort()
  };
  return { session, obligation, invoices, deliveries, truncated, fingerprint: await sha256(JSON.stringify(snapshot)) };
}

/** Authorization gate: runs BEFORE any provider request. Only Company C's officer may start an investigation. */
export const assertCOfficer = internalQuery({
  args: { sessionId: v.id("sessions"), officerToken: v.string() },
  handler: async (ctx, { sessionId, officerToken }) => {
    if (!(await isCompanyCOfficer(ctx, sessionId, officerToken))) throw new Error("C_OFFICER_REQUIRED");
    return true;
  }
});

export const beginRun = internalMutation({
  args: { sessionId: v.id("sessions"), provider: v.string(), model: v.string() },
  handler: async (ctx, { sessionId, provider, model }) => {
    const now = Date.now();
    const recent = await ctx.db.query("investigationRuns").withIndex("by_session", q => q.eq("sessionId", sessionId)).order("desc").take(20);
    for (const run of recent) {
      if (run.status !== "running") continue;
      if (now - run.startedAt <= STALE_RUN_MS) throw new Error("RUN_IN_PROGRESS");
      // An action that died mid-run leaves no verdict; mark it so it is never mistaken for a result.
      await ctx.db.patch(run._id, { status: "interrupted", stopReason: "ACTION_INTERRUPTED", finishedAt: now });
      const last = await ctx.db.query("investigationEvents").withIndex("by_run", q => q.eq("runId", run._id)).order("desc").first();
      await ctx.db.insert("investigationEvents", { sessionId, runId: run._id, seq: (last?.seq ?? 0) + 1, kind: "stopped", reason: "ACTION_INTERRUPTED", at: now });
    }
    const evidence = await loadEvidence(ctx, sessionId);
    if (evidence.truncated) throw new Error("EVIDENCE_TOO_LARGE"); // refuse BEFORE any provider request
    const runId = await ctx.db.insert("investigationRuns", {
      sessionId, mode: "tool_using_gemini", provider, model, status: "running",
      evidenceVersion: evidence.session.evidenceVersion, fingerprint: evidence.fingerprint, turns: 0, toolRequests: 0, startedAt: now
    });
    return { runId, fingerprint: evidence.fingerprint };
  }
});

const eventFields = {
  kind: v.union(v.literal("tool_requested"), v.literal("tool_result"), v.literal("candidate_proposed"), v.literal("no_finding_proposed"), v.literal("validation"), v.literal("stopped")),
  toolName: v.optional(v.string()), args: v.optional(v.record(v.string(), v.union(v.string(), v.number()))),
  allowed: v.optional(v.boolean()), reason: v.optional(v.string()), refs: v.optional(v.array(v.string())), detail: v.optional(v.string())
};
export const recordEvent = internalMutation({
  args: { runId: v.id("investigationRuns"), seq: v.number(), ...eventFields },
  handler: async (ctx, { runId, seq, detail, refs, ...rest }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running") return null;
    await ctx.db.insert("investigationEvents", {
      sessionId: run.sessionId, runId, seq, ...rest, ...(refs ? { refs: refs.slice(0, 12).map(r => r.slice(0, 40)) } : {}),
      ...(detail ? { detail: detail.slice(0, 300) } : {}), at: Date.now()
    });
    return null;
  }
});

/** The ONLY data access the model gets: three read-only tools, scoped to the run's own session. */
export const readEvidenceTool = internalQuery({
  args: { runId: v.id("investigationRuns"), name: v.union(v.literal("getObligation"), v.literal("getInvoiceLines"), v.literal("getDeliveryRecords")), obligationCode: v.string(), lineId: v.optional(v.string()) },
  handler: async (ctx, { runId, name, obligationCode, lineId }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running") return { ok: false as const, reason: "RUN_NOT_ACTIVE" };
    const sessionId = run.sessionId; // server-controlled scope
    if (!/^O\d{1,2}$/.test(obligationCode) || (lineId !== undefined && !/^L\d{1,3}$/.test(lineId))) return { ok: false as const, reason: "INVALID_ARGUMENT" };
    const obligation = await ctx.db.query("obligations").withIndex("by_session_code", q => q.eq("sessionId", sessionId).eq("code", obligationCode)).first();
    if (!obligation) return { ok: false as const, reason: "UNKNOWN_OBLIGATION" };
    const { fingerprint, truncated } = await loadEvidence(ctx, sessionId);
    if (truncated) return { ok: false as const, reason: "EVIDENCE_TOO_LARGE" };
    if (name === "getObligation") {
      return { ok: true as const, fingerprint, refs: [] as string[],
        data: { code: obligation.code, debtor: obligation.debtor, creditor: obligation.creditor, amountCents: obligation.amountCents, disputedCents: obligation.disputedCents } };
    }
    if (name === "getInvoiceLines") {
      const rows = await ctx.db.query("invoiceLines").withIndex("by_obligation", q => lineId === undefined ? q.eq("sessionId", sessionId).eq("obligationCode", obligationCode) : q.eq("sessionId", sessionId).eq("obligationCode", obligationCode).eq("lineId", lineId)).take(MAX_ROWS + 1);
      const lines = rows.slice(0, MAX_ROWS).map(i => ({ lineId: i.lineId, quantityBilled: i.quantity, unitPriceCents: i.unitPriceCents, sourceRef: i.sourceRef }));
      return { ok: true as const, fingerprint, refs: lines.map(l => l.sourceRef), data: { obligationCode, lines, truncated: rows.length > MAX_ROWS } };
    }
    const rows = await ctx.db.query("deliveries").withIndex("by_obligation", q => lineId === undefined ? q.eq("sessionId", sessionId).eq("obligationCode", obligationCode) : q.eq("sessionId", sessionId).eq("obligationCode", obligationCode).eq("lineId", lineId)).take(MAX_ROWS + 1);
    const records = rows.slice(0, MAX_ROWS).map(d => ({ lineId: d.lineId, quantityReceived: d.received, periodComplete: d.periodComplete, sourceRef: d.sourceRef }));
    return { ok: true as const, fingerprint, refs: records.map(r => r.sourceRef), data: { obligationCode, records, truncated: rows.length > MAX_ROWS } };
  }
});

const outcomeV = v.union(
  v.object({ kind: v.literal("finding"), lineId: v.string(), claimedCents: v.number(), rationale: v.string(), citedRefs: v.array(v.string()) }),
  v.object({ kind: v.literal("no_finding"), reason: v.string() }),
  v.object({ kind: v.literal("stopped"), stopReason: v.string() })
);
/**
 * Closes a run. A model finding is re-validated against the AUTHORITATIVE records read now; if those records are no
 * longer the ones the run started from, the result is stored explicitly as STALE_EVIDENCE and never as supported.
 */
export const finalizeRun = internalMutation({
  args: { runId: v.id("investigationRuns"), outcome: outcomeV, turns: v.number(), toolRequests: v.number(), usage: v.optional(v.object({ promptTokens: v.number(), outputTokens: v.number(), thoughtsTokens: v.number(), totalTokens: v.number() })) },
  handler: async (ctx, { runId, outcome, turns, toolRequests, usage }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running") throw new Error("RUN_NOT_ACTIVE");
    const now = Date.now();
    const evidence = await loadEvidence(ctx, run.sessionId);
    const changed = evidence.fingerprint !== run.fingerprint;
    if (evidence.truncated && outcome.kind !== "stopped") {
      // The record set outgrew what can be validated exactly; never judge a finding against a partial snapshot.
      await ctx.db.insert("investigationEvents", { sessionId: run.sessionId, runId, seq: ((await ctx.db.query("investigationEvents").withIndex("by_run", q => q.eq("runId", runId)).order("desc").first())?.seq ?? 0) + 1, kind: "stopped", reason: "EVIDENCE_TOO_LARGE", at: now });
      await ctx.db.patch(runId, { status: "failed", turns, toolRequests, finishedAt: now, ...(usage ?? {}), stopReason: "EVIDENCE_TOO_LARGE" });
      return { status: "STOPPED", stopReason: "EVIDENCE_TOO_LARGE" };
    }
    const last = await ctx.db.query("investigationEvents").withIndex("by_run", q => q.eq("runId", runId)).order("desc").first();
    let seq = last?.seq ?? 0;
    const log = (e: { kind: "validation" | "stopped"; reason?: string; detail?: string; refs?: string[] }) =>
      ctx.db.insert("investigationEvents", { sessionId: run.sessionId, runId, seq: ++seq, ...e, at: now });
    const finish = (status: "completed" | "no_finding" | "stale" | "failed", extra: { stopReason?: string; candidateId?: Id<"evidenceCandidates"> } = {}) =>
      ctx.db.patch(runId, { status, turns, toolRequests, finishedAt: now, ...(usage ?? {}), ...extra });

    if (outcome.kind === "stopped") {
      const stale = outcome.stopReason === "EVIDENCE_CHANGED" || changed;
      await finish(stale ? "stale" : "failed", { stopReason: outcome.stopReason });
      return { status: stale ? "STALE_EVIDENCE" : "STOPPED", stopReason: outcome.stopReason };
    }
    if (outcome.kind === "no_finding") {
      if (changed) {
        await log({ kind: "validation", reason: "STALE_EVIDENCE", detail: "records changed after the run started" });
        await finish("stale", { stopReason: "EVIDENCE_CHANGED" });
        return { status: "STALE_EVIDENCE", stopReason: "EVIDENCE_CHANGED" };
      }
      await finish("no_finding");
      return { status: "NO_FINDING" };
    }
    const invoices = evidence.invoices.filter(i => i.lineId === outcome.lineId);
    const deliveries = evidence.deliveries.filter(d => d.lineId === outcome.lineId);
    const sourceRefs = [...invoices, ...deliveries].map(x => x.sourceRef);
    // The citations must be real references of THIS line's authoritative records, one invoice and one delivery at least.
    const cited = new Set(outcome.citedRefs);
    const citationsOk = cited.size > 0 && invoices.some(i => cited.has(i.sourceRef)) && deliveries.some(d => cited.has(d.sourceRef)) && [...cited].every(r => sourceRefs.includes(r));
    const verdict: { status: string; cents?: number; reason: string } = changed
      ? { status: "STALE_EVIDENCE", reason: "Records changed after the investigation started" }
      : !citationsOk
        ? { status: "UNSUPPORTED", reason: "Cited references do not match this line's invoice and delivery records" }
        : validateEvidence(invoices, deliveries, outcome.claimedCents);
    const candidateId = await ctx.db.insert("evidenceCandidates", {
      sessionId: run.sessionId, obligationCode: TARGET_OBLIGATION, lineId: outcome.lineId, claimedCents: outcome.claimedCents, status: verdict.status,
      computedCents: verdict.cents, rationale: outcome.rationale.slice(0, 500), sourceRefs, modelName: run.model, createdAt: now, mode: run.mode, runId
    });
    await log({ kind: "validation", reason: verdict.status, detail: verdict.reason, refs: sourceRefs });
    await finish(changed ? "stale" : "completed", { candidateId, ...(changed ? { stopReason: "EVIDENCE_CHANGED" } : {}) });
    return { status: changed ? "STALE_EVIDENCE" : verdict.status === "SUPPORTED" ? "CANDIDATE_SAVED" : "NO_SUPPORTED_CANDIDATE", candidateId, verdict: verdict.status, ...(changed ? { stopReason: "EVIDENCE_CHANGED" } : {}) };
  }
});

type ToolRunResult = { status: string; runId?: Id<"investigationRuns">; message?: string; stopReason?: string; candidateId?: Id<"evidenceCandidates">; verdict?: string };
/**
 * Model-directed investigation (Gemini function calling). Authorization precedes any provider request. If the tool-using
 * workflow cannot run or fails, the result says so: it never silently falls back to the single-pass or manual paths.
 */
export const investigateWithTools = action({
  args: { sessionId: v.id("sessions"), officerToken: v.string() },
  handler: async (ctx, { sessionId, officerToken }): Promise<ToolRunResult> => {
    await ctx.runQuery(internal.investigate.assertCOfficer, { sessionId, officerToken });
    const config = resolveProviderConfig(process.env);
    if (!config.settings) return { status: config.error || "NOT_CONFIGURED", message: config.message };
    if (config.settings.provider !== "gemini") {
      return { status: "UNSUPPORTED_PROVIDER", message: "Tool-using investigation is implemented for Gemini only. Use the single-pass investigator for " + config.settings.provider + "." };
    }
    const settings = { model: config.settings.model, apiKey: config.settings.apiKey };
    const { runId, fingerprint } = await ctx.runMutation(internal.investigate.beginRun, { sessionId, provider: "gemini", model: settings.model });
    let seq = 0;
    try {
      let turnNo = 0;
      const { outcome, turns, toolRequests, usage } = await orchestrate({
        startFingerprint: fingerprint,
        transport: async contents => {
          const t0 = Date.now();
          const r = await geminiTurn(settings, contents);
          // Off by default. When INVESTIGATOR_TRACE=1 an operator log records only the SHAPE of each exchange: codes, counts and
          // booleans. Never prompts, records, keys, signature values, or provider-supplied text.
          if (process.env.INVESTIGATOR_TRACE === "1") console.log("[investigator] " + JSON.stringify({
            run: runId, turn: ++turnNo, ms: Date.now() - t0, status: r.status, contentsInRequest: contents.length,
            ...(turnNo === 1 ? { firstRequestChars: JSON.stringify(contents).length } : {}),
            ...(r.status === "OK"
              // Every provider-controlled string is mapped to a fixed allowlisted value (or a constant); only counts and booleans pass through.
              ? { finishReason: r.finishReason !== undefined && TRACE_FINISH.has(r.finishReason) ? r.finishReason : "(other)", calls: r.calls.map(c => ({ name: ALL_TOOLS.includes(c.name) ? c.name : "(unknown)", hasId: c.id !== undefined, argCount: typeof c.args === "object" && c.args ? Object.keys(c.args).length : 0 })), partsWithSignature: r.content.parts.filter(p => p.thoughtSignature !== undefined).length, usage: r.usage }
              : {})
          }));
          return r;
        },
        record: async (e: EventInput) => { await ctx.runMutation(internal.investigate.recordEvent, { runId, seq: ++seq, ...e }); },
        read: async (name, args): Promise<ReadResult> => await ctx.runQuery(internal.investigate.readEvidenceTool, { runId, name, ...args })
      });
      const closed = await ctx.runMutation(internal.investigate.finalizeRun, { runId, outcome, turns, toolRequests, usage });
      return { runId, ...closed, message: outcome.kind === "stopped" ? "Investigation stopped: " + outcome.stopReason : undefined };
    } catch {
      // No error text is surfaced or stored: it could echo provider or record content.
      try { await ctx.runMutation(internal.investigate.finalizeRun, { runId, outcome: { kind: "stopped", stopReason: "UNEXPECTED_ERROR" }, turns: 0, toolRequests: 0 }); } catch { /* stays 'running'; the next start marks it interrupted */ }
      return { status: "STOPPED", runId, stopReason: "UNEXPECTED_ERROR", message: "Investigation stopped unexpectedly; no financial records were changed" };
    }
  }
});

/** Public, sanitized run history for the Investigation activity panel. Contains no prompts, credentials or provider content. */
export const runsForSession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const runs = await ctx.db.query("investigationRuns").withIndex("by_session", q => q.eq("sessionId", sessionId)).order("desc").take(5);
    const events = [];
    for (const run of runs) events.push(...await ctx.db.query("investigationEvents").withIndex("by_run", q => q.eq("runId", run._id)).take(60));
    return {
      runs: runs.map(r => ({ id: r._id, mode: r.mode, provider: r.provider, model: r.model, status: r.status, stopReason: r.stopReason, turns: r.turns, toolRequests: r.toolRequests, candidateId: r.candidateId, startedAt: r.startedAt, finishedAt: r.finishedAt, evidenceVersion: r.evidenceVersion, promptTokens: r.promptTokens, outputTokens: r.outputTokens, thoughtsTokens: r.thoughtsTokens, totalTokens: r.totalTokens })),
      events: events.map(e => ({ id: e._id, runId: e.runId, seq: e.seq, kind: e.kind, toolName: e.toolName, args: e.args, allowed: e.allowed, reason: e.reason, refs: e.refs, detail: e.detail, at: e.at }))
    };
  }
});
