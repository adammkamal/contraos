# Setup and live-demo runbook

## 1. Clone and install

Prerequisites: Node.js 20+ (Node 22 recommended), npm, a Convex account.

```bash
git clone https://github.com/adammkamal/contraos.git
cd contraos
npm install
npx convex dev
```

The Convex CLI will prompt for login and creation/selection of a **development** deployment. Keep `npx convex dev` running: it generates `convex/_generated/`, deploys functions, and writes `.env.local` with `VITE_CONVEX_URL` and `CONVEX_DEPLOYMENT`.

Configure a 32+-character setup secret, never committed or pasted into Git:

```bash
npx convex env set CONTRAOS_SETUP_KEY "<locally-generated-random-secret>"
```

To enable AI evidence investigation, select **one server-side provider** (optional; deterministic validation remains available without AI).

**Gemini free-tier testing (synthetic evidence only):**

```bash
npx convex env set AI_PROVIDER gemini
npx convex env set GEMINI_API_KEY
# Optional: npx convex env set GEMINI_MODEL gemini-3.5-flash-lite
```

**Claude final demonstration (only if you have API access):**

```bash
npx convex env set AI_PROVIDER anthropic
npx convex env set ANTHROPIC_API_KEY
# Optional: npx convex env set ANTHROPIC_MODEL claude-haiku-5-5
```

No frontend changes are needed to switch providers. AI_PROVIDER defaults to gemini, and provider errors do **not** fall back automatically to the paid provider. Keep keys in Convex server environment variables, not Vite or Git. The Company C officer secret is required to initiate investigation. Google free-tier input may be used for product improvement, so **never use real financial data** in this demo.

In a second terminal:

```bash
npm run dev
```

Open the printed local URL. The default session slug is `demo`.

## 2. Initialize the sample session once

1. Enter `demo` as slug and the administrator setup secret from step 1.
2. Generate **three separate random officer secrets**, each 16+ characters (32+ recommended), and put one in each officer field. Save them privately for the demonstration: the form clears on page reload; the backend only stores a SHA-256 digest.
3. Press **Initialize secure demo** exactly once. Additional attempts for the same slug correctly fail.
4. Visit **Officer portal**. Select A, enter A secret, grant a $9,000 maximum payment limit. Select B, enter B secret, grant a $4,000 minimum receipt. Select C, enter C secret, grant a $2,000 minimum receipt.
5. Watch the overview switch to V1 **authorized** after three scheduled decisions. If no decisions appear, verify that `npx convex dev` is running and inspect its logs.

**Officer credentials are demo-only:** treat as shared secrets. This is not corporate identity or production authentication. Never use real company information.

## 3. Walk through the main demonstration

1. Show V1: A owes $8k net and B/C receive $5k/$3k.
2. In **Evidence investigation**, show `INV-003:L1` (100 billed at $50) versus `DEL-003:L1` (60 received, period complete), supporting a $2,000 hold.
3. If a provider key is configured, press **Run AI investigator** and show its persisted, source-verified candidate. If the model fails, use the **manual evidence fallback** on C officer's screen and label it honestly.
4. In **Officer portal**, select C, enter C secret and press **File $2,000 validated dispute**.
5. Show V1 **superseded**, V2 **open/blocked**, Agent A **escalated** because $10k exceeds $9k, and B/C **accepted** under their original policies. No payments have been executed.
6. Select A with A officer secret and amend maximum payment to $10,000. Show A's fresh decision and V2 authorization in the live overview and audit trail.

For the judge, open `?session=demo` in three browser devices/tabs. Each subscribes to the same Convex data. Officer actions require entering that company's secret and are enforced by backend mutations.

## 4. Commands to verify locally

```bash
npm run typecheck
npm test
npm run build
```

Then test the live sequence above and the negative cases: B token cannot amend A's policy, duplicate C dispute rejected, A's policy cap cannot be bypassed with browser tools, and stale V1 cannot be reauthorized. Build/test execution and these negative cases **have not yet been verified** in the remote repository.

## 5. Known limitations

- Synthetic, single-purpose three-company demonstration, not payment execution.
- Convex session read-model is open to demo viewers and exposes synthetic financial facts; officer mutations require secrets. Do not insert real customer data.
- Evidence data and conditions are seeded fiction. Model analysis is advisory and amounts are calculated by deterministic validation.
- Agent settlement decisions are real *scheduled deterministic policy evaluations*, not three LLM-generated financial judgments. AI is used for invoice investigation when configured.
- Date-scoped policies expire after the demonstration window; future reuse requires changing the explicit synthetic scenario dates.
- No Convex deployment or live browser end-to-end success has been verified here.
