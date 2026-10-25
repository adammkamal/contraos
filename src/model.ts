import type { FunctionReturnType } from "convex/server";
import type { api } from "../convex/_generated/api";

export type Code = "A" | "B" | "C";
export const CODES: Code[] = ["A", "B", "C"];
export type Session = NonNullable<FunctionReturnType<typeof api.workflow.getSession>>;
export type Proposal = Session["proposals"][number];
export type Decision = Session["decisions"][number];
export type Policy = Session["policies"][number];

// The seeded scenario's disputable line. The dispute and manual-fallback actions are scoped to it.
export const TARGET = { obligation: "O3", line: "L1" } as const;

const MINUS = "−";

export function money(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function signedMoney(cents: number): string {
  if (cents === 0) return money(0);
  return (cents < 0 ? MINUS : "+") + money(Math.abs(cents));
}

export const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);

export function latestPolicies(policies: Policy[]): Partial<Record<Code, Policy>> {
  const out: Partial<Record<Code, Policy>> = {};
  for (const p of policies) {
    const known = out[p.company];
    if (!known || known.version < p.version) out[p.company] = p;
  }
  return out;
}

/** Gross obligations in a proposal; dispute holds only reduce proposals built with exclusions. */
export function grossCents(proposal: Proposal, obligations: Session["obligations"]): number {
  return sum(
    obligations
      .filter((o) => proposal.obligationCodes.includes(o.code))
      .map((o) => o.amountCents - (proposal.hasDisputeExclusions ? o.disputedCents : 0)),
  );
}

export const transferTotal = (proposal: Proposal) => sum(proposal.transfers.map((t) => t.cents));

export function positionOf(proposal: Proposal | undefined, company: Code): number {
  return proposal?.positions.find((p) => p.company === company)?.cents ?? 0;
}

export function decisionOf(data: Session, proposal: Proposal | undefined, company: Code): Decision | undefined {
  if (!proposal) return undefined;
  return data.decisions
    .filter((d) => d.proposalId === proposal._id && d.company === company)
    .sort((a, b) => b.decidedAt - a.decidedAt)[0];
}

/** What a company's policy is measured against: payment cap for payers, receipt floor for receivers. */
export function requirement(position: number, policy: Policy | undefined) {
  if (position < 0) {
    return { kind: "pay" as const, amount: -position, bound: policy?.maxNetPayCents, within: policy?.maxNetPayCents !== undefined && -position <= policy.maxNetPayCents };
  }
  return { kind: "receive" as const, amount: position, bound: policy?.minNetReceiveCents, within: policy?.minNetReceiveCents !== undefined && position >= policy.minNetReceiveCents };
}

export function describeRequirement(position: number, policy: Policy | undefined): string {
  const r = requirement(position, policy);
  if (r.kind === "pay") return `Pays ${money(r.amount)}` + (r.bound === undefined ? "" : ` · max ${money(r.bound)}`);
  return `Receives ${money(r.amount)}` + (r.bound === undefined ? "" : ` · min ${money(r.bound)}`);
}

const REASON_TEXT: Record<string, string> = {
  PAYMENT_LIMIT_EXCEEDED: "net payment exceeds the officer-granted maximum",
  RECEIPT_FLOOR_NOT_MET: "net receipt is below the officer-granted minimum",
  POLICY_NOT_GRANTED: "no policy has been granted",
  POLICY_EXPIRED: "policy has expired",
  SETTLEMENT_DATE_OUT_OF_SCOPE: "settlement date is outside policy scope",
  OBLIGATION_OUT_OF_SCOPE: "an obligation is outside policy scope",
  REVISION_NOT_PERMITTED: "policy does not permit dispute-adjusted revisions",
  MISSING_POSITION: "company has no position in this proposal",
};
export const reasonText = (code: string) => REASON_TEXT[code] ?? code.toLowerCase().replaceAll("_", " ");

/**
 * How a stored agent decision should be read. The backend only persists `accept` and `escalate`;
 * the other kinds describe whether that stored row still counts for the proposal being shown.
 */
