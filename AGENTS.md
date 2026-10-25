# ContraOS engineering rules

## Product boundary
Implement a **synthetic**, three-company settlement-coordination demonstration. No payment execution, real financial data, or assertion that proposals extinguish debt. All financial amounts must be safe integer cents. Follow the specific V1 → evidence → V2 flow defined in the README and accompanying implementation blueprint.

## Non-negotiable behavior
1. Company policies are independently granted by human officers. Public mutations verify a server-side officer credential and derive the company from that credential; never trust a client-supplied company identifier as authorization.
2. Every proposal belongs to a session; resolve the current proposal through `sessions.currentProposalId`. Proposal financial terms are immutable; `open`, `authorized`, and `superseded` are lifecycle states. An authorized but **unexecuted** proposal can be superseded by validated new evidence.
3. Dispute filing is one atomic mutation: check the acting company's permission; confirm the obligation belongs to the current proposal and that the actor is its debtor; revalidate trusted invoice and delivery facts; atomically reject duplicate (session, obligation, invoice line) disputes; update eligible obligations, evidence version, proposal status, current proposal pointer and schedule fresh evaluations.
4. Agent decisions must be real event-triggered evaluations under each company's policy, tied to the **exact proposal ID and policy version**, with persisted decision and reason codes. Scheduled decisions for a superseded proposal are ignored.
5. Authorization is a server-side internal mutation that re-derives balances and transfers, checks evidence version, current proposal, current policies, and fresh independent agent decisions. A missing, stale or invalid check fails closed.
6. The LLM investigator, when added, only proposes source-cited discrepancies. It may not file disputes, grant policy, decide financial authorization, or execute payments. Trusted deterministic code calculates the supported amount.
7. No hardcoded UI statuses. All participant views derive from Convex live queries and stored decisions.
8. No sensitive tokens, model keys, or private source identifiers in repository files, logs, screenshots, documentation or public submission.
9. Demo setup must be idempotent or reject duplicate seed. Provide manual fallback visibly marked when the model action fails.

## Workflow
Build one complete browser vertical slice before broad code audits. Claude Code may implement; Codex independently reviews arithmetic, scope, auth and stale-operation protection after the flow works. Do not pause frontend integration for broad intermediate reviews. Run relevant unit and integration tests plus a production build; report actual commands/results and incomplete items without claiming unverified outcomes.

## Exact scenario
O1 A→B $20,000; O2 B→C $15,000; O3 C→A $12,000; V1 A −$8,000, B +$5,000, C +$3,000; invoice O3 L1: 100 billed × $50, 60 received, period complete; C files supported $2,000 hold. V2 A −$10,000, B +$5,000, C +$5,000. A policy max pay $9,000; B min receive $4,000; C min receive $2,000. A escalates, B/C accept, A officer amends to $10,000, agent A reevaluates, V2 authorizes. The demo assumes conditional multilateral clearing rights.
