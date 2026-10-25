import { describe, expect, it } from "vitest";
import { derive, type Session } from "../src/model";
import { actorLabel, auditNewestFirst, changeText, explainRevision, historyNote, nextStep, shortName } from "../src/story";
import fixture from "./revisionFixture";

const story = (scene: string, tweak?: (d: any) => void) => {
  const data = fixture(scene) as any;
  tweak?.(data);
  const d = data as Session;
  return { data: d, v: derive(d), story: explainRevision(d, derive(d)), next: nextStep(d, derive(d)) };
};
const labels = (s: { story: { rows: Array<{ label: string }> } }) => s.story.rows.map((r) => r.label);
const row = (s: { story: { rows: Array<{ label: string; text: string; detail?: string }> } }, label: string) => s.story.rows.find((r) => r.label === label);

describe("explainRevision: authorized V2 after the officer amendment", () => {
  const s = story("authorized");

  it("tells the four-step cause, each derived from records", () => {
    expect(labels(s)).toEqual(["Dispute", "Effect", "Limit", "Outcome"]);
    expect(row(s, "Dispute")!.text).toBe("Cedar (C) disputed $2,000 of O3 (invoice line L1). Its eligible obligation to Atlas (A) fell from $12,000 to $10,000.");
    expect(row(s, "Effect")!.text).toContain("Atlas (A) is owed $2,000 less, so its net payment rose from $8,000 to $10,000.");
    expect(row(s, "Effect")!.text).toContain("Eligible obligations fell from $47,000 to $45,000, yet proposed net transfers rose from $8,000 to $10,000");
    expect(row(s, "Effect")!.text).toContain("less of Atlas (A)'s payable is offset");
  });

  it("shows the policy transition and the escalation it answered", () => {
    expect(row(s, "Limit")!.text).toBe("Agent A escalated: Atlas (A)'s $10,000 payment exceeded its $9,000 limit. Its officer then raised the limit.");
    expect(row(s, "Limit")!.detail).toBe("Atlas delegated limit: $9,000 (v1) → $10,000 (v2)");
  });

  it("says the agent re-evaluated and the server authorized, with no execution claim", () => {
    expect(row(s, "Outcome")!.text).toBe("Agent A re-evaluated under v2 and accepted; the server then authorized V2.");
    expect(JSON.stringify(s.story)).not.toMatch(/paid|settled|savings|executed/i);
    expect(s.story.gaps).toEqual([]);
  });
});

describe("explainRevision: states where events have not happened", () => {
  it("shows no story for V1 before any dispute", () => {
    expect(story("v1").story).toEqual({ rows: [], gaps: [] });
  });

  it("shows only the dispute and its effect while V2 is blocked; the status line carries the limit", () => {
    const s = story("blocked");
    expect(labels(s)).toEqual(["Dispute", "Effect"]);
  });

  it("claims no escalation or amendment when an old $9,000 policy exists but nothing was recorded", () => {
    const s = story("pending");
    expect(labels(s)).toEqual(["Dispute", "Effect"]);
    expect(JSON.stringify(s.story)).not.toMatch(/escalated|limit/i);
  });

  it("does not call an accepted-but-unauthorized V2 authorized", () => {
    const s = story("pending");
    expect(s.v.phase).toBe("pending_authorization");
    expect(row(s, "Outcome")).toBeUndefined();
  });
});

describe("explainRevision: evidence gaps are reported, not filled", () => {
  it("omits the original escalation when its audit event is not retained", () => {
    const s = story("noaudit");
    expect(row(s, "Limit")!.text).toBe("Atlas (A)'s officer changed its limit after the dispute.");
    expect(row(s, "Limit")!.text).not.toMatch(/escalated/);
    expect(row(s, "Limit")!.detail).toBe("Atlas delegated limit: $9,000 (v1) → $10,000 (v2)");
    expect(s.story.gaps).toEqual(["The retained audit trail does not show Agent A's original escalation, so none is stated."]);
  });

  it("ignores an escalation event that came after the policy change", () => {
    const s = story("authorized", (d) => {
      for (const e of d.audit) if (e.message.startsWith("A independently escalated V2")) e.createdAt = d.audit.find((x: any) => x.message === "Company A granted policy v2").createdAt + 5;
    });
    expect(row(s, "Limit")!.text).not.toMatch(/escalated/);
  });

  it("states nothing about cause when several disputes exist", () => {
    const s = story("authorized", (d) => d.disputes.push({ ...d.disputes[0], _id: "y" }));
    expect(s.story.rows).toEqual([]);
    expect(s.story.gaps[0]).toMatch(/Several disputes/);
  });

  it("states nothing when the hold does not match the obligation", () => {
    const s = story("authorized", (d) => { d.obligations[2].disputedCents = 100_000; });
    expect(s.story.rows).toEqual([]);
    expect(s.story.gaps[0]).toMatch(/do not match/);
  });

  it("drops the causal sentence when positions do not shift by exactly the hold", () => {
    const s = story("authorized", (d) => { d.proposals[1].positions[0].cents = -1_100_000; });
    expect(row(s, "Effect")!.text).not.toMatch(/is owed/);
    expect(s.story.gaps).toContain("The records do not show that the hold alone explains the change in positions.");
  });

  it("shows no story for a revision with no V1, or a superseded record", () => {
    expect(story("v1").story.rows).toEqual([]);
  });
});