export type DecisionKind = "current_accept" | "current_escalate" | "stale" | "missing" | "historical";
export interface DecisionReading {
  kind: DecisionKind;
  /** True only for an accept on the current proposal under the company's current policy version. */
  approved: boolean;
  /** What the stored row says, even when it no longer counts. */
  recorded?: Decision["decision"];
  decidedUnder?: number;
  currentPolicy?: number;
}

export function interpretDecision(decision: Decision | undefined, latest: Policy | undefined, currentProposalId: string | undefined): DecisionReading {
  if (!decision) return { kind: "missing", approved: false, currentPolicy: latest?.version };
  const meta = { recorded: decision.decision, decidedUnder: decision.policyVersion, currentPolicy: latest?.version };
  if (decision.proposalId !== currentProposalId) return { kind: "historical", approved: false, ...meta };
  // Both undefined means the agent decided when no policy existed and none exists now.
  if (decision.policyVersion !== latest?.version) return { kind: "stale", approved: false, ...meta };
  return decision.decision === "accept" ? { kind: "current_accept", approved: true, ...meta } : { kind: "current_escalate", approved: false, ...meta };
}

/** Plain-language caveat for decisions that do not count; undefined when nothing needs saying. */
export function readingNote(r: DecisionReading): string | undefined {
  if (r.kind === "stale") return `${r.recorded === "accept" ? "An accept" : "An escalation"} recorded under policy v${r.decidedUnder ?? "none"}; v${r.currentPolicy ?? "none"} is current. It does not count until the agent decides again.`;
  if (r.kind === "missing") return "No agent decision is recorded for this proposal.";
  if (r.kind === "historical") return "Decision belongs to an earlier proposal.";
  return undefined;
}

export const AUDIT_LABEL: Record<string, string> = {
  proposal_authorized: "Authorized",
  agent_decided: "Agent decision",
  policy_granted: "Policy",
  dispute_filed: "Dispute",
  authorization_invalidated: "Invalidated",
};
export const auditLabel = (kind: string) => AUDIT_LABEL[kind] ?? kind.replaceAll("_", " ");

export type Phase = "none" | "authorized" | "blocked" | "reevaluating" | "evaluating" | "pending_authorization" | "superseded";

/** `getSession` returns only this many recent audit events, so an absent event is not proof. */
export const AUDIT_WINDOW = 30;
export type AuthorizationHistory = "authorized" | "not_recorded" | "unknown";

/**
 * Whether a proposal was ever authorized, as far as the available records can say. Superseded does
 * not imply authorized: a dispute supersedes whatever proposal is current, authorized or not.
 */
export function authorizationHistory(data: Session, proposal: Proposal): AuthorizationHistory {
  if (proposal.status === "authorized") return "authorized";
  const recorded = data.audit.some((e) => e.kind === "proposal_authorized" && e.message.startsWith(`Proposal V${proposal.version} authorized`));
  if (recorded) return "authorized";
  if (proposal.status === "open") return "not_recorded";
  return data.audit.length >= AUDIT_WINDOW ? "unknown" : "not_recorded";
}

export type StepState = "done" | "current" | "waiting" | "skipped";
export interface Step { label: string; detail: string; state: StepState }

