// Hand-built read models shaped like workflow:getSession, for story/next-step tests. Not shipped.
import type { Session } from "../src/model";
const T = 1_761_380_000_000;
let n = 0;
const ev = (dt: number, kind: string, message: string, actor: string) => ({ _id: "e" + ++n, _creationTime: T + dt + n / 1000, createdAt: T + dt, kind, message, actor, sessionId: "s" });
const inv = [
  { sessionId: "s", obligationCode: "O3", lineId: "L1", quantity: 100, unitPriceCents: 5000, sourceRef: "INV-003:L1" },
  { sessionId: "s", obligationCode: "O3", lineId: "L2", quantity: 70, unitPriceCents: 10000, sourceRef: "INV-003:L2" },
];
const del = [
  { sessionId: "s", obligationCode: "O3", lineId: "L1", received: 60, periodComplete: true, sourceRef: "DEL-003:L1" },
  { sessionId: "s", obligationCode: "O3", lineId: "L2", received: 70, periodComplete: true, sourceRef: "DEL-003:L2" },
];
const dec = (pid: string, company: string, decision: string, version: number, reasons: string[] = [], at = 0) => ({ _id: `d-${pid}-${company}-${version}`, _creationTime: T + at, proposalId: pid, company, decision, reasons, policyVersion: version, decidedAt: T + at });
const OVER = ["PAYMENT_LIMIT_EXCEEDED"];

