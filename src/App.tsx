import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Activity, FileSearch, ShieldCheck } from "lucide-react";
import { api } from "../convex/_generated/api";
import { CODES, TARGET, derive, disputeReadiness, formContext, type Code } from "./model";
import { Field } from "./ui";
import { Investigation } from "./views/Investigation";
import { Officer } from "./views/Officer";
import { Overview } from "./views/Overview";

type Tab = "overview" | "evidence" | "officer";

function Mark() {
  return (
    <svg className="mark" width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d="M11 4.5 4.5 16.5h13L11 4.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="11" cy="4.5" r="2.2" fill="currentColor" />
      <circle cx="4.5" cy="16.5" r="2.2" fill="currentColor" />
      <circle cx="17.5" cy="16.5" r="2.2" fill="currentColor" />
    </svg>
  );
}

const TITLES: Record<Tab, { title: string; sub: string }> = {
  overview: { title: "Settlement", sub: "Three companies, three independent agents, one proposal at a time." },
  evidence: { title: "Evidence", sub: "Source-linked invoice and delivery records behind the dispute." },
  officer: { title: "Officer portal", sub: "Authority and disputes belong to each company's human officer." },
};

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
    setTab("officer");
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

  const nav: Array<{ id: Tab; label: string; icon: typeof Activity; alert?: boolean }> = [
    { id: "overview", label: "Overview", icon: Activity },
    { id: "evidence", label: "Investigation", icon: FileSearch },
    { id: "officer", label: "Officer portal", icon: ShieldCheck, alert: view?.phase === "blocked" },
  ];

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand"><Mark /><span>ContraOS</span></div>
        <nav aria-label="Primary">
          {nav.map(({ id, label, icon: Icon, alert }) => (
            <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
              <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>{label}</span>
              {alert && <i className="nav-alert" title="Authorization needed" />}
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <span className={"live " + (data ? "on" : "")}><i />{data === undefined ? "Connecting" : data ? "Live from Convex" : "No session"}</span>
          <span>Synthetic demonstration. No payments are executed.</span>
        </div>
      </aside>

      <main>
        <header className="page-head">
          <div>
            <h1>{TITLES[tab].title}</h1>
            <p>{TITLES[tab].sub}</p>
          </div>
          {data && <span className="session">Session <b className="mono">{data.session.slug}</b></span>}
        </header>

        {error && <div className="toast error" role="alert"><span>{error}</span><button aria-label="Dismiss" onClick={() => setError("")}>×</button></div>}
        {notice && <div className="toast ok" role="status"><span>{notice}</span><button aria-label="Dismiss" onClick={() => setNotice("")}>×</button></div>}

        {data === undefined ? (
          <p className="muted">Waiting for the Convex deployment…</p>
        ) : !data || !view ? (
          <section className="setup">
            <h2>Initialize a session</h2>
            <p className="muted">Creates the synthetic three-company scenario. Setup needs the server-configured administrator key and a separate secret for each officer.</p>
            <Field label="Session slug"><input value={slug} onChange={(e) => setSlug(e.target.value)} /></Field>
            <Field label="Setup administrator key"><input type="password" value={setupKey} onChange={(e) => setSetupKey(e.target.value)} /></Field>
            <div className="grid3">
              {CODES.map((c) => (
                <Field key={c} label={`Officer ${c} secret (16+ characters)`}>
                  <input type="password" value={secrets[c]} onChange={(e) => setSecrets((s) => ({ ...s, [c]: e.target.value }))} />
                </Field>
              ))}
            </div>
            <div className="btn-row">
              <button className="btn primary" disabled={!!busy} onClick={() => work("Workspace setup", () => initialize({ slug, setupKey, officerA: secrets.A, officerB: secrets.B, officerC: secrets.C }))}>Initialize session</button>
            </div>
          </section>
        ) : (
          <>
            {tab === "overview" && <Overview data={data} view={view} onReviewAuthority={reviewAuthority} onOpenEvidence={() => setTab("evidence")} />}
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
                  setTab("officer");
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
      </main>
    </div>
  );
}
