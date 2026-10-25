import { describe, expect, it, vi } from "vitest";
import { DECLARATIONS, geminiTurn, functionResponseTurn, type GeminiContent } from "../convex/lib/geminiTools";

// These tests use MOCKED provider responses shaped like the documented generateContent wire format.
// They prove how this adapter builds requests and parses/echoes messages, not how a live model behaves.
const settings = { model: "gemini-3.5-flash-lite", apiKey: "fake-key-never-in-bodies" };
const user: GeminiContent = { role: "user", parts: [{ text: "Investigate obligation O3" }] };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const modelContent = { role: "model", parts: [
  { functionCall: { id: "call-1", name: "getInvoiceLines", args: { obligationCode: "O3" } }, thoughtSignature: "c2lnLTE=" },
  { functionCall: { id: "call-2", name: "getDeliveryRecords", args: { obligationCode: "O3" } } },
] };

describe("Gemini function-calling adapter (mocked wire format)", () => {
  it("sends declared read tools, forces a function call, keeps the key out of the body", async () => {
    let url = "", init: RequestInit | undefined;
    const fetcher: typeof fetch = async (u, i) => { url = String(u); init = i; return reply({ candidates: [{ content: modelContent, finishReason: "STOP" }] }); };
    await geminiTurn(settings, [user], { fetcher });
    const body = JSON.parse(String(init?.body));
    expect(url).toContain("/models/gemini-3.5-flash-lite:generateContent");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(settings.apiKey);
    expect(String(init?.body)).not.toContain(settings.apiKey);
    expect(body.tools[0].functionDeclarations.map((d: { name: string }) => d.name)).toEqual(["getObligation", "getInvoiceLines", "getDeliveryRecords", "submitFinding", "submitNoFinding"]);
    expect(body.toolConfig.functionCallingConfig).toMatchObject({ mode: "ANY" });
    // No tool can write: nothing in the declarations names a mutation, URL, file or credential.
    expect(JSON.stringify(DECLARATIONS)).not.toMatch(/officerToken|sessionId|policy|authorize|payment|url|file/i);
  });

  it("parses parallel function calls and keeps the model content verbatim, including the thought signature and ids", async () => {
    const r = await geminiTurn(settings, [user], { fetcher: async () => reply({ candidates: [{ content: modelContent }] }) });
    expect(r.status).toBe("OK");
    if (r.status !== "OK") return;
    expect(r.calls).toEqual([{ id: "call-1", name: "getInvoiceLines", args: { obligationCode: "O3" } }, { id: "call-2", name: "getDeliveryRecords", args: { obligationCode: "O3" } }]);
    expect(r.content).toEqual(modelContent); // unchanged, signature included
  });

  it("echoes the previous model content unchanged and answers every call by id and name on the next request", async () => {
    const bodies: Array<{ contents: GeminiContent[] }> = [];
    const fetcher: typeof fetch = async (_u, i) => { bodies.push(JSON.parse(String(i?.body))); return reply({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "submitNoFinding", args: { reason: "x" } } }] } }] }); };
    const first = await geminiTurn(settings, [user], { fetcher: async () => reply({ candidates: [{ content: modelContent }] }) });
    if (first.status !== "OK") throw new Error("setup");
    const answers = functionResponseTurn(first.calls.map(c => ({ id: c.id, name: c.name, response: { ok: true } })));
    await geminiTurn(settings, [user, first.content, answers], { fetcher });
    const sent = bodies[0].contents;
    expect(sent[1]).toEqual(modelContent);
    expect(sent[2].parts).toEqual([
      { functionResponse: { id: "call-1", name: "getInvoiceLines", response: { ok: true } } },
      { functionResponse: { id: "call-2", name: "getDeliveryRecords", response: { ok: true } } },
    ]);
  });

  it("omits an id on the response when the model supplied none (sequential call without ids)", () => {
    expect(functionResponseTurn([{ name: "getObligation", response: { ok: true } }]).parts).toEqual([{ functionResponse: { name: "getObligation", response: { ok: true } } }]);
  });

  it("retries once on 429 then succeeds; a second 429 is reported as RATE_LIMITED (bounded retries)", async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const ok = await geminiTurn(settings, [user], { sleep, fetcher: async () => (++calls === 1 ? reply({}, 429) : reply({ candidates: [{ content: modelContent }] })) });
    expect(ok.status).toBe("OK"); expect(calls).toBe(2); expect(sleep).toHaveBeenCalledTimes(1);
    calls = 0;
    const limited = await geminiTurn(settings, [user], { sleep, fetcher: async () => { calls++; return reply({}, 429); } });
    expect(limited).toMatchObject({ status: "RATE_LIMITED" }); expect(calls).toBe(2);
  });

  it("reports a timeout when the request is aborted, without retrying", async () => {
    let calls = 0;
    const fetcher: typeof fetch = (_u, i) => new Promise((_res, rej) => { calls++; i?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
    const r = await geminiTurn(settings, [user], { fetcher, timeoutMs: 20 });
    expect(r).toMatchObject({ status: "TIMEOUT" }); expect(calls).toBe(1);
  });

  it.each([
    ["non-JSON body", () => new Response("not json", { status: 200 }), "INVALID_OUTPUT"],
    ["oversized body", () => new Response("x".repeat(200_000), { status: 200 }), "INVALID_OUTPUT"],
    ["no candidates", () => reply({ candidates: [] }), "INVALID_OUTPUT"],
    ["empty parts", () => reply({ candidates: [{ content: { role: "model", parts: [] } }] }), "INVALID_OUTPUT"],
    ["function call without a name", () => reply({ candidates: [{ content: { role: "model", parts: [{ functionCall: { args: {} } }] } }] }), "INVALID_OUTPUT"],
    ["MALFORMED_FUNCTION_CALL finish", () => reply({ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }] }), "INVALID_OUTPUT"],
    ["MISSING_THOUGHT_SIGNATURE finish", () => reply({ candidates: [{ finishReason: "MISSING_THOUGHT_SIGNATURE" }] }), "MODEL_ERROR"],
    ["blocked prompt", () => reply({ promptFeedback: { blockReason: "SAFETY" } }), "MODEL_ERROR"],
    ["HTTP 500", () => reply({}, 500), "MODEL_ERROR"],
  ])("fails closed on %s", async (_label, make, status) => {
    const r = await geminiTurn(settings, [user], { fetcher: async () => make() });
    expect(r.status).toBe(status);
    expect(JSON.stringify(r)).not.toContain(settings.apiKey);
  });

  it("reads provider token usage; provider error text is NOT retained or surfaced (it can echo request data)", async () => {
    const ok = await geminiTurn(settings, [user], { fetcher: async () => reply({ candidates: [{ content: modelContent }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 12, totalTokenCount: 162 } }) });
    expect(ok.status === "OK" && ok.usage).toEqual({ promptTokens: 120, outputTokens: 30, thoughtsTokens: 12, totalTokens: 162 });
    const bad = await geminiTurn(settings, [user], { fetcher: async () => reply({ error: { code: 400, message: "Invalid JSON payload received. Unknown name \"foo\" at 'tools[0]'", status: "INVALID_ARGUMENT" } }, 400) });
    expect(bad).toMatchObject({ status: "MODEL_ERROR" });
    expect((bad as { message: string }).message).toBe("gemini returned HTTP 400");
    expect(JSON.stringify(bad)).not.toMatch(/Invalid JSON payload|foo/);
    // even when the provider echoes the credential back in its error body
    const echo = await geminiTurn(settings, [user], { fetcher: async () => reply({ error: { message: "bad credential " + settings.apiKey } }, 400) });
    expect(JSON.stringify(echo)).not.toContain(settings.apiKey);
  });

  it("[MEDIUM #5] the timeout stays active while the response BODY is read: headers-then-stall times out", async () => {
    const fetcher: typeof fetch = async (_u, init) => ({
      ok: true, status: 200, body: null,
      text: () => new Promise<string>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    }) as unknown as Response;
    const t0 = Date.now();
    const r = await geminiTurn(settings, [user], { fetcher, timeoutMs: 40 });
    expect(r.status).toBe("TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("a stalled body on an error response is never read at all", async () => {
    let read = false;
    const fetcher: typeof fetch = async () => ({ ok: false, status: 500, body: null, text: async () => { read = true; return "{}"; } }) as unknown as Response;
    expect((await geminiTurn(settings, [user], { fetcher })).status).toBe("MODEL_ERROR");
    expect(read).toBe(false);
  });

  it("a response carrying an absurd number of function calls is refused while parsing", async () => {
    const parts = Array.from({ length: 200 }, (_, i) => ({ functionCall: { name: "getObligation", args: { obligationCode: "O" + (i % 9) } } }));
    expect((await geminiTurn(settings, [user], { fetcher: async () => reply({ candidates: [{ content: { role: "model", parts } }] }) })).status).toBe("INVALID_OUTPUT");
  });

  it("maps a network failure to NETWORK_ERROR without leaking details", async () => {
    const r = await geminiTurn(settings, [user], { fetcher: async () => { throw new Error("boom " + settings.apiKey); } });
    expect(r.status).toBe("NETWORK_ERROR");
    expect(JSON.stringify(r)).not.toContain(settings.apiKey);
  });
});
