import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { CODES, calculate, evaluatePolicy, validateEvidence, validateProposal, type CompanyCode, type Obligation, type PolicyTerms } from "./lib/engine";

const companyV = v.union(v.literal("A"), v.literal("B"), v.literal("C"));
const DAYS = Date.UTC(2026, 9, 31, 12, 0, 0);
const EXPIRES = Date.UTC(2026, 10, 1, 12, 0, 0);
const SETUP_KEY = () => process.env.CONTRAOS_SETUP_KEY;
const now = () => Date.now();


async function readObligations(ctx: any, sessionId: Id<"sessions">): Promise<Obligation[]> {
  const rows = await ctx.db.query("obligations").withIndex("by_session", (q: any) => q.eq("sessionId", sessionId)).collect() as Doc<"obligations">[];
  return rows.map(o => ({ code: o.code, debtor: o.debtor, creditor: o.creditor, amountCents: o.amountCents, disputedCents: o.disputedCents }));
}
async function currentPolicy(ctx: any, sessionId: Id<"sessions">, company: CompanyCode): Promise<Doc<"policies"> | null> {
  const rows = await ctx.db.query("policies").withIndex("by_company", (q: any) => q.eq("sessionId", sessionId).eq("company", company)).collect() as Doc<"policies">[];
  return rows.sort((a, b) => b.version - a.version)[0] ?? null;
}
async function audit(ctx: any, sessionId: Id<"sessions">, kind: string, message: string, actor = "system") {
  await ctx.db.insert("auditEvents", { sessionId, kind, message, actor, createdAt: now() });
}
async function officer(ctx: any, sessionId: Id<"sessions">, token: string): Promise<CompanyCode> {
  if (!token || token.length < 16) throw new Error("OFFICER_UNAUTHORIZED");
  const companies = await ctx.db.query("companies").withIndex("by_session", (q: any) => q.eq("sessionId", sessionId)).collect() as Doc<"companies">[];
  const hash = await digest(token);
  const match = companies.find(c => c.officerTokenHash === hash);
  if (!match) throw new Error("OFFICER_UNAUTHORIZED");
  return match.code;
}
async function digest(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function scheduleDecisions(ctx: any, sessionId: Id<"sessions">, proposalId: Id<"proposals">, companies: CompanyCode[] = CODES) {
  for (const company of companies) await ctx.scheduler.runAfter(0, internal.workflow.agentDecide, { sessionId, proposalId, company });
}
export const initialize = mutation({
  args: { setupKey: v.string(), slug: v.string(), officerA: v.string(), officerB: v.string(), officerC: v.string() },
  handler: async (ctx, args) => {
    if (!SETUP_KEY() || args.setupKey !== SETUP_KEY()) throw new Error("SETUP_FORBIDDEN");
    if (args.slug.length < 3 || args.slug.length > 40 || !/^[a-z0-9-]+$/.test(args.slug)) throw new Error("INVALID_SLUG");
    if ([args.officerA, args.officerB, args.officerC].some(t => t.length < 16) || new Set([args.officerA, args.officerB, args.officerC]).size !== 3) throw new Error("INVALID_OFFICER_TOKENS");
    const existing = await ctx.db.query("sessions").withIndex("by_slug", q => q.eq("slug", args.slug)).first();
    if (existing) throw new Error("DEMO_ALREADY_SEEDED");
    const sessionId = await ctx.db.insert("sessions", { slug: args.slug, label: "Tri-party settlement • synthetic demo", evidenceVersion: 1, createdAt: now() });
    for (const [code, name, token] of [["A", "Atlas Manufacturing", args.officerA], ["B", "Beacon Logistics", args.officerB], ["C", "Cedar Components", args.officerC]] as const) {
      await ctx.db.insert("companies", { sessionId, code, name, officerTokenHash: await digest(token) });
    }
    for (const o of [{ code: "O1", debtor: "A", creditor: "B", amountCents: 2000000 }, { code: "O2", debtor: "B", creditor: "C", amountCents: 1500000 }, { code: "O3", debtor: "C", creditor: "A", amountCents: 1200000 }] as const) {
      await ctx.db.insert("obligations", { sessionId, ...o, disputedCents: 0 });
    }
    for (const [lineId, quantity, unitPriceCents, received] of [["L1", 100, 5000, 60], ["L2", 70, 10000, 70]] as const) {
      await ctx.db.insert("invoiceLines", { sessionId, obligationCode: "O3", lineId, quantity, unitPriceCents, sourceRef: "INV-003:" + lineId });
      await ctx.db.insert("deliveries", { sessionId, obligationCode: "O3", lineId, received, periodComplete: true, sourceRef: "DEL-003:" + lineId });
    }
    const obligations = await readObligations(ctx, sessionId);
    const calculated = calculate(obligations);
    const proposalId = await ctx.db.insert("proposals", { sessionId, version: 1, evidenceVersion: 1, obligationCodes: obligations.map(o => o.code), ...calculated, settleBy: DAYS, status: "open", createdAt: now() });
    await ctx.db.patch(sessionId, { currentProposalId: proposalId });
    await audit(ctx, sessionId, "session_initialized", "Synthetic obligations and proposal V1 created");
    await scheduleDecisions(ctx, sessionId, proposalId);
    return { sessionId, proposalId };
  }
});
export const getSession = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const session = await ctx.db.query("sessions").withIndex("by_slug", q => q.eq("slug", slug)).first();
    if (!session) return null;
    const [companies, obligations, proposals, decisions, audits, candidates, policies, disputes, invoices, deliveries] = await Promise.all([
      ctx.db.query("companies").withIndex("by_session", q => q.eq("sessionId", session._id)).collect(),
      ctx.db.query("obligations").withIndex("by_session", q => q.eq("sessionId", session._id)).collect(),
      ctx.db.query("proposals").withIndex("by_session", q => q.eq("sessionId", session._id)).collect(),
      ctx.db.query("agentDecisions").collect(),
      ctx.db.query("auditEvents").withIndex("by_session", q => q.eq("sessionId", session._id)).collect(),
      ctx.db.query("evidenceCandidates").withIndex("by_session", q => q.eq("sessionId", session._id)).collect(),
      ctx.db.query("policies").collect(),
      ctx.db.query("disputes").collect(),
      ctx.db.query("invoiceLines").collect(),
      ctx.db.query("deliveries").collect()
    ]);
    // Demo-only public read model; no credentials, hashes or private source text.
    return {
      session: { id: session._id, slug, label: session.label, evidenceVersion: session.evidenceVersion, currentProposalId: session.currentProposalId },
      companies: companies.map(c => ({ code: c.code, name: c.name })),
      obligations: obligations.map(o => ({ code: o.code, debtor: o.debtor, creditor: o.creditor, amountCents: o.amountCents, disputedCents: o.disputedCents })),
      proposals: proposals.map(p => ({ ...p })),
      decisions: decisions.filter(d => d.sessionId === session._id),
      policies: policies.filter(p => p.sessionId === session._id).map(p => ({ company: p.company, version: p.version, maxNetPayCents: p.maxNetPayCents, minNetReceiveCents: p.minNetReceiveCents, expiresAt: p.expiresAt })),
      audit: audits.sort((a,b)=> b.createdAt-a.createdAt).slice(0,30),
      candidates: candidates.map(c => ({ ...c })),
      disputes: disputes.filter(d => d.sessionId === session._id),
      evidence: { invoices: invoices.filter(i => i.sessionId === session._id), deliveries: deliveries.filter(d => d.sessionId === session._id) }
    };
  }
});
export const grantPolicy = mutation({
  args: { sessionId: v.id("sessions"), officerToken: v.string(), maxNetPayCents: v.optional(v.number()), minNetReceiveCents: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const company = await officer(ctx, args.sessionId, args.officerToken);
    const session = await ctx.db.get(args.sessionId);
    if (!session?.currentProposalId) throw new Error("SESSION_NOT_READY");
    const existing = await currentPolicy(ctx, args.sessionId, company);
    if (company === "A") {
      if (args.maxNetPayCents === undefined || !Number.isSafeInteger(args.maxNetPayCents) || args.maxNetPayCents < 0 || args.maxNetPayCents > 10_000_000) throw new Error("INVALID_LIMIT");
    } else {
      if (args.minNetReceiveCents === undefined || !Number.isSafeInteger(args.minNetReceiveCents) || args.minNetReceiveCents < 0 || args.minNetReceiveCents > 10_000_000) throw new Error("INVALID_FLOOR");
    }
    const version = (existing?.version ?? 0) + 1;
    await ctx.db.insert("policies", {
      sessionId: args.sessionId, company, version, maxNetPayCents: company === "A" ? args.maxNetPayCents : undefined,
      minNetReceiveCents: company !== "A" ? args.minNetReceiveCents : undefined,
      allowedObligations: ["O1", "O2", "O3"], allowDisputeExclusions: true,
      expiresAt: EXPIRES, settleBy: DAYS, createdAt: now()
    });
    // A new policy grant changes the authorization basis of an existing proposal.
    // Invalidate current authorization in the same transaction, BEFORE scheduling
    // a new decision. The proposal is not executable while policy rechecks run.
    const proposal = await ctx.db.get(session.currentProposalId);
    if (!proposal || proposal.status === "superseded") throw new Error("INVALID_CURRENT_PROPOSAL");
    if (proposal.status === "authorized") {
      await ctx.db.patch(proposal._id, { status: "open" });
      await audit(ctx, args.sessionId, "authorization_invalidated",
        "V" + proposal.version + " requires fresh authorization after policy change", "system");
    }
    await audit(ctx, args.sessionId, "policy_granted", "Company " + company + " granted policy v" + version, company + " officer");
    await scheduleDecisions(ctx, args.sessionId, session.currentProposalId, [company]);
    return { company, version };
  }
});
export const agentDecide = internalMutation({
  args: { sessionId: v.id("sessions"), proposalId: v.id("proposals"), company: companyV },
  handler: async (ctx, { sessionId, proposalId, company }) => {
    const [session, proposal] = await Promise.all([ctx.db.get(sessionId), ctx.db.get(proposalId)]);
    if (!session || session.currentProposalId !== proposalId || !proposal || proposal.status !== "open") return { ignored: "PROPOSAL_NOT_OPEN" };
    const policy = await currentPolicy(ctx, sessionId, company);
    const terms = { obligationCodes: proposal.obligationCodes, positions: proposal.positions, transfers: proposal.transfers, hasDisputeExclusions: proposal.hasDisputeExclusions, settleBy: proposal.settleBy };
    const reasons = evaluatePolicy(policy as PolicyTerms | null, terms, now());
    const previous = await ctx.db.query("agentDecisions").withIndex("by_proposal_company", q => q.eq("proposalId", proposalId).eq("company", company)).collect();
    // A new policy version replaces this company's old decision. Keep event history in auditEvents.
    for (const d of previous) await ctx.db.delete(d._id);
    await ctx.db.insert("agentDecisions", { sessionId, proposalId, company, policyId: policy?._id, policyVersion: policy?.version,
      decision: reasons.length ? "escalate" : "accept", reasons, decidedAt: now() });
    await audit(ctx, sessionId, "agent_decided", company + " independently " + (reasons.length ? "escalated" : "accepted") + " V" + proposal.version + (reasons.length ? ": " + reasons.join(", ") : ""), "Agent " + company);
    await ctx.scheduler.runAfter(0, internal.workflow.tryAuthorize, { sessionId, proposalId });
    return { ignored: null, decision: reasons.length ? "escalate" : "accept" };
  }
});
export const tryAuthorize = internalMutation({
  args: { sessionId: v.id("sessions"), proposalId: v.id("proposals") },
  handler: async (ctx, { sessionId, proposalId }) => {
    const session = await ctx.db.get(sessionId), proposal = await ctx.db.get(proposalId);
    if (!session || session.currentProposalId !== proposalId || !proposal || proposal.status === "superseded") return { authorized: false, reason: "STALE" };
    if (proposal.evidenceVersion !== session.evidenceVersion) return { authorized: false, reason: "EVIDENCE_STALE" };
    const obligations = await readObligations(ctx, sessionId);
    validateProposal(proposal, obligations);
    for (const company of CODES) {
      const policy = await currentPolicy(ctx, sessionId, company);
      const reasons = evaluatePolicy(policy as PolicyTerms | null, proposal, now());
      if (reasons.length) return { authorized: false, reason: company + ":" + reasons.join(",") };
      const rows = await ctx.db.query("agentDecisions").withIndex("by_proposal_company", q => q.eq("proposalId", proposalId).eq("company", company)).collect();
      const decision = rows[0];
      if (rows.length !== 1 || decision.decision !== "accept" || decision.policyId !== policy?._id || decision.policyVersion !== policy?.version) return { authorized: false, reason: company + ":DECISION_NOT_CURRENT" };
    }
    if (proposal.status === "open") {
      await ctx.db.patch(proposalId, { status: "authorized" });
      await audit(ctx, sessionId, "proposal_authorized", "Proposal V" + proposal.version + " authorized — no funds transferred");
    }
    return { authorized: true };
  }
});
/** CLI-only recovery for demo after a failed scheduled authorization check.
 * Never bypasses tryAuthorize; schedules the same full server-side checks.
 */
