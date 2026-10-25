import { money, type Code } from "../model";
import { firstName } from "../ui";

type Pt = { x: number; y: number };
const NODE: Record<Code, Pt> = { A: { x: 200, y: 95 }, B: { x: 80, y: 325 }, C: { x: 302, y: 325 } };
// Obligation edges follow the reference geometry; the label sits beside its edge.
const EDGE: Record<string, { d: string; label: Pt }> = {
  AB: { d: "M200 120C150 170 105 230 82 298", label: { x: 60, y: 179 } },
  AC: { d: "M200 120C250 170 295 230 318 298", label: { x: 315, y: 169 } },
  BC: { d: "M100 330Q200 357 300 330", label: { x: 201, y: 382 } },
};
const key = (a: Code, b: Code) => [a, b].sort().join("");

/** Parties, obligations and transfers all come from the current proposal; nothing here is a fixed value. */
export function NettingMap({ names, obligations, transfers, rings }: {
  names: Record<Code, string>;
  obligations: Array<{ code: string; debtor: Code; creditor: Code; owed: number; held: number }>;
  transfers: Array<{ from: Code; to: Code; cents: number }>;
  rings: Partial<Record<Code, "ok" | "warn">>;
}) {
  const summary = transfers.map((t) => `${firstName(names, t.from)} pays ${firstName(names, t.to)} ${money(t.cents)}`).join("; ") || "no transfers";
  const arrow = (from: Code, to: Code) => {
    const a = NODE[from], b = NODE[to];
    const len = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const s = { x: a.x + ux * 46, y: a.y + uy * 46 }, e = { x: b.x - ux * 34, y: b.y - uy * 34 };
    const head = (ang: number) => ({ x: e.x - (ux * Math.cos(ang) - uy * Math.sin(ang)) * 14, y: e.y - (uy * Math.cos(ang) + ux * Math.sin(ang)) * 14 });
    return { s, e, h1: head(0.5), h2: head(-0.5), mid: { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 } };
  };
  const pill = (p: Pt, text: string, tone: "mint" | "dim") => {
    const w = text.length * 6.6 + 20;
    return (
      <g key={text + p.x + p.y}>
        <rect x={p.x - w / 2} y={p.y - 11} width={w} height={22} rx={11} fill={tone === "mint" ? "#2fd39a" : "rgba(255,255,255,.08)"} />
        <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="11.5" fontWeight={tone === "mint" ? 700 : 500} fill={tone === "mint" ? "#0e1e3a" : "#c9d3e3"}>{text}</text>
      </g>
    );
  };
  return (
    <svg viewBox="0 0 400 402" width="100%" role="img" aria-label={`Netting map: ${summary}`} fill="none">
      {obligations.map((o) => {
        const e = EDGE[key(o.debtor, o.creditor)];
        return e ? <path key={o.code} d={e.d} stroke="#c9d3e3" strokeOpacity=".55" strokeWidth="2" strokeDasharray={o.held > 0 ? "5 6" : undefined} /> : null;
      })}
      {transfers.map((t) => {
        const g = arrow(t.from, t.to);
        return (
          <g key={t.from + t.to} stroke="#2fd39a" strokeWidth="5" strokeLinecap="round">
            <path d={`M${g.s.x} ${g.s.y} L${g.e.x} ${g.e.y}`} />
            <path d={`M${g.e.x} ${g.e.y} L${g.h1.x} ${g.h1.y} M${g.e.x} ${g.e.y} L${g.h2.x} ${g.h2.y}`} />
          </g>
        );
      })}
      {transfers.map((t) => pill(arrow(t.from, t.to).mid, money(t.cents), "mint"))}
      {obligations.map((o) => {
        const e = EDGE[key(o.debtor, o.creditor)];
        return e ? pill(e.label, `${o.code} ${money(o.owed - o.held)}${o.held > 0 ? " after hold" : ""}`, "dim") : null;
      })}
      {(["A", "B", "C"] as Code[]).map((c) => {
        const p = NODE[c], ring = rings[c];
        return (
          <g key={c}>
            <rect x={p.x - 24} y={p.y - 24} width={48} height={48} rx={14} fill="#16294a" stroke={ring === "warn" ? "#d9732a" : ring === "ok" ? "#2fd39a" : "rgba(255,255,255,.12)"} strokeWidth={ring ? 2.5 : 1} />
            <text x={p.x} y={p.y + 6} textAnchor="middle" fontSize="18" fontWeight="700" fill="#fff">{c}</text>
            <text x={p.x} y={p.y + 37} textAnchor="middle" fontSize="13" fontWeight="600" fill="#fff">{firstName(names, c)}</text>
          </g>
        );
      })}
    </svg>
  );
}
