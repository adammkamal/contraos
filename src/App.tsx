import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { CODES, TARGET, derive, disputeReadiness, formContext, type Code } from "./model";
import { Field } from "./ui";
import { Investigation } from "./views/Investigation";
import { Officer } from "./views/Officer";
import { Overview } from "./views/Overview";

type Tab = "overview" | "evidence" | "officer";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "evidence", label: "Investigation" },
  { id: "officer", label: "Officer portal" },
];

export default function App() {
  const [slug, setSlug] = useState(new URLSearchParams(window.location.search).get("session") || "demo");
  const [tab, setTab] = useState<Tab>("overview");
  const [company, setCompany] = useState<Code>("A");
  const [token, setToken] = useState("");
  const [investigatorToken, setInvestigatorToken] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [secrets, setSecrets] = useState({ A: "", B: "", C: "" });
  const [limit, setLimit] = useState("10000");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const data = useQuery(api.workflow.getSession, { slug });
  const initialize = useMutation(api.workflow.initialize);
  const grant = useMutation(api.workflow.grantPolicy);
  const dispute = useMutation(api.workflow.fileDispute);
  const manual = useMutation(api.investigate.manualCandidate);
  const investigate = useAction(api.investigate.investigate);

  // A success notice describes one action; it should not follow the user around the app.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const go = (next: Tab) => {
    setNotice("");
    setTab(next);
  };

  const work = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(label + " completed successfully");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const view = data ? derive(data) : undefined;

  // Every company switch starts from a clean form: no carried-over credential or limit.
  const selectCompany = (c: Code, requiredCents?: number) => {
    const next = formContext(data?.policies ?? [], c, requiredCents);
    setCompany(next.company);
    setToken(next.token);
    setLimit(next.limit);
  };

  const reviewAuthority = (c: Code) => {
    // Pre-fill with what the current proposal requires, so the officer reviews an exact figure.
    const need = view?.current?.positions.find((p) => p.company === c)?.cents ?? 0;
    selectCompany(c, Math.abs(need));
    go("officer");
  };

  const submitPolicy = async () => {
    if (!data) return;
    const amount = Math.round(Number(limit) * 100);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Enter a valid nonnegative whole-dollar amount");
    await grant({ sessionId: data.session.id, officerToken: token, ...(company === "A" ? { maxNetPayCents: amount } : { minNetReceiveCents: amount }) });
  };
  const file = async () => {
    if (!data) return;
    // Client-side guard only; the server revalidates the evidence and remains authoritative.
    const readiness = disputeReadiness(data);
    if (!readiness.ok) throw new Error(readiness.reason);
    await dispute({ sessionId: data.session.id, officerToken: token, obligationCode: TARGET.obligation, lineId: TARGET.line, claimedCents: readiness.cents });
  };

  return (
    <>
      <header className="top">
        <div className="top-in">
          <span className="brand">ContraOS</span>
          <nav className="tabs" aria-label="Primary">
            {TABS.map(({ id, label }) => (
              <button key={id} aria-current={tab === id ? "page" : undefined} className={id === "officer" && view?.phase === "blocked" ? "need" : undefined} onClick={() => go(id)}>
                {label}
                {id === "officer" && view?.phase === "blocked" && <span className="sr"> (authorization needed)</span>}
              </button>
            ))}
          </nav>
          <span className="top-meta">{data ? <>Session <span className="mono">{data.session.slug}</span></> : data === undefined ? "Connecting…" : "No session"}</span>
        </div>
      </header>

      <main>
        {error && <div className="toast error" role="alert"><span>{error}</span><button aria-label="Dismiss" onClick={() => setError("")}>×</button></div>}
        {notice && <div className="toast ok" role="status"><span>{notice}</span><button aria-label="Dismiss" onClick={() => setNotice("")}>×</button></div>}

        {data === undefined ? (
          <p className="muted">Waiting for the Convex deployment…</p>
        ) : !data || !view ? (
          <section className="setup">
            <h1>Initialize a session</h1>
            <p>Creates the synthetic three-company scenario. Setup needs the server-configured administrator key and a separate secret for each officer.</p>
            <Field label="Session slug"><input value={slug} onChange={(e) => setSlug(e.target.value)} /></Field>
            <Field label="Setup administrator key"><input type="password" value={setupKey} onChange={(e) => setSetupKey(e.target.value)} /></Field>
            {CODES.map((c) => (
              <Field key={c} label={`Officer ${c} secret (16+ characters)`}>
                <input type="password" value={secrets[c]} onChange={(e) => setSecrets((s) => ({ ...s, [c]: e.target.value }))} />
              </Field>
            ))}
            <div className="btn-row">
              <button className="btn primary" disabled={!!busy} onClick={() => work("Workspace setup", () => initialize({ slug, setupKey, officerA: secrets.A, officerB: secrets.B, officerC: secrets.C }))}>Initialize session</button>
            </div>
          </section>
        ) : (
          <>
            {tab === "overview" && <Overview data={data} view={view} onReviewAuthority={reviewAuthority} onOpenEvidence={() => go("evidence")} />}
            {tab === "evidence" && (
              <Investigation
                data={data}
                view={view}
                token={investigatorToken}
                setToken={setInvestigatorToken}
                busy={busy}
                onRun={() => work("AI investigation", async () => {
                  const r = await investigate({ sessionId: data.session.id, officerToken: investigatorToken });
                  if (r.status !== "CANDIDATES_SAVED") throw new Error(r.message || r.status);
                })}
                onFile={() => {
                  selectCompany("C");
                  setInvestigatorToken("");
                  go("officer");
                }}
              />
            )}
            {tab === "officer" && (
              <Officer
                data={data}
                view={view}
                company={company}
                onCompany={selectCompany}
                token={token}
                setToken={setToken}
                limit={limit}
                setLimit={setLimit}
                busy={busy}
                onGrant={() => work("Policy grant", submitPolicy)}
                onDispute={() => work("Dispute filing", file)}
                onManual={() => work("Manual evidence fallback", () => manual({ sessionId: data.session.id, officerToken: token }))}
              />
            )}
          </>
        )}
        <footer className="foot">Synthetic demonstration.</footer>
      </main>
    </>
  );
}
