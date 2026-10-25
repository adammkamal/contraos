import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { derive } from "../src/model";
import { activityRows, type RunsView } from "../src/investigationActivity";
import { Investigation } from "../src/views/Investigation";
import fixture from "./revisionFixture";

// The runs below have the exact shape `investigate:runsForSession` returns. They are hand-built records for rendering
// tests; they are not output of a live model.
const T = 1_761_380_000_000;
const ev = (seq: number, e: Partial<RunsView["events"][number]> & Pick<RunsView["events"][number], "kind">): RunsView["events"][number] =>
  ({ id: "e" + seq, runId: "run1", seq, at: T + seq, ...e }) as never;
const events = [
  ev(1, { kind: "tool_requested", toolName: "getInvoiceLines", args: { obligationCode: "O3", lineId: "L1" }, allowed: true }),
  ev(2, { kind: "tool_result", toolName: "getInvoiceLines", args: { obligationCode: "O3", lineId: "L1" }, allowed: true, refs: ["INV-003:L1"] }),
  ev(3, { kind: "tool_requested", toolName: "(unknown)", allowed: false, reason: "UNKNOWN_TOOL" }),
  ev(4, { kind: "tool_requested", toolName: "getDeliveryRecords", args: { obligationCode: "O3", lineId: "L1" }, allowed: true }),
  ev(5, { kind: "tool_result", toolName: "getDeliveryRecords", args: { obligationCode: "O3", lineId: "L1" }, allowed: true, refs: ["DEL-003:L1"] }),
  ev(6, { kind: "candidate_proposed", toolName: "submitFinding", args: { lineId: "L1", claimedCents: 200000 }, allowed: true, refs: ["INV-003:L1", "DEL-003:L1"] }),
  ev(7, { kind: "validation", reason: "SUPPORTED", detail: "Invoice quantity exceeds completed-period received quantity" }),
];
const run = (status: RunsView["runs"][number]["status"]) => ({ id: "run1", mode: "tool_using_gemini", provider: "gemini", model: "gemini-3.5-flash-lite", status, turns: 4, toolRequests: 4, startedAt: T, finishedAt: T + 9 }) as never;
const html = (scene: string, runs?: RunsView) => {
  const data = fixture(scene); const view = derive(data);
  return renderToStaticMarkup(createElement(Investigation, { data, view, token: "", setToken: () => {}, busy: "", onRun: () => {}, onRunTools: () => {}, onFile: () => {}, runs }));
};

describe("Investigation activity panel is driven only by persisted run events", () => {
  it("renders exactly one row per recorded event, in recorded order, plus a derived human-action row", () => {
    const out = html("blocked", { runs: [run("completed")], events });
    const panel = out.slice(out.indexOf('aria-label="Investigation activity"'));
    expect((panel.match(/class="audit__item/g) ?? []).length).toBe(events.length + 1);
    const order = ["Evidence requested by the model", "Tool result returned by the server", "Request refused by the server", "Candidate proposed by the model", "Server validation", "Human action"].map((t) => panel.indexOf(t));
    expect(order.every((i, n) => i > -1 && (n === 0 || i > order[n - 1]))).toBe(true);
    expect(panel).toContain("getInvoiceLines(O3, L1)");
    expect(panel).toContain("tool is not on the server&#x27;s allowlist");
    expect(panel).toContain("L1 · $2,000 claimed");
    expect(panel).toContain("Tool-using Gemini run");
  });
  it("shows no rows, and no fabricated steps, when nothing has been recorded", () => {
    const out = html("blocked", { runs: [], events: [] });
    expect(out).toContain("No tool-using run has been recorded for this session yet");
    expect(out).not.toContain("Evidence requested");
    expect(html("blocked")).not.toContain("Investigation activity");
  });
  it("a stale or stopped run shows its stop reason and offers no human action", () => {
    const stopped = [ev(1, { kind: "tool_requested", toolName: "getInvoiceLines", args: { obligationCode: "O3" }, allowed: true }), ev(2, { kind: "stopped", reason: "EVIDENCE_CHANGED" })];
    const out = html("blocked", { runs: [run("stale")], events: stopped });
    expect(out).toContain("Stale evidence"); expect(out).toContain("records changed during the run");
    expect(out).not.toContain("Human action");
  });
  it("only a SUPPORTED, completed run shows the human-action row; a filed dispute turns it into completed", () => {
    const rows = (disputeFiled: boolean, supported = true) => activityRows(events, { disputeFiled, filer: "Cedar", supported }).map((r) => r.title);
    expect(rows(false).at(-1)).toBe("Human action required");
    expect(rows(true).at(-1)).toBe("Human action completed");
    expect(rows(false, false)).not.toContain("Human action required");
  });
  it("labels each result by how it was produced and marks stale candidates as unfileable", () => {
    const data = fixture("authorized") as any;
    const cand = (mode: string | undefined, status = "SUPPORTED", modelName = "gemini-3.5-flash-lite") => ({ _id: "c", status, claimedCents: 200000, computedCents: status === "SUPPORTED" ? 200000 : undefined, rationale: "r", sourceRefs: ["INV-003:L1"], modelName, createdAt: 1, mode });
    const view = (c: object) => { const d = { ...data, candidates: [c] }; return renderToStaticMarkup(createElement(Investigation, { data: d, view: derive(d), token: "", setToken: () => {}, busy: "", onRun: () => {}, onRunTools: () => {}, onFile: () => {} })); };
    expect(view(cand("tool_using_gemini"))).toContain("Tool-using Gemini run");
    expect(view(cand("single_pass_gemini"))).toContain("Single-pass provider finding");
    expect(view(cand("manual_fallback", "SUPPORTED", "MANUAL_FALLBACK"))).toContain("Manual entry · not an AI result");
    expect(view(cand(undefined))).toContain("Recorded provider finding");
    expect(view(cand("tool_using_gemini", "STALE_EVIDENCE"))).toContain("marked stale and cannot be filed");
  });
  it("offers both investigators as explicit, separate actions", () => {
    const out = html("blocked");
    expect(out).toContain("Run tool-using investigator"); expect(out).toContain("Run single-pass investigator");
  });
});
