// Presentation helpers that turn persisted records into plain-language statements.
// Rule: a sentence appears only when a specific record proves it; otherwise it is omitted and,
// where useful, reported in `gaps`.
import { AUDIT_WINDOW, CODES, TARGET, derive, disputeReadiness, grossCents, limitGap, money, positionOf, reasonText, signedMoney, transferTotal, type Code, type Policy, type Session } from "./model";

export type View = ReturnType<typeof derive>;
type Names = Record<Code, string>;
type AuditRow = Session["audit"][number];

const firstName = (names: Names, c: Code) => (names[c] ?? c).split(" ")[0];
/** "Atlas (A)": first word of the stored company name plus its code. Never hardcoded. */
export const shortName = (names: Names, c: Code) => `${firstName(names, c)} (${c})`;

/** Recorded time first; records sharing a millisecond fall back to Convex's creation order. */
export const auditBefore = (a: AuditRow, b: AuditRow) =>
  a.createdAt !== b.createdAt ? a.createdAt < b.createdAt : (a._creationTime ?? 0) < (b._creationTime ?? 0);
export const auditNewestFirst = (rows: AuditRow[]) => [...rows].sort((a, b) => (auditBefore(a, b) ? 1 : auditBefore(b, a) ? -1 : 0));

/** Audit actors are stored as "A officer", "Agent A", "system"; show them with company names. */
export function actorLabel(actor: string, names: Names): string {
  const officer = /^([ABC]) officer$/i.exec(actor);
  if (officer) return `${firstName(names, officer[1].toUpperCase() as Code)} officer`;
  const agent = /^Agent ([ABC])$/i.exec(actor);
  if (agent) return `${firstName(names, agent[1].toUpperCase() as Code)} agent`;
  return actor.toLowerCase() === "system" ? "System" : actor;
}

/** "Pays $2,000 more" rather than a bare sign; falls back to a signed amount when the side flips. */
export function changeText(before: number, after: number): string {
  const delta = after - before;
  if (delta === 0) return "None";
  if (before <= 0 && after <= 0) return `Pays ${money(Math.abs(delta))} ${delta < 0 ? "more" : "less"}`;
  if (before >= 0 && after >= 0) return `Receives ${money(Math.abs(delta))} ${delta > 0 ? "more" : "less"}`;
  return signedMoney(delta);
}

/** The server returns at most AUDIT_WINDOW recent events, so a full window must not read as complete history. */
export function historyNote(count: number): string {
  const order = "Newest first, as recorded by the server. Events with the same recorded time are ordered by when each record was created.";
  return count >= AUDIT_WINDOW
    ? `${order} Showing the ${count} most recent events; earlier events are not included in this view.`
    : `${order} Showing all ${count} ${count === 1 ? "event" : "events"} recorded for this session.`;
}

export interface NextStep { text: string; officer?: Code; evidence?: boolean }

/** What, if anything, a human has to do now. Agents and the server act on their own. */
export function nextStep(data: Session, v: View): NextStep | undefined {
  const join = (codes: Code[]) => codes.map((c) => shortName(v.names, c)).join(" and ");
  switch (v.phase) {
    case "blocked":
      return { text: `${join(v.escalated)}'s officer must review its delegated limit. Until then the proposal cannot be authorized.`, officer: v.escalated[0] };
    case "reevaluating":
      return { text: `No officer action is needed. ${join(v.stale)}'s agent is deciding again under the new policy.` };
    case "evaluating":
      return { text: "No officer action is needed. Waiting for the agents to decide." };
    case "pending_authorization":
      return { text: "No officer action is needed. The server is checking the current decisions." };
    case "authorized": {
      if (!v.consistent) return { text: "Check the history before relying on this record." };
      const readiness = disputeReadiness(data);
      const debtor = data.obligations.find((o) => o.code === TARGET.obligation)?.debtor;
      if (!v.disputeFiled && readiness.ok && debtor) return { text: `No officer action is needed. ${shortName(v.names, debtor)}'s officer can file a ${money(readiness.cents)} dispute from the invoice evidence.`, evidence: true };
      return { text: "No action is needed." };
    }
    default:
      return undefined;
  }
}

export interface StoryRow { label: string; text: string; detail?: string }
export interface RevisionStory { rows: StoryRow[]; gaps: string[] }

