# ContraOS

**Autonomous finance with verifiable human authority.**

ContraOS is a synthetic three-company demonstration in which independently governed finance agents evaluate conditional multilateral settlement proposals. An evidence-supported dispute supersedes an already-authorized, unexecuted proposal. Agents then re-evaluate the revised proposal under their own human-granted policies; the system refuses authorization if any participant lacks current authority.

## Demonstration

- **V1:** A owes B $20,000; B owes C $15,000; C owes A $12,000. The proposed net transfers total $8,000. A, B and C independently accept V1.
- **Evidence:** C's completed delivery record indicates 60 of 100 invoiced units were received at $50 per unit. This supports a possible $2,000 discrepancy. A separately authorized C officer places the supported portion on hold.
- **V2:** Eligible C-to-A obligations fall to $10,000, and the proposed net transfers rise to $10,000. B and C accept V2, while A escalates because its current delegated payment limit is $9,000.
- **Resolution:** A's human officer explicitly raises the allowed payment limit. A's agent re-evaluates V2, and the server authorizes the unexecuted proposal after rechecking all invariants.

## Implementation

React + TypeScript + Vite for the interface; Convex for real-time, transactional backend state and scheduled agent evaluations; pure TypeScript for financial arithmetic, evidence validation and hard policy boundaries; Vitest + convex-test for tests.

**Important:** All companies, invoices, deliveries and obligations are fictional. The prototype assumes a separate, valid multilateral clearing arrangement. It does not execute payments, legally extinguish debt, or demonstrate realized savings.

## Engineering priorities

1. Make the complete V1 → evidence → authorized dispute → V2 → escalation → human amendment → V2 authorization journey work end to end.
2. Enforce authority and freshness on the server, not just in the interface.
3. Show three independently evaluated, persisted decisions and their reasons.
4. Make invoice/delivery provenance visible and independently validate model-generated suggestions.
5. Show actual Convex-powered live updates and record a reproducible demonstration.

See `AGENTS.md` and `CLAUDE.md` for implementation requirements.
