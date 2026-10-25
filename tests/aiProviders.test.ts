import { describe, expect, it } from "vitest";
import { requestInvestigation, resolveProviderConfig, type ProviderSettings } from "../convex/lib/aiProviders";

const evidence = { invoices: [{ lineId: "L1", qtyBilled: 100, unitPriceCents: 5000, sourceRef: "INV-003:L1" }], deliveries: [{ lineId: "L1", qtyReceived: 60, periodComplete: true, sourceRef: "DEL-003:L1" }] };
const candidate = { candidates: [{ lineId: "L1", claimedCents: 200000, rationale: "40 short units at $50" }] };

describe("provider switching", () => {
  it("defaults to Gemini and selects Claude only explicitly", () => {
    expect(resolveProviderConfig({ GEMINI_API_KEY: "fake" }).settings?.provider).toBe("gemini");
    expect(resolveProviderConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "fake" }).settings?.provider).toBe("anthropic");
    expect(resolveProviderConfig({ AI_PROVIDER: "anthropic", GEMINI_API_KEY: "fake" }).error).toBe("NOT_CONFIGURED");
    expect(resolveProviderConfig({ AI_PROVIDER: "invalid" }).error).toBe("INVALID_PROVIDER");
  });
  it.each(["gemini", "anthropic"] as const)("parses %s suggestions and keeps secrets out of request bodies", async provider => {
    const config: ProviderSettings = { provider, model: provider === "gemini" ? "gemini-2.5-flash" : "claude-haiku-5-5", apiKey: "fake-secret" };
    let url = "", body = "";
    const mock: typeof fetch = async (input, options) => {
      url = String(input); body = String(options?.body);
      const response = provider === "gemini" ? { candidates: [{ content: { parts: [{ text: JSON.stringify(candidate) }] } }] } : { content: [{ type: "text", text: JSON.stringify(candidate) }] };
      return new Response(JSON.stringify(response), { status: 200 });
    };
    expect(await requestInvestigation(config, evidence, mock)).toEqual({ status: "OK", candidates: candidate.candidates });
    expect(url).toContain(provider === "gemini" ? "generativelanguage.googleapis.com" : "api.anthropic.com");
    expect(body).not.toContain("fake-secret");
    expect(body).not.toContain("officerToken");
    expect(body).toContain("INV-003:L1");
  });
  it("reports provider errors without switching services", async () => {
    let calls = 0;
    const mock: typeof fetch = async () => { calls++; return new Response("{}", { status: 429 }); };
    const result = await requestInvestigation({ provider: "gemini", model: "gemini-2.5-flash", apiKey: "fake" }, evidence, mock);
    expect(result.status).toBe("MODEL_ERROR");
    expect(calls).toBe(1);
  });
  it("rejects invalid model JSON", async () => {
    const mock: typeof fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "bad data" }] } }] }), { status: 200 });
    expect((await requestInvestigation({ provider: "gemini", model: "gemini-2.5-flash", apiKey: "fake" }, evidence, mock)).status).toBe("INVALID_OUTPUT");
  });
});