export function derive(data: Session) {
  const proposals = [...data.proposals].sort((a, b) => a.version - b.version);
  const current = proposals.find((p) => p._id === data.session.currentProposalId);
  const prior = current ? proposals.filter((p) => p.version < current.version).at(-1) : undefined;
  const policies = latestPolicies(data.policies);
  const decisions = CODES.map((code) => {
    const decision = decisionOf(data, current, code);
    return { code, decision, reading: interpretDecision(decision, policies[code], current?._id) };
  });
  const kindOf = (kind: DecisionKind) => decisions.filter((d) => d.reading.kind === kind).map((d) => d.code);
  const escalated = kindOf("current_escalate");
  const stale = kindOf("stale");
  const missing = kindOf("missing");
  // Only the server's persisted status can make a proposal "authorized". With an open proposal,
  // three current accepts mean the server's authorization check is pending, not that it passed.
  const phase: Phase = !current
    ? "none"
    : current.status === "authorized"
      ? "authorized"
      : current.status === "superseded"
        ? "superseded"
        : escalated.length
          ? "blocked"
          : stale.length
            ? "reevaluating"
            : missing.length
              ? "evaluating"
              : "pending_authorization";
  // grantPolicy reopens an authorized proposal and audits it in the same transaction, so a policy
  // change never leaves a stale decision under an authorized proposal. A snapshot that shows one
  // is an inconsistent record, not a normal state.
  const consistent = phase !== "authorized" || decisions.every((d) => d.reading.approved);
  const reopened = !!current && current.status === "open" && data.audit.some((e) => e.kind === "authorization_invalidated" && e.message.startsWith(`V${current.version} `));
  const names = Object.fromEntries(data.companies.map((c) => [c.code, c.name])) as Record<Code, string>;
  const holds = data.disputes.filter((d) => d.obligationCode === TARGET.obligation && d.lineId === TARGET.line);
  const disputeFiled = holds.length > 0;
  const holdCents = sum(data.disputes.map((d) => d.cents));
  // Amendments: companies whose policy has been re-granted at least once, with first and latest limit.
  const amendments = CODES.flatMap((code) => {
    const versions = data.policies.filter((p) => p.company === code).sort((a, b) => a.version - b.version);
    if (versions.length < 2) return [];
    const pick = (p: Policy) => p.maxNetPayCents ?? p.minNetReceiveCents ?? 0;
    return [{ code, from: pick(versions[0]), to: pick(versions.at(-1)!), kind: versions[0].maxNetPayCents !== undefined ? "max" : "min" }];
  });

  const steps: Step[] = [];
  const first = proposals[0];
  const firstHistory = first ? authorizationHistory(data, first) : "not_recorded";
  if (first) {
    const net = `${money(transferTotal(first))} net transfers`;
    if (firstHistory === "authorized") steps.push({ label: `V${first.version} authorized`, detail: net, state: "done" });
    else if (first.status === "open") steps.push({ label: `V${first.version} awaiting authorization`, detail: net, state: "current" });
    else {
      // Superseded with no authorization evidence: say what the records show, nothing more.
      steps.push({
        label: `V${first.version} superseded`,
        detail: firstHistory === "unknown" ? "Authorization history not available in this view" : "No authorization in the audit trail",
        state: "skipped",
      });
    }
  }
  steps.push({
    label: "Evidence dispute",
    detail: disputeFiled ? `${money(holdCents)} hold on ${TARGET.obligation} ${TARGET.line}` : "None filed",
    state: disputeFiled ? "done" : firstHistory === "authorized" ? "current" : "waiting",
  });
  const second = proposals.find((p) => p.version > 1);
  const secondDecided = decisions.every((d) => d.reading.kind === "current_accept" || d.reading.kind === "current_escalate");
  steps.push({
    label: second ? `V${second.version} evaluated` : "Revised proposal",
    detail: second ? (secondDecided || second._id !== current?._id ? `${money(transferTotal(second))} net transfers` : "Waiting for current agent decisions") : "Created after a validated dispute",
    state: !second ? "waiting" : second._id !== current?._id || phase === "authorized" || secondDecided ? "done" : "current",
  });
  const amendmentText = amendments.map((a) => `${a.code} ${a.kind} ${money(a.from)} → ${money(a.to)}`).join(", ");
  const onSecond = !!second && current?._id === second._id;
  steps.push({
    label: "Officer amendment",
    detail:
      phase === "reevaluating" && amendments.length
        ? `${amendmentText}; agent re-evaluation pending`
        : amendments.length
          ? amendmentText
          : phase === "blocked" && onSecond
            ? `${escalated.join(", ")} must be re-granted by its officer`
            : "Only if an agent escalates",
    state: phase === "reevaluating" ? "current" : amendments.length ? "done" : phase === "blocked" && onSecond ? "current" : second && phase === "authorized" ? "skipped" : "waiting",
  });
  const finalDone = phase === "authorized" && !!current && current.version > 1;
  steps.push({
    label: second ? `V${second.version} authorized` : "Authorization",
    detail: finalDone ? "No funds moved" : reopened ? "Invalidated by a policy change; needs fresh checks" : phase === "pending_authorization" ? "Awaiting the server's authorization check" : "Needs three current accepts",
    state: finalDone ? "done" : phase === "pending_authorization" ? "current" : "waiting",
  });

  return { proposals, current, prior, policies, decisions, escalated, stale, missing, phase, consistent, reopened, names, disputeFiled, holdCents, amendments, steps };
}