describe("explainRevision: authorization withdrawn by a later policy change", () => {
  it("reports the withdrawal, the full limit chain, and the renewed escalation", () => {
    const s = story("reopened");
    expect(s.v.reopened).toBe(true);
    expect(row(s, "Limit")!.detail).toBe("Atlas delegated limit: $9,000 (v1) → $10,000 (v2) → $9,000 (v3)");
    expect(row(s, "Outcome")!.text).toBe("A policy change withdrew V2's earlier authorization. Agent A escalated again under v3.");
  });

  it("says the agent has not yet decided while the stale decision is pending", () => {
    const s = story("reopenedwait");
    expect(s.v.phase).toBe("reevaluating");
    expect(row(s, "Outcome")!.text).toBe("A policy change withdrew V2's earlier authorization. Agent A has not yet decided under v3.");
  });

  it("keeps the earlier authorization visible in history rather than erasing it", () => {
    const s = story("reopened");
    expect(s.data.audit.some((e) => e.message.startsWith("Proposal V2 authorized"))).toBe(true);
    expect(s.data.audit.some((e) => e.kind === "authorization_invalidated")).toBe(true);
  });
});

describe("nextStep names who must act, and never offers execution", () => {
  it("blocked: the escalating company's officer", () => {
    const n = story("blocked").next!;
    expect(n.officer).toBe("A");
    expect(n.text).toBe("Atlas (A)'s officer must review its delegated limit. Until then the proposal cannot be authorized.");
  });

  it("policy changed: no officer action, the agent is deciding again", () => {
    for (const scene of ["stale", "reopenedwait"]) {
      const n = story(scene).next!;
      expect(n.officer).toBeUndefined();
      expect(n.text).toBe("No officer action is needed. Atlas (A)'s agent is deciding again under the new policy.");
    }
  });

  it("no current authorization yet: the server is checking", () => {
    expect(story("pending").next!.text).toBe("No officer action is needed. The server is checking the current decisions.");
  });

  it("V1 authorized with supportable evidence: the debtor's officer may file a dispute", () => {
    const n = story("v1").next!;
    expect(n.evidence).toBe(true);
    expect(n.text).toBe("No officer action is needed. Cedar (C)'s officer can file a $2,000 dispute from the invoice evidence.");
  });

  it("V2 authorized: nothing to do, and no execute wording anywhere", () => {
    const n = story("authorized").next!;
    expect(n.text).toBe("No action is needed.");
    for (const scene of ["v1", "blocked", "stale", "pending", "authorized", "reopened"]) expect(story(scene).next?.text ?? "").not.toMatch(/execut|send|pay out|release/i);
  });
});

describe("wording helpers", () => {
  const names = { A: "Atlas Manufacturing", B: "Beacon Logistics", C: "Cedar Components" };

  it("uses Pays/Receives instead of bare signs in the change column", () => {
    expect(changeText(-800_000, -1_000_000)).toBe("Pays $2,000 more");
    expect(changeText(-1_000_000, -800_000)).toBe("Pays $2,000 less");
    expect(changeText(300_000, 500_000)).toBe("Receives $2,000 more");
    expect(changeText(500_000, 300_000)).toBe("Receives $2,000 less");
    expect(changeText(500_000, 500_000)).toBe("None");
    expect(changeText(-100_000, 150_000)).toBe("+$2,500");
  });

  it("derives names from the stored company names", () => {
    expect(shortName(names, "A")).toBe("Atlas (A)");
    expect(actorLabel("A officer", names)).toBe("Atlas officer");
    expect(actorLabel("Agent C", names)).toBe("Cedar agent");
    expect(actorLabel("system", names)).toBe("System");
  });
});

describe("audit ordering", () => {
  const e = (id: string, createdAt: number, _creationTime: number) => ({ _id: id, createdAt, _creationTime }) as never;

  it("orders newest first by recorded time", () => {
    expect(auditNewestFirst([e("old", 1, 1), e("new", 2, 2)]).map((x: any) => x._id)).toEqual(["new", "old"]);
  });

  it("breaks same-millisecond ties by creation order, newest first", () => {
    const tied = [e("first", 5, 100.1), e("second", 5, 100.2), e("third", 5, 100.3)];
    expect(auditNewestFirst(tied).map((x: any) => x._id)).toEqual(["third", "second", "first"]);
  });

  it("does not drop or invent records", () => {
    const s = story("authorized");
    expect(auditNewestFirst(s.data.audit)).toHaveLength(s.data.audit.length);
  });
});

describe('history note', () => {
  it('says all events are shown only when the window is not full', () => {
    expect(historyNote(18)).toContain('Showing all 18 events recorded for this session.');
    expect(historyNote(1)).toContain('Showing all 1 event recorded');
  });

  it('does not present a full audit window as complete lifetime history', () => {
    const note = historyNote(30);
    expect(note).toContain('Showing the 30 most recent events; earlier events are not included in this view.');
    expect(note).not.toMatch(/all 30/);
  });

  it('never prints a "Not stated" disclaimer for omitted history', () => {
    const rendered = JSON.stringify(explainRevision(fixture('noaudit') as never, derive(fixture('noaudit') as never)).rows);
    expect(rendered).not.toMatch(/not stated|retained audit/i);
  });
});
