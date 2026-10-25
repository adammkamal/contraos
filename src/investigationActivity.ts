import type { FunctionReturnType } from "convex/server";
import type { api } from "../convex/_generated/api";
import { money } from "./model";

/** Sanitized run history as stored by the server (no prompts, credentials or provider content). */
export type RunsView = FunctionReturnType<typeof api.investigate.runsForSession>;
export type RunRecord = RunsView["runs"][number];
export type RunEvent = RunsView["events"][number];
export type ActivityRow = { key: string; tone: "ok" | "warn" | "info"; title: string; detail: string };

const REASONS: Record<string, string> = {
  UNKNOWN_TOOL: "tool is not on the server's allowlist",
  UNEXPECTED_ARGUMENT: "arguments outside the allowed set",
  INVALID_ARGUMENT: "invalid arguments",
  DUPLICATE_REQUEST: "repeated request",
  EVIDENCE_NOT_RETRIEVED: "evidence had not been read yet",
  CITATION_NOT_RETRIEVED: "cited a record that was never retrieved", CITATION_REQUIRED: "citations must name the invoice and delivery records for the proposed line", EVIDENCE_TOO_LARGE: "the evidence set is too large to validate exactly",
  RESULT_TOO_LARGE: "result exceeded the size budget",
  TOO_MANY_PARALLEL_CALLS: "too many calls in one turn",
  UNKNOWN_OBLIGATION: "obligation not found in this session",
  SUPPORTED: "supported", UNSUPPORTED: "not supported", INSUFFICIENT_EVIDENCE: "insufficient evidence", INVALID_INPUT: "invalid input", STALE_EVIDENCE: "stale evidence",
  INVALID_CREDENTIAL: "the configured Gemini credential is not usable (nothing was sent)", TIMEOUT: "the provider did not answer in time", RATE_LIMITED: "the provider rate limit was reached", INVALID_OUTPUT: "the provider response was unusable",
  MODEL_ERROR: "the provider returned an error", NETWORK_ERROR: "the provider was unreachable", NO_FUNCTION_CALL: "the model replied without a tool call",
  TURN_LIMIT_EXCEEDED: "the turn budget was used up", TOOL_BUDGET_EXHAUSTED: "the tool-request budget was used up", REPEATED_INVALID_REQUESTS: "too many refused requests",
  DURATION_EXCEEDED: "the time budget was used up", EVIDENCE_CHANGED: "records changed during the run", EXECUTOR_ERROR: "a tool returned an unexpected shape",
  RUN_NOT_ACTIVE: "the run was no longer active", ACTION_INTERRUPTED: "the run was interrupted", UNEXPECTED_ERROR: "an unexpected error",
};
export const reasonText = (code?: string) => (code ? REASONS[code] ?? code.toLowerCase().replaceAll("_", " ") : "");

const call = (e: RunEvent) => `${e.toolName ?? "tool"}(${Object.values(e.args ?? {}).join(", ")})`;

/** One row per recorded event, in the order the server recorded them. Nothing is inferred or invented. */
export function activityRows(events: RunEvent[], ctx: { disputeFiled: boolean; filer: string; supported: boolean }): ActivityRow[] {
  const rows: ActivityRow[] = [...events].sort((a, b) => a.seq - b.seq).map((e) => {
    const key = e.id;
    switch (e.kind) {
      case "tool_requested":
        return e.allowed === false
          ? { key, tone: "warn", title: "Request refused by the server", detail: `${e.toolName === "(unknown)" ? "Unknown tool" : call(e)} · ${reasonText(e.reason)}` }
          : { key, tone: "info", title: "Evidence requested by the model", detail: call(e) };
      case "tool_result":
        return e.allowed === false
          ? { key, tone: "warn", title: "Tool result not used", detail: `${call(e)} · ${reasonText(e.reason)}` }
          : { key, tone: "ok", title: "Tool result returned by the server", detail: `${call(e)}${e.refs?.length ? " · " + e.refs.join(", ") : ""}${e.detail ? " · " + e.detail : ""}` };
      case "candidate_proposed":
        return { key, tone: "info", title: "Candidate proposed by the model", detail: `${e.args?.lineId ?? ""} · ${typeof e.args?.claimedCents === "number" ? money(e.args.claimedCents) : ""} claimed${e.refs?.length ? " · cited " + e.refs.join(", ") : ""}` };
      case "no_finding_proposed":
        return { key, tone: "info", title: "Model proposed no finding", detail: e.detail ?? "" };
      case "validation":
        return { key, tone: e.reason === "SUPPORTED" ? "ok" : "warn", title: "Server validation", detail: `${reasonText(e.reason)}${e.detail ? " · " + e.detail : ""}` };
      case "stopped":
        return { key, tone: "warn", title: "Run stopped", detail: reasonText(e.reason) };
    }
  });
  if (ctx.supported) {
    rows.push(ctx.disputeFiled
      ? { key: "human", tone: "ok", title: "Human action completed", detail: `A dispute is on file, filed by ${ctx.filer}'s officer.` }
      : { key: "human", tone: "info", title: "Human action required", detail: `Only ${ctx.filer}'s officer can file the dispute. The investigator cannot.` });
  }
  return rows;
}

export const runStatusLabel: Record<RunRecord["status"], { tone: "info" | "ok" | "warn" | "idle"; label: string }> = {
  running: { tone: "info", label: "Running" },
  completed: { tone: "ok", label: "Completed" },
  no_finding: { tone: "idle", label: "No finding" },
  stale: { tone: "warn", label: "Stale evidence" },
  failed: { tone: "warn", label: "Stopped" },
  interrupted: { tone: "warn", label: "Interrupted" },
};