/** Deterministic display arithmetic over persisted ledger rows; the server revalidates on dispute. */
export function ledger(data: Session, obligation: string) {
  const invoice = data.evidence.invoices.filter((i) => i.obligationCode === obligation).sort((a, b) => a.lineId.localeCompare(b.lineId));
  const received = data.evidence.deliveries.filter((d) => d.obligationCode === obligation);
  const rows = invoice.map((i) => {
    const d = received.find((r) => r.lineId === i.lineId);
    const short = d ? Math.max(0, i.quantity - d.received) : 0;
    return { ...i, delivery: d, amountCents: i.quantity * i.unitPriceCents, shortUnits: short, shortCents: short * i.unitPriceCents };
  });
  return {
    rows,
    invoiceId: invoice[0]?.sourceRef.split(":")[0],
    deliveryId: received[0]?.sourceRef.split(":")[0],
    invoiceTotal: sum(rows.map((r) => r.amountCents)),
    periodComplete: received.length > 0 && received.every((r) => r.periodComplete),
  };
}

const DEFAULT_LIMIT: Record<Code, string> = { A: "9000", B: "4000", C: "2000" };

/**
 * Form state for acting as a company. Always returns an empty credential so one officer's secret
 * is never carried into another company's context; the server still authorizes every action.
 */
export function formContext(policies: Policy[], company: Code, requiredCents?: number) {
  const policy = latestPolicies(policies)[company];
  const granted = company === "A" ? policy?.maxNetPayCents : policy?.minNetReceiveCents;
  const cents = requiredCents ?? granted;
  return { company, token: "", limit: cents === undefined ? DEFAULT_LIMIT[company] : String(cents / 100) };
}

export interface DisputeReadiness { ok: boolean; cents: number; reason: string }

/** Whether the ledger supports a positive, complete-period shortfall. The server revalidates on submit. */
export function disputeReadiness(data: Session): DisputeReadiness {
  const row = ledger(data, TARGET.obligation).rows.find((r) => r.lineId === TARGET.line);
  const fail = (reason: string): DisputeReadiness => ({ ok: false, cents: 0, reason });
  if (!row) return fail(`No invoice line ${TARGET.line} is recorded for ${TARGET.obligation}.`);
  if (!row.delivery) return fail(`No delivery record exists for ${TARGET.obligation} ${TARGET.line}.`);
  if (!row.delivery.periodComplete) return fail("The delivery period is not complete, so a shortfall cannot be supported yet.");
  // Same input rules the server applies to structured evidence; it stays authoritative.
  const wholeCounts = [row.quantity, row.delivery.received].every((n) => Number.isSafeInteger(n) && n >= 0);
  if (!wholeCounts || !Number.isSafeInteger(row.unitPriceCents) || row.unitPriceCents <= 0) return fail("The ledger quantities or unit price are not valid whole numbers.");
  if (row.shortCents <= 0) return fail("Received quantity covers the billed quantity; there is no shortfall to dispute.");
  return { ok: true, cents: row.shortCents, reason: "" };
}

/**
 * How far a position is past its delegated limit, in cents. Positive means over the maximum payment
 * (or under the minimum receipt); zero or negative is the remaining margin. Undefined when no limit is set.
 */
export function limitGap(position: number, policy: Policy | undefined): number | undefined {
  const r = requirement(position, policy);
  if (r.bound === undefined) return undefined;
  return r.kind === "pay" ? r.amount - r.bound : r.bound - r.amount;
}
