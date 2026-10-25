import { describe, expect, it, vi } from "vitest";
import { normalizeApiKey, requestInvestigation, resolveProviderConfig } from "../convex/lib/aiProviders";
import { geminiTurn } from "../convex/lib/geminiTools";

/*
 * Offline reproduction of the live failure: the stored Gemini key carried a trailing carriage return, and fetch rejected
 * the header value ("Header x-goog-api-key has an invalid value") before any request left the machine.
 * All credentials here are synthetic.
 */
const KEY = "AQ.synthetic-credential_0123456789-abcdefghijklmnop"; // 'AQ.' style: letters, digits, dot, dash, underscore
const user = [{ role: "user" as const, parts: [{ text: "Investigate obligation O3" }] }];
const ok = () => new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "submitNoFinding", args: { reason: "x" } } }] } }] }));

/** A fetch stub that refuses header values the way the real runtime does (no CR, LF or other control characters). */
function strictFetch() {
  const seen: string[] = [];
  const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const value = (init?.headers as Record<string, string>)["x-goog-api-key"];
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("Header `x-goog-api-key` has an invalid value");
    seen.push(value);
    return ok();
  });
  return { f: f as unknown as typeof fetch, spy: f, seen };
}

describe("the original failure, reproduced offline", () => {
  it("the stub is faithful: a raw key with a trailing CR is rejected when sent as-is", async () => {
    const { f } = strictFetch();
    await expect(f("https://example.invalid", { headers: { "x-goog-api-key": KEY + "\r" } })).rejects.toThrow(/invalid value/);
  });
  it("with the fix, a trailing-CR key builds a valid request and the model turn succeeds", async () => {
    const { f, seen } = strictFetch();
    const r = await geminiTurn({ model: "gemini-3.5-flash-lite", apiKey: KEY + "\r" }, user, { fetcher: f });
    expect(r.status).toBe("OK");
    expect(seen).toEqual([KEY]); // exactly the credential, without the carriage return
  });
  it("end to end through configuration: AI_PROVIDER=gemini with a CR-terminated key resolves to the clean key", () => {
    const c = resolveProviderConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: KEY + "\r" });
    expect(c.settings?.apiKey).toBe(KEY);
    expect(c.error).toBeUndefined();
  });
});

describe("normalizeApiKey", () => {
  it.each([
    ["trailing CR", KEY + "\r"], ["trailing CRLF", KEY + "\r\n"], ["trailing LF", KEY + "\n"],
    ["leading and trailing whitespace", " \t " + KEY + " \r\n\t "], ["leading newline", "\n" + KEY],
  ])("trims %s and leaves the credential's own characters untouched", (_n, raw) => {
    expect(normalizeApiKey(raw)).toEqual({ ok: true, key: KEY });
  });
  it("returns a valid credential unchanged, including interior characters", () => {
    expect(normalizeApiKey(KEY)).toEqual({ ok: true, key: KEY });
    expect(normalizeApiKey("a b.c-d_e")).toEqual({ ok: true, key: "a b.c-d_e" }); // interior content is never rewritten
  });
  it.each([
    ["empty", ""], ["undefined", undefined], ["spaces only", "   "], ["CR/LF only", "\r\n"],
  ])("refuses an empty credential (%s)", (_n, raw) => {
    expect(normalizeApiKey(raw as string | undefined)).toEqual({ ok: false, reason: "EMPTY" });
  });
  it.each([
    ["embedded CR", "AQ.abc\rdef"], ["embedded LF", "AQ.abc\ndef"], ["embedded CRLF", "AQ.abc\r\ndef"], ["embedded tab", "AQ.abc\tdef"],
    ["NUL", "AQ.abc\u0000def"], ["DEL", "AQ.abc\u007fdef"], ["non-ASCII", "AQ.abcédef"],
  ])("refuses %s", (_n, raw) => {
    expect(normalizeApiKey(raw)).toEqual({ ok: false, reason: "INVALID_CHARACTERS" });
  });
});

describe("malformed credentials are rejected before any request is built", () => {
  const embedded = "AQ.synthetic-SECRET-part-one\r\nsynthetic-SECRET-part-two";
  it("the adapter refuses without touching the network and reports a configuration error, not a network error", async () => {
    const { f, spy } = strictFetch();
    const r = await geminiTurn({ model: "gemini-3.5-flash-lite", apiKey: embedded }, user, { fetcher: f });
    expect(r.status).toBe("INVALID_CREDENTIAL");
    expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toMatch(/SECRET|synthetic-/);
    for (const empty of ["", "  \r\n "]) {
      expect((await geminiTurn({ model: "m", apiKey: empty }, user, { fetcher: f })).status).toBe("INVALID_CREDENTIAL");
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it("configuration distinguishes unset (NOT_CONFIGURED) from malformed (INVALID_CREDENTIAL)", () => {
    expect(resolveProviderConfig({ AI_PROVIDER: "gemini" }).error).toBe("NOT_CONFIGURED");
    expect(resolveProviderConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "  \r\n" }).error).toBe("NOT_CONFIGURED");
    const bad = resolveProviderConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: embedded });
    expect(bad.error).toBe("INVALID_CREDENTIAL");
    expect(bad.settings).toBeUndefined();
    expect(JSON.stringify(bad)).not.toMatch(/SECRET|synthetic-/);
    expect(resolveProviderConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-synthetic\r" }).settings?.apiKey).toBe("sk-ant-synthetic");
  });
  it("other failure classes stay distinguishable: transport error, provider HTTP rejection, unusable response", async () => {
    const run = (fetcher: typeof fetch) => geminiTurn({ model: "m", apiKey: KEY }, user, { fetcher });
    expect((await run(async () => { throw new TypeError("fetch failed"); })).status).toBe("NETWORK_ERROR");
    expect((await run(async () => new Response("{}", { status: 403 }))).status).toBe("MODEL_ERROR");
    expect((await run(async () => new Response("not json"))).status).toBe("INVALID_OUTPUT");
  });
  it("the single-pass path inherits the repaired configuration (key reaches the provider clean)", async () => {
    const c = resolveProviderConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: KEY + "\r" }).settings!;
    let sent = "";
    const fetcher: typeof fetch = async (_u, init) => { sent = (init?.headers as Record<string, string>)["x-goog-api-key"]; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ candidates: [] }) }] } }] })); };
    await requestInvestigation(c, { invoices: [], deliveries: [] }, fetcher);
    expect(sent).toBe(KEY);
  });
  it("no log or error text produced by these paths contains the credential", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { f } = strictFetch();
    const results = [await geminiTurn({ model: "m", apiKey: KEY + "\r" }, user, { fetcher: f }), await geminiTurn({ model: "m", apiKey: "bad\nkey" }, user, { fetcher: f })];
    expect(JSON.stringify(results)).not.toContain(KEY);
    expect(spy.mock.calls.flat().join(" ")).not.toContain(KEY);
    spy.mockRestore();
  });
});
