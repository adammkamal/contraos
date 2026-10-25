import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { CODES, TARGET, derive, disputeReadiness, formContext, type Code } from "./model";
import { Btn, Card, Field, Footer, Logo, Pill, UpdatedContext } from "./ui";
import { Investigation } from "./views/Investigation";
import { Officer } from "./views/Officer";
import { Overview } from "./views/Overview";

const SEED_NAMES: Record<Code, string> = { A: "Atlas", B: "Beacon", C: "Cedar" };
type Tab = "overview" | "evidence" | "officer";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "evidence", label: "Investigation" },
  { id: "officer", label: "Officer portal" },
];

export default function App() {
  const [slug, setSlug] = useState(new URLSearchParams(window.location.search).get("session") || "demo");
  const [tab, setTab] = useState<Tab>("overview");
  const [menu, setMenu] = useState(false);
  const [company, setCompany] = useState<Code>("A");
  const [token, setToken] = useState("");
  const [investigatorToken, setInvestigatorToken] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [secrets, setSecrets] = useState({ A: "", B: "", C: "" });
  const [limit, setLimit] = useState("10000");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [updated, setUpdated] = useState<Date | undefined>();
  const data = useQuery(api.workflow.getSession, { slug });
  const initialize = useMutation(api.workflow.initialize);
  const grant = useMutation(api.workflow.grantPolicy);
  const dispute = useMutation(api.workflow.fileDispute);
  const manual = useMutation(api.investigate.manualCandidate);
  const investigate = useAction(api.investigate.investigate);

  // "Updated" is when this client last received a snapshot from Convex.
  useEffect(() => { if (data) setUpdated(new Date()); }, [data]);
  // A success notice describes one action; it should not follow the user around the app.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  const go = (next: Tab) => {
    setNotice("");
    setMenu(false);
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
    <UpdatedContext.Provider value={updated}>
      <div className="screen">
        <nav className={"nav" + (menu ? " nav--open" : "")} aria-label="Primary">
          <div className="nav__bar">
            <div className="nav__brand"><Logo /><span className="nav__name"><span className="nav__app">ContraOS</span><span className="nav__page">{TABS.find((t) => t.id === tab)?.label}</span></span></div>
            <button className="nav__toggle" aria-expanded={menu} aria-controls="nav-panel" aria-label="Menu" onClick={() => setMenu((m) => !m)}>≡</button>
            <div className="nav__panel" id="nav-panel">
              <div className="nav__list">
                {TABS.map(({ id, label }) => (
                  <button key={id} className="nav__link" aria-current={tab === id ? "page" : undefined} onClick={() => go(id)}>
                    {label}
                    {id === "officer" && view?.phase === "blocked" && <><i className="nav__dot" aria-hidden="true" /><span className="sr"> (authorization needed)</span></>}
                  </button>
                ))}
              </div>
              <i className="nav__sep" aria-hidden="true" />
              <Pill tone={data ? "live" : "idle"} className="nav__status">{data ? `${data.session.slug} · live` : data === undefined ? "connecting" : "no session"}</Pill>
            </div>
          </div>
        </nav>

        <main className="screen__main">
          {error && <div className="toast error" role="alert"><span>{error}</span><button aria-label="Dismiss" onClick={() => setError("")}>×</button></div>}
          {notice && <div className="toast ok" role="status"><span>{notice}</span><button aria-label="Dismiss" onClick={() => setNotice("")}>×</button></div>}

          {data === undefined ? (
            <p className="empty">Waiting for the Convex deployment…</p>
          ) : !data || !view ? (
            <>
              <header className="page-head"><div><h1 className="page-head__title">Start a demo session</h1><p className="page-head__sub">This seeds the synthetic Atlas, Beacon and Cedar scenario on your Convex deployment. Setup needs the server-configured administrator key and a separate secret for each officer.</p></div></header>
              <div className="setup">
                <Card label="Session setup">
                  <div className="setup__pair">
                    <Field label="Session slug" hint="A slug that already exists is refused, so a live session is never overwritten."><input className="field__input" value={slug} onChange={(e) => setSlug(e.target.value)} /></Field>
                    <Field label="Setup administrator key" hint="Checked by the server and never stored in the page."><input className="field__input" type="password" autoComplete="off" value={setupKey} onChange={(e) => setSetupKey(e.target.value)} /></Field>
                  </div>
                  <h2 className="setup__h">Officer secrets</h2>
                  <p className="setup__p">Each officer signs actions with their own secret, and the server uses it to decide which company they act for. Use at least 16 characters.</p>
                  <div className="setup__trio">
                    {CODES.map((c) => (
                      <Field key={c} label={`${SEED_NAMES[c]} officer`} hint={secrets[c].length > 0 && secrets[c].length < 16 ? `Needs ${16 - secrets[c].length} more characters` : undefined}>
                        <input className="field__input" type="password" autoComplete="off" value={secrets[c]} onChange={(e) => setSecrets((s) => ({ ...s, [c]: e.target.value }))} />
                      </Field>
                    ))}
                  </div>
                  <div className="btn-row">
                    <Btn island disabled={!!busy || !slug.trim() || !setupKey || CODES.some((c) => secrets[c].length < 16)} onClick={() => work("Workspace setup", () => initialize({ slug, setupKey, officerA: secrets.A, officerB: secrets.B, officerC: secrets.C }))}>Seed the session</Btn>
                    <span className="setup__p">Enabled once every secret is long enough.</span>
                  </div>
                </Card>
                <Card tone="navy" label="What the seed creates">
                  <span className="eyebrow">What the seed creates</span>
                  <h2 className="setup__side">Three synthetic companies that owe each other $47,000 in total</h2>
                  <p className="setup__p setup__p--dark">Atlas owes Beacon $20,000, Beacon owes Cedar $15,000 and Cedar owes Atlas $12,000. Invoice INV-003 and receiving report DEL-003 come with it. Each company starts with its own policy; agents then evaluate the proposal the engine builds from them.</p>
                </Card>
              </div>
              <Footer names={{ A: "Atlas", B: "Beacon", C: "Cedar" }} />
            </>
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
        </main>
      </div>
    </UpdatedContext.Provider>
  );
}
