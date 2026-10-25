import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const code = v.union(v.literal("A"), v.literal("B"), v.literal("C"));
const transfer = v.object({ from: code, to: code, cents: v.number() });
const position = v.object({ company: code, cents: v.number() });

export default defineSchema({
  sessions: defineTable({
    slug: v.string(), label: v.string(), evidenceVersion: v.number(),
    currentProposalId: v.optional(v.id("proposals")), createdAt: v.number()
  }).index("by_slug", ["slug"]),
  companies: defineTable({
    sessionId: v.id("sessions"), code, name: v.string(), officerTokenHash: v.string()
  }).index("by_session", ["sessionId"]),
  obligations: defineTable({
    sessionId: v.id("sessions"), code: v.string(), debtor: code, creditor: code,
    amountCents: v.number(), disputedCents: v.number()
  }).index("by_session", ["sessionId"]).index("by_session_code", ["sessionId", "code"]),
  invoiceLines: defineTable({
    sessionId: v.id("sessions"), obligationCode: v.string(), lineId: v.string(),
    quantity: v.number(), unitPriceCents: v.number(), sourceRef: v.string()
  }).index("by_obligation", ["sessionId", "obligationCode", "lineId"]),
  deliveries: defineTable({
    sessionId: v.id("sessions"), obligationCode: v.string(), lineId: v.string(),
    received: v.number(), periodComplete: v.boolean(), sourceRef: v.string()
  }).index("by_obligation", ["sessionId", "obligationCode", "lineId"]),
  disputes: defineTable({
    sessionId: v.id("sessions"), obligationCode: v.string(), lineId: v.string(),
    cents: v.number(), filedBy: code, createdAt: v.number()
  }).index("by_line", ["sessionId", "obligationCode", "lineId"]),
  policies: defineTable({
    sessionId: v.id("sessions"), company: code, version: v.number(),
    maxNetPayCents: v.optional(v.number()), minNetReceiveCents: v.optional(v.number()),
    allowedObligations: v.array(v.string()), allowDisputeExclusions: v.boolean(),
    expiresAt: v.number(), settleBy: v.number(), createdAt: v.number()
  }).index("by_company", ["sessionId", "company"]),
  proposals: defineTable({
    sessionId: v.id("sessions"), version: v.number(), evidenceVersion: v.number(),
    obligationCodes: v.array(v.string()), hasDisputeExclusions: v.boolean(),
    positions: v.array(position), transfers: v.array(transfer),
    settleBy: v.number(), status: v.union(v.literal("open"), v.literal("authorized"), v.literal("superseded")),
    createdAt: v.number()
  }).index("by_session", ["sessionId"]),
  agentDecisions: defineTable({
    sessionId: v.id("sessions"), proposalId: v.id("proposals"), company: code,
    policyId: v.optional(v.id("policies")), policyVersion: v.optional(v.number()),
    decision: v.union(v.literal("accept"), v.literal("escalate")),
    reasons: v.array(v.string()), decidedAt: v.number()
  }).index("by_proposal_company", ["proposalId", "company"]),
  evidenceCandidates: defineTable({
    sessionId: v.id("sessions"), obligationCode: v.string(), lineId: v.string(),
    claimedCents: v.number(), status: v.string(), computedCents: v.optional(v.number()),
    rationale: v.string(), sourceRefs: v.array(v.string()), modelName: v.string(), createdAt: v.number()
  }).index("by_session", ["sessionId"]),
  auditEvents: defineTable({
    sessionId: v.id("sessions"), kind: v.string(), message: v.string(),
    actor: v.string(), createdAt: v.number()
  }).index("by_session", ["sessionId"])
});
