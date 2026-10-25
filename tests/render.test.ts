// Renders the real views to static HTML (react-dom is already a dependency) so visible text can be asserted.
// Guards a class of bug unit tests on pure helpers cannot see: a "{placeholder}" shown to the user because
// an expression was written inside a plain string attribute instead of a template.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { derive, type Session } from "../src/model";
import { Investigation } from "../src/views/Investigation";
import { Officer } from "../src/views/Officer";
import { Overview } from "../src/views/Overview";
import fixture from "./revisionFixture";

const noop = () => {};
const html = (kind: "overview" | "evidence" | "officer", data: Session) => {
  const view = derive(data);
  if (kind === "overview") return renderToStaticMarkup(createElement(Overview, { data, view, onReviewAuthority: noop, onOpenEvidence: noop }));
  if (kind === "evidence") return renderToStaticMarkup(createElement(Investigation, { data, view, token: "", setToken: noop, busy: "", onRun: noop, onFile: noop }));
  return renderToStaticMarkup(createElement(Officer, { data, view, company: "A", onCompany: noop, token: "", setToken: noop, limit: "10000", setLimit: noop, busy: "", onGrant: noop, onDispute: noop, onManual: noop }));
};
const SCENES = ["v1", "blocked", "stale", "pending", "authorized", "noaudit", "reopened", "reopenedwait"];
const PLACEHOLDER = /\{[A-Za-z_][\w.]*\}/;

describe("rendered views show no unresolved placeholders", () => {
  for (const kind of ["overview", "evidence", "officer"] as const) {
    it(`${kind}: no literal {name} in any state`, () => {
      for (const scene of SCENES) expect(html(kind, fixture(scene)), `${kind}/${scene}`).not.toMatch(PLACEHOLDER);
    });
  }
});

describe("Investigation section note", () => {
  it("names the company whose officer can file, using the stored company name", () => {
    const out = html("evidence", fixture("authorized"));
    expect(out).toContain("and only Cedar (C)&#x27;s officer can file it.");
    expect(out).not.toContain("{filer}");
  });

  it("reads correctly for the recorded Gemini investigation", () => {
    const data = fixture("authorized") as any;
    data.candidates = [{ _id: "g", status: "SUPPORTED", claimedCents: 200_000, computedCents: 200_000, rationale: "Quantity billed is 100, but quantity received is only 60.", sourceRefs: ["INV-003:L1", "DEL-003:L1"], modelName: "gemini-3.5-flash-lite", createdAt: 1 }];
    const out = html("evidence", data);
    expect(out).toContain("gemini-3.5-flash-lite");
    expect(out).toContain("Supported");
    expect(out).toContain("and only Cedar (C)&#x27;s officer can file it.");
    expect(out).not.toMatch(PLACEHOLDER);
  });
});