/**
 * Why the current proposal is a revision, stated only where a record proves it: the two proposals,
 * the dispute row and obligation, retained policy versions, current decisions, and audit events.
 * An agent's replaced escalation decision survives only in the audit trail, so the original
 * escalation is claimed only when that event is retained and predates the policy change.
 */
export function explainRevision(data: Session, v: View): RevisionStory {
  const { current, prior } = v;
  if (!current || !prior || !current.hasDisputeExclusions || prior.hasDisputeExclusions) return { rows: [], gaps: [] };
  const nm = (c: Code) => shortName(v.names, c);
  const and = (cs: Code[]) => cs.join(" and ");
  const rows: StoryRow[] = [];
  const gaps: string[] = [];

  const holds = data.disputes.filter((d) => d.createdAt >= prior.createdAt);
  if (holds.length !== 1) return { rows, gaps: [holds.length === 0 ? "No dispute record is available for this revision." : "Several disputes are recorded, so no single cause is stated."] };
  const hold = holds[0];
  const ob = data.obligations.find((o) => o.code === hold.obligationCode);
  if (!ob || ob.disputedCents !== hold.cents) return { rows, gaps: ["The dispute and the obligation's held amount do not match, so no cause is stated."] };

  // 1. The dispute and its effect on the eligible obligation.
  const eligibleAfter = ob.amountCents - ob.disputedCents;
  const owner = hold.filedBy === ob.debtor ? "Its" : `${nm(ob.debtor)}'s`;
  rows.push({ label: "Dispute", text: `${nm(hold.filedBy)} disputed ${money(hold.cents)} of ${ob.code} (invoice line ${hold.lineId}). ${owner} eligible obligation to ${nm(ob.creditor)} fell from ${money(ob.amountCents)} to ${money(eligibleAfter)}.` });

  // 2. Why positions moved. Claimed only when the creditor/debtor shift equals the hold exactly.
  const cb = positionOf(prior, ob.creditor), ca = positionOf(current, ob.creditor);
  const db = positionOf(prior, ob.debtor), da = positionOf(current, ob.debtor);
  const explained = ca - cb === -hold.cents && da - db === hold.cents;
  const gb = grossCents(prior, data.obligations), ga = grossCents(current, data.obligations);
  const nb = transferTotal(prior), na = transferTotal(current);
  const net = (c: number) => (c < 0 ? `a net payment of ${money(-c)}` : `a net receipt of ${money(c)}`);
  const move = cb <= 0 && ca <= 0 ? `its net payment rose from ${money(-cb)} to ${money(-ca)}`
    : cb >= 0 && ca >= 0 ? `its net receipt fell from ${money(cb)} to ${money(ca)}`
    : `its position moved from ${net(cb)} to ${net(ca)}`;
  const because = explained && cb < 0 && ca < 0 && na - nb === hold.cents ? `: less of ${nm(ob.creditor)}'s payable is offset` : "";
  const opposite = (ga < gb) !== (na < nb);
  const word = (after: number, before: number) => (after > before ? "rose" : after < before ? "fell" : "held at");
  const span = (before: number, after: number) => (before === after ? money(after) : `from ${money(before)} to ${money(after)}`);
  const aggregate = `Eligible obligations ${word(ga, gb)} ${span(gb, ga)}, ${opposite ? "yet" : "and"} proposed net transfers ${word(na, nb)} ${span(nb, na)}${because}.`;
  if (!explained) gaps.push("The records do not show that the hold alone explains the change in positions.");
  rows.push({ label: "Effect", text: `${explained ? `${nm(ob.creditor)} is owed ${money(hold.cents)} less, so ${move}. ` : ""}${aggregate}` });

  // 3. Policy changes after the dispute, from retained "granted policy" audit events.
  // "After the dispute" uses the dispute's own audit event when retained, so same-millisecond records still order.
  const disputeEvent = data.audit.find((e) => e.kind === "dispute_filed" && e.message.includes(`V${prior.version} superseded by V${current.version}`));
  const afterDispute = (e: AuditRow) => (disputeEvent ? auditBefore(disputeEvent, e) : e.createdAt > hold.createdAt);
  const grants = data.audit.flatMap((e) => {
    const m = e.kind === "policy_granted" ? /^Company ([ABC]) granted policy v(\d+)$/.exec(e.message) : null;
    return m ? [{ event: e, company: m[1] as Code, version: Number(m[2]) }] : [];
  }).filter((g) => afterDispute(g.event)).sort((a, b) => a.version - b.version);
  const limitOf = (p: Policy | undefined) => (p ? (p.maxNetPayCents ?? p.minNetReceiveCents) : undefined);
  const policyOf = (c: Code, version: number) => data.policies.find((p) => p.company === c && p.version === version);
  const latestVersion = (c: Code) => Math.max(0, ...data.policies.filter((p) => p.company === c).map((p) => p.version));
  const readingOf = (c: Code) => v.decisions.find((d) => d.code === c)!.reading;
  const amended = CODES.filter((c) => grants.some((g) => g.company === c));

  for (const X of CODES) {
    const mine = grants.filter((g) => g.company === X);
    const position = positionOf(current, X);
    const pays = position < 0;
    if (mine.length) {
      const first = mine[0];
      const chain: Array<{ version: number; cents: number }> = [];
      for (let k = first.version - 1; k <= latestVersion(X); k++) {
        const cents = limitOf(policyOf(X, k));
        if (cents !== undefined) chain.push({ version: k, cents });
      }
      const fromPolicy = policyOf(X, first.version - 1);
      const bound = limitOf(fromPolicy);
      const over = fromPolicy ? limitGap(position, fromPolicy) : undefined;
      const escalation = data.audit
        .filter((e) => e.kind === "agent_decided" && e.message.startsWith(`${X} independently escalated V${current.version}`) && auditBefore(e, first.event))
        .sort((a, b) => (auditBefore(a, b) ? -1 : 1))[0];
      const dir = chain.length >= 2 ? (chain[1].cents > chain[0].cents ? "raised" : chain[1].cents < chain[0].cents ? "lowered" : "changed") : "changed";
      let text: string;
      if (escalation && over !== undefined && over > 0 && bound !== undefined) {
        text = `Agent ${X} escalated: ${nm(X)}'s ${money(Math.abs(position))} ${pays ? "payment exceeded" : "receipt fell below"} its ${money(bound)} limit. Its officer then ${dir} the limit.`;
      } else if (escalation) {
        const reasons = escalation.message.split(": ")[1]?.split(", ").map(reasonText).join("; ");
        text = `Agent ${X} escalated${reasons ? ` (${reasons})` : ""}. Its officer then ${dir} the limit.`;
      } else {
        text = `${nm(X)}'s officer changed its limit after the dispute.`;
        gaps.push(`The retained audit trail does not show Agent ${X}'s original escalation, so none is stated.`);
      }
      rows.push({ label: "Limit", text, detail: chain.length >= 2 ? `${firstName(v.names, X)} delegated limit: ${chain.map((c) => `${money(c.cents)} (v${c.version})`).join(" → ")}` : undefined });
    }
  }

  // 4. After the amendment: current decisions and the server's stored status.
  const accepted = amended.filter((c) => readingOf(c).kind === "current_accept");
  const again = amended.filter((c) => readingOf(c).kind === "current_escalate");
  const waiting = amended.filter((c) => ["stale", "missing"].includes(readingOf(c).kind));
  const under = (cs: Code[]) => cs.map((c) => `v${latestVersion(c)}`).join(" and ");
  const parts: string[] = [];
  if (v.reopened) parts.push(`A policy change withdrew V${current.version}'s earlier authorization.`);
  if (accepted.length) {
    const tail = v.phase === "authorized" && v.consistent ? `; the server then authorized V${current.version}.` : v.phase === "pending_authorization" ? "; the server has not yet recorded authorization." : ".";
    parts.push(`Agent ${and(accepted)} re-evaluated under ${under(accepted)} and accepted${tail}`);
  }
  if (again.length) parts.push(`Agent ${and(again)} escalated under ${under(again)}.`);
  if (waiting.length) parts.push(`Agent ${and(waiting)} has not yet decided under ${under(waiting)}.`);
  if (parts.length) rows.push({ label: "Outcome", text: parts.join(" ") });

  return { rows, gaps: [...new Set(gaps)] };
}