export const retryDemoAuthorization = internalMutation({
  args: {},
  handler: async (ctx) => {
    const session = await ctx.db.query("sessions").withIndex("by_slug", q => q.eq("slug", "demo")).unique();
    if (!session?.currentProposalId) throw new Error("DEMO_NOT_FOUND");
    const proposal = await ctx.db.get(session.currentProposalId);
    if (!proposal || proposal.status !== "open") throw new Error("NO_OPEN_DEMO_PROPOSAL");
    await ctx.scheduler.runAfter(0, internal.workflow.tryAuthorize, {
      sessionId: session._id,
      proposalId: proposal._id
    });
    return { scheduled: true, version: proposal.version };
  }
});
export const fileDispute = mutation({
  args: { sessionId: v.id("sessions"), officerToken: v.string(), obligationCode: v.string(), lineId: v.string(), claimedCents: v.number() },
  handler: async (ctx, args) => {
    const actor = await officer(ctx, args.sessionId, args.officerToken);
    const session = await ctx.db.get(args.sessionId);
    if (!session?.currentProposalId) throw new Error("NO_CURRENT_PROPOSAL");
    const current = await ctx.db.get(session.currentProposalId);
    if (!current || (current.status !== "open" && current.status !== "authorized")) throw new Error("CURRENT_PROPOSAL_NOT_ACTIONABLE");
    if (!current.obligationCodes.includes(args.obligationCode)) throw new Error("OBLIGATION_NOT_IN_CURRENT_SETTLEMENT");
    const obligation = await ctx.db.query("obligations").withIndex("by_session_code", q => q.eq("sessionId", args.sessionId).eq("code", args.obligationCode)).unique();
    if (!obligation || obligation.debtor !== actor) throw new Error("NOT_DEBTOR");
    const existing = await ctx.db.query("disputes").withIndex("by_line", q => q.eq("sessionId", args.sessionId).eq("obligationCode", args.obligationCode).eq("lineId", args.lineId)).first();
    if (existing) throw new Error("DUPLICATE_DISPUTE");
    const [invoices, deliveries] = await Promise.all([
      ctx.db.query("invoiceLines").withIndex("by_obligation", q => q.eq("sessionId", args.sessionId).eq("obligationCode", args.obligationCode).eq("lineId", args.lineId)).collect(),
      ctx.db.query("deliveries").withIndex("by_obligation", q => q.eq("sessionId", args.sessionId).eq("obligationCode", args.obligationCode).eq("lineId", args.lineId)).collect()
    ]);
    const verdict = validateEvidence(invoices, deliveries, args.claimedCents);
    if (verdict.status !== "SUPPORTED" || !verdict.cents) throw new Error("DISPUTE_" + verdict.status + ": " + verdict.reason);
    if (obligation.disputedCents + verdict.cents > obligation.amountCents) throw new Error("DISPUTE_EXCEEDS_OBLIGATION");
    await ctx.db.insert("disputes", { sessionId: args.sessionId, obligationCode: args.obligationCode, lineId: args.lineId, cents: verdict.cents, filedBy: actor, createdAt: now() });
    await ctx.db.patch(obligation._id, { disputedCents: obligation.disputedCents + verdict.cents });
    const evidenceVersion = session.evidenceVersion + 1;
    const newObligations = await readObligations(ctx, args.sessionId);
    const calculated = calculate(newObligations);
    const proposalId = await ctx.db.insert("proposals", { sessionId: args.sessionId, version: current.version + 1, evidenceVersion,
      obligationCodes: newObligations.map(o => o.code), ...calculated, settleBy: current.settleBy, status: "open", createdAt: now() });
    await ctx.db.patch(current._id, { status: "superseded" });
    await ctx.db.patch(session._id, { evidenceVersion, currentProposalId: proposalId });
    await audit(ctx, args.sessionId, "dispute_filed", actor + " officer placed " + verdict.cents / 100 + " USD on hold; V" + current.version + " superseded by V" + (current.version + 1), actor + " officer");
    await scheduleDecisions(ctx, args.sessionId, proposalId);
    return { proposalId, disputedCents: verdict.cents };
  }
});
