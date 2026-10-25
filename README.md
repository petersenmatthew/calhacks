# MOA (Mixture of Accountants)

Autonomous finance for AI research labs. Six AI agents check every GPU invoice line against what actually ran, dispute overcharges with the cloud provider, and chase the credit until it lands. The controller only makes the calls, in the app; Slack and email keep everyone posted.

**Live demo:** https://moa-accountants.fly.dev/welcome (each visitor gets their own copy).

| Agent | Job |
| --- | --- |
| GPU Auditor | Checks a charge against shutdown records, the provider's meter, and job logs |
| Cost Allocator | Reads the contract, decides what is owed, drafts disputes and team allocations |
| Vendor Liaison | Emails the dispute with evidence, reads the reply, follows up, books the credit |
| Capacity Planner | Works out who used a shared GPU reservation and how much sat idle |
| Budget Analyst | Checks each research team's burn against its budget after anything posts |
| Controls Lead | Turns the controller's past decisions into reusable policies |

**Agents decide, code guarantees.** Every agent action is a typed tool call through one gateway that enforces that agent's permissions, does all money math in code, and checks that cited contract clauses exist. Agents never approve or pay; disputes need the controller, and money stays owed until a credit memo arrives. Every step goes to an append-only audit log.

**Example:** Lambda bills 36 h. The job ran 22 h and the instance was shut down at 24 h. MOA disputes 12 h, not 14, because the contract says idle time on a running instance is billable.