export default function fixture(scene: string): Session {
  n = 0;
  const hasV2 = scene !== "v1";
  const disputeAt = 7000;
  const authorizedV2 = ["authorized", "noaudit"].includes(scene);
  const amended = ["authorized", "noaudit", "stale", "reopened", "reopenedwait"].includes(scene);
  const v3 = ["reopened", "reopenedwait"].includes(scene);

  const policies: any[] = [
    { company: "A", version: 1, maxNetPayCents: scene === "pending" ? 1_000_000 : 900_000, expiresAt: 1 },
    { company: "B", version: 1, minNetReceiveCents: 400_000, expiresAt: 1 },
    { company: "C", version: 1, minNetReceiveCents: 200_000, expiresAt: 1 },
  ];
  if (amended) policies.push({ company: "A", version: 2, maxNetPayCents: 1_000_000, expiresAt: 1 });
  if (v3) policies.push({ company: "A", version: 3, maxNetPayCents: 900_000, expiresAt: 1 });

  const audit: any[] = [
    ev(0, "session_initialized", "Synthetic obligations and proposal V1 created", "system"),
    ev(1200, "policy_granted", "Company A granted policy v1", "A officer"),
    ev(1230, "agent_decided", "A independently accepted V1", "Agent A"),
    ev(2270, "policy_granted", "Company B granted policy v1", "B officer"),
    ev(2300, "agent_decided", "B independently accepted V1", "Agent B"),
    ev(3330, "policy_granted", "Company C granted policy v1", "C officer"),
    ev(3360, "agent_decided", "C independently accepted V1", "Agent C"),
    ev(3390, "proposal_authorized", "Proposal V1 authorized — no funds transferred", "system"),
  ];
  if (hasV2) {
    audit.push(ev(disputeAt, "dispute_filed", "C officer placed 2000 USD on hold; V1 superseded by V2", "C officer"));
    if (scene !== "noaudit" && scene !== "pending") audit.push(ev(disputeAt + 40, "agent_decided", "A independently escalated V2: PAYMENT_LIMIT_EXCEEDED", "Agent A"));
    audit.push(ev(disputeAt + 40, "agent_decided", "C independently accepted V2", "Agent C"));
    audit.push(ev(disputeAt + 40, "agent_decided", "B independently accepted V2", "Agent B"));
  }
  if (amended) {
    audit.push(ev(10870, "policy_granted", "Company A granted policy v2", "A officer"));
    if (!["stale"].includes(scene)) audit.push(ev(10900, "agent_decided", "A independently accepted V2", "Agent A"));
  }
  if (authorizedV2 || v3) audit.push(ev(10920, "proposal_authorized", "Proposal V2 authorized — no funds transferred", "system"));
  if (v3) {
    audit.push(ev(14000, "authorization_invalidated", "V2 requires fresh authorization after policy change", "system"));
    audit.push(ev(14001, "policy_granted", "Company A granted policy v3", "A officer"));
    if (scene === "reopened") audit.push(ev(14030, "agent_decided", "A independently escalated V2: PAYMENT_LIMIT_EXCEEDED", "Agent A"));
  }

  const decisions: any[] = [dec("p1", "A", "accept", 1), dec("p1", "B", "accept", 1), dec("p1", "C", "accept", 1)];
  if (hasV2) {
    decisions.push(dec("p2", "B", "accept", 1, [], disputeAt + 40), dec("p2", "C", "accept", 1, [], disputeAt + 40));
    if (scene === "authorized" || scene === "noaudit") decisions.push(dec("p2", "A", "accept", 2, [], 10900));
    else if (scene === "pending") decisions.push(dec("p2", "A", "accept", 1, [], disputeAt + 40));
    else if (scene === "stale") decisions.push(dec("p2", "A", "escalate", 1, OVER, disputeAt + 40));
    else if (scene === "reopened") decisions.push(dec("p2", "A", "escalate", 3, OVER, 14030));
    else if (scene === "reopenedwait") decisions.push(dec("p2", "A", "accept", 2, [], 10900));
    else decisions.push(dec("p2", "A", "escalate", 1, OVER, disputeAt + 40));
  }

  return ({
    session: { id: "s", slug: "demo", label: "demo", evidenceVersion: hasV2 ? 2 : 1, currentProposalId: hasV2 ? "p2" : "p1" },
    companies: [{ code: "A", name: "Atlas Manufacturing" }, { code: "B", name: "Beacon Logistics" }, { code: "C", name: "Cedar Components" }],
    obligations: [
      { code: "O1", debtor: "A", creditor: "B", amountCents: 2_000_000, disputedCents: 0 },
      { code: "O2", debtor: "B", creditor: "C", amountCents: 1_500_000, disputedCents: 0 },
      { code: "O3", debtor: "C", creditor: "A", amountCents: 1_200_000, disputedCents: hasV2 ? 200_000 : 0 },
    ],
    proposals: [
      { _id: "p1", version: 1, createdAt: T, status: hasV2 ? "superseded" : "authorized", obligationCodes: ["O1", "O2", "O3"], hasDisputeExclusions: false, evidenceVersion: 1,
        positions: [{ company: "A", cents: -800_000 }, { company: "B", cents: 500_000 }, { company: "C", cents: 300_000 }],
        transfers: [{ from: "A", to: "B", cents: 500_000 }, { from: "A", to: "C", cents: 300_000 }] },
      ...(hasV2 ? [{ _id: "p2", version: 2, createdAt: T + disputeAt + 1, status: authorizedV2 ? "authorized" : "open", obligationCodes: ["O1", "O2", "O3"], hasDisputeExclusions: true, evidenceVersion: 2,
        positions: [{ company: "A", cents: -1_000_000 }, { company: "B", cents: 500_000 }, { company: "C", cents: 500_000 }],
        transfers: [{ from: "A", to: "B", cents: 500_000 }, { from: "A", to: "C", cents: 500_000 }] }] : []),
    ],
    decisions,
    policies,
    audit: audit.sort((a, b) => b.createdAt - a.createdAt),
    candidates: scene === "v1" ? [] : [{ _id: "c", status: "SUPPORTED", claimedCents: 200_000, computedCents: 200_000, rationale: "Manually verified example: 100 invoiced, 60 received, $50/unit", sourceRefs: ["INV-003:L1", "DEL-003:L1"], modelName: "MANUAL_FALLBACK", createdAt: T + 5000 }],
    disputes: hasV2 ? [{ _id: "x", _creationTime: T + disputeAt, sessionId: "s", obligationCode: "O3", lineId: "L1", cents: 200_000, filedBy: "C", createdAt: T + disputeAt }] : [],
    evidence: { invoices: inv, deliveries: del },
  }) as unknown as Session;
}
