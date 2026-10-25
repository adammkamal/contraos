import { action, internalMutation, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { validateEvidence } from "./lib/engine";
import { requestInvestigation, resolveProviderConfig } from "./lib/aiProviders";

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
  args: { sessionId: v.id("sessions"), lineId: v.string(), claimedCents: v.number(), rationale: v.string(), modelName: v.string() },
  handler: async (ctx, args) => {
    const invoices = await ctx.db.query("invoiceLines").withIndex("by_obligation", q => q.eq("sessionId", args.sessionId).eq("obligationCode", "O3").eq("lineId", args.lineId)).collect();
    const deliveries = await ctx.db.query("deliveries").withIndex("by_obligation", q => q.eq("sessionId", args.sessionId).eq("obligationCode", "O3").eq("lineId", args.lineId)).collect();
    const verdict = validateEvidence(invoices, deliveries, args.claimedCents);
    const id = await ctx.db.insert("evidenceCandidates", { sessionId: args.sessionId, obligationCode: "O3", lineId: args.lineId,
      claimedCents: args.claimedCents, status: verdict.status, computedCents: verdict.cents, rationale: args.rationale.slice(0, 500),
      sourceRefs: [...invoices, ...deliveries].map(x => x.sourceRef), modelName: args.modelName, createdAt: Date.now() });
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
        sessionId, ...candidate, modelName: config.settings.model
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
      sourceRefs: [...invoices, ...deliveries].map(x => x.sourceRef), modelName: "MANUAL_FALLBACK", createdAt: Date.now() });
  }
});