The fictional lab is **xAnthropenAI**. Its source systems (scheduler, infrastructure controller, provider meters, invoices, ERP) are simulated in SQLite; agent decisions, approvals, postings, emails, and the audit trail are real application state. Work also starts on its own: a scheduler syncs billing feeds and follows up on approvals and disputes as business days pass. See [What runs on its own](#what-runs-on-its-own) and [Proof it works](#proof-it-works).

## Quick start

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
# open http://localhost:3000
```

The landing page is at `/welcome`; the app itself at `/canvas`. The first request creates `data/moa.db`, loads the October 2026 sandbox (clean invoice lines that auto-match, so the app starts quiet), and starts the background worker. Click **Simulate billing event** to send in a case. `SEED=all` loads all 22 open cases from `src/server/sim/cases.ts` instead. An existing database keeps its old seed until **Reset demo**.

Production build:

```bash
npm run build && npm start
```

## Deploy on Fly.io (public demo for judges)

The repo ships a `Dockerfile` and `fly.toml`: one machine, SQLite on a volume at `/data`, `PUBLIC_DEMO=1` already set.

```
brew install flyctl                            # or: curl -L https://fly.io/install.sh | sh
fly auth login
fly launch --copy-config --no-deploy           # pick an app name and region; keeps fly.toml
fly volumes create data --size 1               # same region as the app; keeps the database across deploys
fly secrets set OPENAI_API_KEY=sk-...          # use a spend-limited key
fly secrets set APP_URL=https://<app>.fly.dev
fly deploy --ha=false                          # one machine: SQLite can't be shared
```

Logs: `fly logs`. Redeploy after changes: `fly deploy`.

The same Dockerfile also works on Railway (`railway.json`, volume at `/data`, same variables).

Share `https://<app>.fly.dev/welcome`: the landing page, whose **Start** opens a short intro and then the billing-event picker. Nothing runs until the visitor picks an event.

`PUBLIC_DEMO=1` makes the app safe to share:

- Every visitor gets their own sandbox: a separate seeded database and agent team, picked by a cookie (`src/proxy.ts`). Nobody sees anyone else's cases, and **Reset demo** resets only your copy. Sandboxes idle for 45 minutes are deleted.
- The intro can be reopened with the **?** in the top bar.
- Slack and email are recorded on each task and never sent, whatever else is set.
- The person using the app is called "You" (set `CONTROLLER_NAME` to change it).
- Each visitor is limited per hour: 12 new billing events, 4 resets, 40 questions, 60 decisions, 20 pasted vendor replies.
- Live model runs are capped at `MAX_LLM_RUNS_PER_HOUR` (default 120) across all sandboxes; past the cap, agents use the scripted replay instead of failing.

## Environment variables

Copy `.env.example` to `.env.local`. All are optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | unset | Enables LLM agents through the OpenAI Agents SDK. Without it the app runs in **Deterministic replay**. Server-side only. |
| `OPENAI_MODEL` | Agents SDK default | Model for LLM agents. |
| `AGENT_MODE` | `llm` if a key is set, else `deterministic` | Starting execution mode. Switch at runtime with `POST /api/settings {"mode": "llm"}`. |
| `DETERMINISTIC_STEP_DELAY_MS` | `700` | Pause between deterministic agent steps so the live timeline is watchable. |
| `DATABASE_PATH` | `./data/moa.db` | SQLite file (an existing `./data/experiment-ledger.db` keeps being used). |
| `OPENAI_AGENTS_DISABLE_TRACING` | unset | Set to `1` to stop the SDK exporting traces to OpenAI. |
| `FACTORY_API_KEY` | unset | Runs the six employees on Factory Droid (needs the `droid` CLI on PATH). The assistant and simulated vendor still use `OPENAI_API_KEY`. |
| `DROID_MODEL` | Droid default | Droid model id for the employees. |
| `AGENT_ENGINE` | `droid` if `FACTORY_API_KEY` is set | Set to `openai` to run the employees on the OpenAI Agents SDK instead. |
| `SCHEDULER_INTERVAL_MS` | `5000` | How often the scheduler syncs billing feeds and runs follow-up rules. |
| `AUTONOMY` | on | Set to `off` to disable the scheduler (agents still run when work is queued). |
| `BILLING_FEED_URL` | unset | Optional external billing feed polled on a cursor: `GET <url>?after=<cursor>` returns `{ events, next_cursor }`. |
| `VENDOR_EMAIL` | each provider's billing address | Send every vendor email to this inbox instead (use your own address for the demo). |
| `RESEND_API_KEY` | unset | Send email through [Resend](https://resend.com). |
| `SMTP_URL` | unset | Or send through any SMTP server, e.g. `smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465`. |
| `EMAIL_FROM`, `EMAIL_REPLY_TO` | Resend test sender / SMTP user | Sender and reply-to for vendor email. |
| `IMAP_URL` | the Gmail account in `SMTP_URL` | Mailbox vendor replies are read from (`imaps://user:pass@host:993`). |
| `INBOX_POLL_MS` | `30000` | How often to check it. `0` turns reading off. |
| `SLACK_BOT_TOKEN` | unset | Post to a real Slack workspace. Scopes: `chat:write`, `chat:write.public`, `channels:read`, `channels:manage`, `channels:join`, `users:read`, `reactions:write`; the bot creates and joins the channels below. |
| `SLACK_WEBHOOK_URL` | unset | Or post everything to one channel through an incoming webhook. |
| `SLACK_USERS` | unset | Who is who, by Slack username or member id: `controller=belinda, cfo=matthewpetersen, leads=matthewpetersen` (role keys `controller`, `cfo`, `leads`, `*`, or any handle). `SLACK_USER_IDS` (JSON or one id) still works. |
| `PUBLIC_DEMO` | unset | `1` for a public deployment: a separate copy of the demo per visitor, Slack and email recorded only, per-visitor rate limits, capped model runs. |
| `CONTROLLER_NAME` | `Matthew Petersen` (`You` on a public demo) | Display name of the person using the app. |
| `SEED` | `demo` | `all` loads all 35 seeded cases on a new database instead of starting quiet. |
| `RUN_MODE` | `one` | `one` works one case at a time (a newly simulated invoice goes first); `all` lets agents work every open case at once. |
| `MAX_LLM_RUNS_PER_HOUR` | `120` | In a public demo, live agent runs per hour before agents fall back to replay. |
| `APP_URL` | `http://localhost:3000` | Base for the links in Slack messages. |

### Execution modes

- **LLM agents.** Each agent turn is a Factory Droid session (with `FACTORY_API_KEY`) or an OpenAI Agents SDK run with typed Zod tools. The model chooses tools and writes findings; the run ends only when a terminal tool (handoff, approval request, posting request) succeeds.
- **Deterministic replay.** A fixed, scripted decision policy calls the same tools through the same gateway, with the same permissions and audit. It exists for demos without credentials and for tests. Runs in this mode are labeled "Deterministic replay" everywhere in the UI and are never presented as LLM output.

### Where Factory Droid runs

Droid is each finance employee's runtime: the GPU Auditor, Cost Allocator, Vendor Liaison, Budget Analyst, Controls Lead, and Capacity Planner each run as a Droid session ([src/server/agents/droid.ts](src/server/agents/droid.ts)).

- **Trigger.** Nobody prompts Droid. A session starts when a job reaches an employee: a new invoice from the billing feed, a handoff from another employee, a vendor email arriving in the inbox, an overdue dispute found by the scheduler, a posting, or a controller decision.
- **What it can touch.** Droid gets only that employee's tools, served in process as an SDK MCP server. Its built-in tools (shell, files, web, subagents) are disabled, and a permission handler approves a call only if every tool in it belongs to that employee. Anything else is cancelled and written to the audit log as a `DROID_TOOL_SCOPE` denial. Every approved call still goes through the same gateway as the other modes, which checks role permissions, work item scope, and approval rules.
- **Visible work.** Each tool call appears in the case timeline with its evidence. Findings, proposals, and approval requests appear on the canvas, and the run records its model, tool calls, tokens, and Factory credits. Droid cannot approve, post, or pay; it asks the controller.

Live check: `DROID_LIVE=1 npx vitest run tests/droid-live.test.ts` works the overbilling case on Droid until it needs the controller.

## Try it

The app opens on **Canvas**: the six agents on a ring around you, each spawning a small frame per piece of work (click a frame to replay it: the query it ran, the rows it got back, the rules it checked, the letter it wrote). **Board** shows the same work as a Kanban; **Audit trail** shows everything that happened.

**The main case: GPU overbilling** (about two minutes)

1. Click **Simulate billing event** and send **GPU overbilling**. Lambda bills 36 h at $100/h for an instance that ran 24 h; the checks open a case.
2. Watch the GPU Auditor pull the shutdown records, Lambda's meter, the job log and the contract. The job ended at 22 h, but idle time on a running instance is billable, so only the 12 h after shutdown are disputed. The Cost Allocator picks the contract clauses and proposes: pay $2,400, dispute $1,200.
3. **Approve** in the sidebar. The Vendor Liaison emails the dispute with an evidence file; only the supported $2,400 posts, and $3,600 stays owed.
4. Reply as Lambda: paste *"We've issued credit memo CM-1042 for $1,200.00"* on the task (or reply to the real email if one is set up). The Vendor Liaison books the credit, closes the case, and a summary card shows what was recovered.

**More to try**

- **Shared cluster allocation** ($12,400, two teams): the gateway refuses to post the written policy's split because it conflicts with the reservation terms. Reject it with *"Reserved capacity must be charged to the team that owns the reservation"*; the Controls Lead proposes policy v2 and the Cost Allocator reworks the split. Approve the rule (the reworked split posts with it, no second sign-off), then send **Next month: similar reservation** and it posts on its own under the learned policy.
- **Fast-forward time** with the clock in the top bar. New Lambda and Nebius lines arrive from the billing feeds and get worked; a $12 variance is accepted under the learned materiality policy instead of disputed (approve that policy first: it is waiting in the sidebar from onboarding). At +3 days a $600 dispute arrives; approve it, let the vendor stay silent, and it is chased at 14 days and escalated at 30. An approval left waiting is reminded after a day and escalated to the CFO after three.
- **Custom invoice line** makes a discrepancy that isn't scripted. **Resend last billing event** shows a repeated event is ignored. **Reset demo** starts over.

## How it works

```mermaid
flowchart LR
  Feed[Provider billing event] --> Ingest[Ingestion + deterministic checks]
  Ingest -->|clean| Auto[Auto-match under approved policy]
  Ingest -->|exception| WI[(Work item)]
  WI --> Queue[(Durable job queue)]
  Queue --> Compute[GPU Auditor or Capacity Planner]
  Compute -->|handoff| Finance[Cost Allocator]
  Compute & Finance & Vendor & Policy & Budget --> Gateway[Tool gateway: RBAC, scope, validation, evidence, audit]
  Finance -->|request approval| Human[Controller decision]
  Human -->|rejected| Policy[Controls Lead]
  Policy -->|handoff| Finance
  Human -->|approved dispute| Vendor[Vendor Liaison]
  Vendor -->|submit, close| Ledger
  Finance -->|standing policy| Ledger[Ledger gateway]
  Human -->|approved| Ledger
  Ledger --> GL[(Balanced journal entries)]
  Ledger -->|posting| Budget[Budget Analyst]
  Gateway --> Events[(Activity + audit log)] --> SSE[SSE to the UI]
```

- **Work items** move through `NEW`, `INVESTIGATING`, `NEEDS_INFO`, `PROPOSED`, `NEEDS_APPROVAL`, `APPROVED`, `POSTED`, `DISPUTED`, `RESOLVED`. Invalid transitions are rejected and audited.
- **Collaboration** happens through the shared work item. The GPU Auditor records structured findings and hands off; the Cost Allocator reads them, proposes, and can send questions back.
- **Durability.** Jobs live in SQLite. Interrupted jobs are re-queued on restart, and approvals pause a workflow until a human decides.
- **Live updates.** Activity rows are streamed over server-sent events; a reconnect replays missed rows.

## What runs on its own

- **Scheduler.** Inside the worker, every `SCHEDULER_INTERVAL_MS`. It does not decide anything itself: it pulls work in and puts agent jobs on the same durable queue, so a crash or redeploy never loses work.
- **Feed sync.** Each provider feed is read from a cursor stored in `sync_cursors`, so a re-sync never re-reads a line; ingestion is also idempotent on event and line ids. A line that fails is recorded and set aside so the feed keeps flowing. The demo feeds publish over business time (`sim/feed-schedule.ts`); `BILLING_FEED_URL` points the same code at a real HTTP feed.
- **Business clock.** Finance runs over weeks. Reminders and chases measure age on a business clock that equals wall-clock time in production; the demo can move it forward, and every move is audited.
- **Follow-ups** (`workflow/follow-ups.ts`). Approval waiting 1 day: remind the controller. 3 days: escalate to the CFO (backup approver). Vendor dispute unanswered 14 days: the Vendor Liaison runs `get_dispute_status` and `send_vendor_follow_up`. 30 days: it runs `escalate_dispute` with a recommendation. Each action is keyed so it happens once, and every one is in the audit trail.
- **Onboarding** (`workflow/onboarding.ts`). Before the first close the Controls Lead runs `query_ap_history` over the ERP's AP export and `propose_materiality_policy`. The application rejects a threshold that would have accepted any variance the vendor later credited. Once the controller approves, the ledger gateway lets variances at or below the threshold post without a dispute.

## Email and Slack

Everything the system tells a person or a vendor goes through an outbox table, written in the same transaction as the action that caused it and delivered by the scheduler. A message is never sent for an action that rolled back, and a failed send is retried. With no mail server or Slack configured, messages are kept in the outbox and marked "recorded" (letters still show on the dispute).

**Vendor disputes.** When the controller approves a dispute, the Vendor Liaison writes the cover letter and the application attaches the evidence: the invoice line, the instance's PROVISIONED, STOP_REQUESTED and TERMINATED times with the provider's own API acknowledgment, the provider meter, the contract calculation, and the text of each cited clause with the reason it applies. The Cost Allocator chooses the clauses by reading the contract text, each with a reason; the gateway rejects any section that is not in that provider's contract and adds the dispute-window clause if it was left out. The letter, evidence, recipient, and delivery status are stored on the dispute record and shown on the task. The email carries a CSV of the same facts, and the subject carries the vendor case reference. Vendor follow-ups at 14 days go to the same address as replies.

**When the vendor writes back.** The scheduler reads the AP mailbox over IMAP every 30 seconds (Gmail: the same app password as SMTP). A reply is matched to its dispute by email thread or by the case reference in the subject, stored once by Message-ID with the quoted original stripped, posted to #vendor-disputes, and handed to the Vendor Liaison, who reads the whole thread and does one of five things:

| The vendor... | The Vendor Liaison | Guardrail |
| --- | --- | --- |
| Issued the full credit | Books it with their memo number and closes the case | A message naming a different amount cannot be booked as a full credit |
| Refused | Books the charge to the owning team, pings the controller and the lead | |
| Asked for records or pushed back | Answers in the same thread with the evidence and clause, CSV attached | May only quote amounts already in the approved dispute |
| Offered a partial credit, or asked for something only staff know (PO, signature) | Asks the controller, with its recommendation, in Slack and on the task (Accept / Hold out / write an answer); the case stays open | A partial credit can only be booked after the controller answers, and is split: credit for what the vendor gave, the rest to the team |
| Only acknowledged | Notes it and keeps waiting | |

Out-of-office and other automatic replies are stored on the thread but not acted on. A bounce marks the dispute's email "Bounced" and pings the controller, since the vendor has not seen it. Attachment names (a credit memo PDF, say) are noted in the reply the liaison reads, and HTML-only replies are converted to text. Our own outgoing mail carries an `X-xAnthropenAI-Outbox` header so it is never read back as a reply, a reply cannot predate its letter, and once the vendor has answered the 14-day chase stops. A reply that arrived some other way can be pasted on the task.

**Simulated vendor (no mailbox connected).** When no email transport is set, which is always the case on the public demo, a model playing the provider's billing team answers each dispute a few seconds after it is sent (`MOCK_VENDOR_DELAY_MS`, default 6 s). Its first reply grants the credit, offers a partial credit, or asks for evidence (`MOCK_VENDOR_OUTCOME` pins one); once the Vendor Liaison answers, it settles in full. Replies go through the same intake as a real email, are marked "(simulated)" in the sender, and fall back to written templates when no live model is available. `MOCK_VENDOR=on|off` forces it either way.

**Slack threads and reactions.** Each approval request and each dispute is one message; everything after it goes in its thread. A decided approval gets a reaction on the request (✅ approved, ❌ rejected, ↩️ changes requested) and a thread reply with who decided and what happens next. A dispute's thread collects the vendor's replies, the liaison's answers and questions, follow-ups and the close; the close (and a bounce) also show in the channel, and the letter gets ✅ (credited), 🤝 (partial credit) or ❌ (denied). Replies and reactions wait until the message they belong to is posted, and a Slack rate limit pauses delivery for as long as Slack asks without counting as a failed attempt.

**Who gets pinged** (xAnthropenAI Slack workspace):

| Event | Where | Who |
| --- | --- | --- |
| Approval needed (proposal or learned policy) | #finance-approvals | Controller |
| Approval waiting 1 day / 3 days | DM / DM + #finance-approvals | Controller / CFO (backup approver) |
| An agent needs information (e.g. unknown owner) | #finance-ops | Controller |
| Dispute sent, vendor followed up, vendor replied, liaison answered | #vendor-disputes | FYI to the controller |
| Vendor offered less, or asked for something only staff know | #vendor-disputes + DM | Controller |
| Dispute unanswered 30 days | #vendor-disputes + DM | Controller |
| Dispute denied, charge moved to a team | #vendor-disputes | Controller and that team's lead |
| Team trending over budget | #budget-alerts | Team lead, plus the controller when at risk or over |

**Connecting the real thing.** For email, sign up for Resend with the address you put in `VENDOR_EMAIL` and set `RESEND_API_KEY` (Resend's test sender can only email the account owner), or use a Gmail app password in `SMTP_URL`. For Slack, create a free workspace, add an app with the scopes above, install it, set `SLACK_BOT_TOKEN`, and set `SLACK_USER_IDS` for whoever should be mentioned. Open `/api/comms/check` to see what is connected; `POST` it to retry failed messages, send a test to Slack and the vendor inbox, and check the mailbox for replies now.

### Agents and tools

| Agent | Tools |
| --- | --- |
| GPU Auditor | `get_work_item`, `get_instance_lifecycle`, `get_gpu_job_logs`, `get_experiment`, `get_provider_usage`, `get_billing_terms`, `submit_compute_findings`, `handoff_to_finance`, `request_human_info` |
| Capacity Planner | `get_work_item`, `find_related_experiments`, `get_experiment`, `get_billing_terms`, `submit_compute_findings`, `handoff_to_finance`, `request_human_info` |
| Cost Allocator | `get_work_item`, `get_project_budget`, `get_billing_terms`, `get_allocation_policy`, `search_precedents`, `calculate_cost_allocation`, `propose_adjustment`, `propose_vendor_dispute`, `request_human_approval`, `submit_for_posting`, `request_more_info` (reads the learned materiality policy through `get_allocation_policy`) |
| Vendor Liaison | `get_work_item`, `get_dispute_package`, `get_billing_terms`, `send_vendor_dispute`, `close_dispute`, and for follow-ups `get_dispute_status`, `send_vendor_follow_up`, `escalate_dispute` |
| Budget Analyst | `get_work_item`, `get_posted_charges`, `get_project_budget`, `forecast_project_burn`, `record_budget_note` |
| Controls Lead | `get_work_item`, `get_allocation_policy`, `search_precedents`, `propose_policy`, `handoff_to_finance`, and at onboarding `query_ap_history`, `propose_materiality_policy`, `finish_onboarding` |

All arithmetic is application code: billable hours, expected charges, allocations (largest-remainder rounding, always summing exactly), and dispute amounts. Agents choose actions and cite evidence; they cannot type amounts.

### Controls

- Role-based permissions per tool; agents can only act on their assigned work item.
- Agents cannot decide approvals or post. Only the ledger gateway posts, and only with an approved request or an approved standing policy.
- Segregation of duties: requesters and proposers cannot approve their own items; approvers must be human controllers.
- Guardrails reject findings that contradict the computed figures (for example, calling an overcharge "explained") and ownership claims not supported by retrieved records.
- Journal entries must balance, use known accounts, and are idempotent. Postings, journal lines, and audit events are append-only (SQLite triggers). Proposal content is immutable; approval decisions are final.
- Denied and failed actions are logged after the transaction rolls back, so they are never lost.
- Cited contract clauses must exist in that provider's contract.
- Repeated billing events are ignored without new work or postings.
- A dispute never reduces accounts payable. Only a vendor credit does.

## Proof it works

**What is real:** every agent decision, tool call, approval, policy, journal entry, follow-up, and audit event is application state, enforced by the same gateway in both execution modes. **What is simulated:** the provider feeds, scheduler, infrastructure controller, meters, experiment tracker, ERP, AP history, and vendor portal.

The seeded-case harness scores the agents against an answer key for every case (see [Evaluation](#evaluation)).

## Tests

```bash
npm test
```

- **Autonomy:** feed sync on a cursor with no duplicates, onboarding proposes the $50 threshold the history supports, the learned policy changes the outcome of a $12 variance, approval reminders and escalations fire once, waiting time is measured from the request, and an unanswered dispute is chased at 14 days and escalated at 30.
- **Contract clauses:** the Cost Allocator's clauses are accepted from a contract worded differently (where title matching finds nothing), made-up sections are rejected, and the dispute-window clause is added.
- **Email and Slack:** a dispute carries the lifecycle evidence and the cited clauses, the letter is stored on the dispute and emailed with a CSV attachment, the controller is pinged in Slack, and delivery through Resend and a Slack bot token is exercised with a stubbed network.
- **Arithmetic:** exact allocation sums and contract billable hours.
- **Correct billing:** an instance whose job ended early is explained with no dispute.
- **Scenario 1:** the Vendor Liaison sends the $1,200 dispute, and the liability stays unchanged until the Liaison books the vendor's credit.
- **Scenarios 2 and 3:** rejection, a policy proposed by the Controls Lead, rework, policy approval, a restart from the same database file, then automatic reuse next month with exact amounts.
- **Denials:** agents approving or posting, and gateway posting without approval, are denied and audited.
- **Ledger integrity:** unbalanced entries are rejected, duplicate ingestion is ignored, and the audit log is append-only with its hash chain intact.
- **LLM wiring:** the real Agents SDK run loop is driven by the SDK's `ScriptedModel`, including recovery from a guardrail rejection.
- **Evaluation:** every seeded case is scored against its answer key, and a wrong key is shown to fail.

## Evaluation

```bash
npm run eval                 # deterministic agents
AGENT_MODE=llm npm run eval  # LLM agents (needs OPENAI_API_KEY)
npm run eval:live            # two cases on the live model, key from .env.local
```

Each seeded case in `src/server/sim/cases.ts` has an answer key: the expected outcome, dispute amount, expense per project, and the policy that should authorize the posting. The harness (`src/server/eval/harness.ts`) seeds an in-memory database, lets the agents work every case, and plays the controller from the key: it approves matching proposals, rejects others with the key's correction, answers ownership questions, and sends the vendor reply. It reports:

- **Accuracy:** cases whose final state matches the key.
- **False-positive dispute rate:** disputes proposed on charges the records support.
- **Correct policy use:** postings authorized by the expected policy, or by a controller approval when no policy should apply.
- **Recovery:** cases that end correct after the controller rejected work.

Deterministic replay currently scores 35/35, 0/25 false-positive disputes, 33/33 policy use, and 3/3 recovered. Case O-02 depends on something only the controller knows, so a first dispute is expected; it counts toward recovery and is left out of the false-positive rate.

## Project layout

```
src/server/agents      tools, gateway, LLM runner (Agents SDK), deterministic policies, prompts
src/server/workflow    ingestion, checks, approvals, decisions, ledger gateway, policies, jobs
src/server/domain      money, billing, allocation, state machine
src/server/security    actors, permissions, guard
src/server/sim         seed data, demo scenarios, feed schedule, AP history (simulated source systems)
src/server/sync        billing feed sync with cursors (simulated outbox and HTTP adapter)
src/server/comms       people and channels, the outbox, email and Slack delivery, the AP mailbox reader
src/server/scheduler.ts, clock.ts   what starts work on its own, and the business clock
src/app                pages and API routes (SSE at /api/stream); /welcome is the landing page
src/proxy.ts           public demo: gives each browser its own sandbox id
src/components         landing page and intro, canvas, board, investigation workspace, audit trail
scripts/eval.ts        npm run eval (seeded-case harness)
drizzle/               SQL migrations
tests/                 Vitest suite
```

## Limitations

- **One user:** there is no login. Every human action is taken as the controller, named by `CONTROLLER_NAME` in the app, Slack and email alike; map the controller to a real Slack account with `SLACK_USERS` (`controller=...`).
- **Simulated systems:** the scheduler, infrastructure controller, provider meters, experiment tracker, ERP, AP history and billing feeds are simulated. Email and Slack are delivered only when configured; otherwise they are recorded on the task. Vendor replies are read from the mailbox when IMAP is set up, or pasted on the task; the **Simulate vendor** buttons work without email.
- **LLM vs replay:** with `OPENAI_API_KEY` the agents run on the live model; without it, and past the public demo's hourly cap, they use the deterministic replay, which is labeled as such in the UI. `npm run eval:live` checks two cases on the live model (a dispute and a charge that must not be disputed) using the key in `.env.local`; `npm run eval -- --case=O-01` runs any subset.
- **One node:** SQLite, the worker and the scheduler run inside the Next.js server process, so nothing happens while it is stopped (queued jobs and due follow-ups resume on restart). Restart the dev server after changing server code.
- **Reset wipes everything:** **Reset demo** deletes the sandbox, including its audit log. It is a demo control, not a production feature.
