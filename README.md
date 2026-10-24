# ExperimentLedger

Autonomous finance operations for AI research labs. A team of six AI employees reconciles GPU invoices against what actually ran, disputes overcharges with cloud vendors, allocates shared cluster costs, watches research team budgets, and learns policy from the controller's corrections. They ask the controller when a decision needs a human. Every action is a typed tool call through an application gateway, written to an append-only audit log.

| Employee | Job |
| --- | --- |
| Compute Investigator | Figures out what actually ran behind an instance charge |
| Capacity Planner | Reconstructs who used a shared GPU reservation and how much sat idle |
| Cost Accountant | Charges costs to research teams under policy and drafts disputes |
| Vendor Liaison | Sends approved disputes to the provider and closes the case on their reply |
| Budget Analyst | Checks a team's burn against its budget after anything posts to it |
| Policy Analyst | Turns controller corrections into reusable policy |

The fictional lab is **Atlas Research**. All source systems (scheduler, infrastructure controller, provider meters, invoices, ERP) are simulated in SQLite. The agent decisions, approvals, postings, and audit trail are real application state.

## Quick start

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
# open http://localhost:3000
```

The first request creates `data/experiment-ledger.db`, loads the October 2026 sandbox, and starts the background worker. One seeded invoice is left for the agents, so the team is working when you open the dashboard.

Production build:

```bash
npm run build && npm start
```

## Environment variables

Copy `.env.example` to `.env.local`. All are optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | unset | Enables LLM agents through the OpenAI Agents SDK. Without it the app runs in **Deterministic replay**. Server-side only. |
| `OPENAI_MODEL` | Agents SDK default | Model for LLM agents. |
| `AGENT_MODE` | `llm` if a key is set, else `deterministic` | Starting execution mode. You can also switch modes in the sidebar. |
| `DETERMINISTIC_STEP_DELAY_MS` | `700` | Pause between deterministic agent steps so the live timeline is watchable. |
| `DATABASE_PATH` | `./data/experiment-ledger.db` | SQLite file. |
| `OPENAI_AGENTS_DISABLE_TRACING` | unset | Set to `1` to stop the SDK exporting traces to OpenAI. |

### Execution modes

- **LLM agents.** Each agent turn is an OpenAI Agents SDK run with typed Zod tools. The model chooses tools and writes findings; the run ends only when a terminal tool (handoff, approval request, posting request) succeeds.
- **Deterministic replay.** A fixed, scripted decision policy calls the same tools through the same gateway, with the same permissions and audit. It exists for demos without credentials and for tests. Runs in this mode are labeled "Deterministic replay" everywhere in the UI and are never presented as LLM output.

## Three-minute demo

1. **Work** has two views. **Board** is a Kanban (Investigate, Propose, Needs you, Vendor, Done) where the card an agent is on shows its live steps. **Canvas** puts the six employees on a ring around you. Each one spawns a small frame per piece of work; click an employee to zoom to its frames, and click a frame to zoom in and replay it (the query it ran, the rows it got back, the rules it checked, the letter it wrote).
2. Click **Simulate billing event**, keep **GPU overbilling**, and send it. Helios bills 36 h at $100/h for an instance whose lifecycle shows 24 h. Deterministic checks open a work item and assign the Compute Investigator.
3. Open the investigation. The **Flow** tab shows each agent's steps and what it gathered; **Log** has every tool call. Watch the Compute Investigator pull the lifecycle, scheduler log, provider meter, and contract, then hand off. The Cost Accountant cites the Helios precedent and proposes a $1,200 dispute. The chart shows the 12 h billed after termination.
4. **Approve** the dispute. The Vendor Liaison writes the letter and sends it; the ledger gateway submits it and posts only the supported $2,400. Accounts payable stays at $3,600 until you click **Vendor issues credit**, after which the Vendor Liaison reads the reply, books the credit, and closes the case. The Budget Analyst checks the team's burn after each posting.
5. Simulate **Shared cluster allocation** ($12,400, two teams). The Capacity Planner reconstructs usage and idle capacity. The Cost Accountant follows written policy v1 (usage split: $6,975 / $5,425) and tries to post it. The ledger gateway denies the posting because v1 conflicts with the reservation terms (a red denied event in the timeline and audit), so the agent requests approval instead.
6. **Reject** it with: "Reserved capacity must be charged to the team that owns the reservation, subject to company policy." The Policy Analyst proposes reusable policy **ALLOC-SHARED v2** from your correction, and the Cost Accountant reworks the allocation ($8,060 / $4,340). Approve both.
7. Simulate **Next month: similar reservation**. The agents apply the learned policy and the gateway posts it automatically, citing the policy approval. No new approval is needed.
8. Open **Audit trail**: every tool call, decision, posting, and denied action, hash-chained, plus policy versions, journal entries, and a trial balance.

**Custom invoice line** lets you type any hours and rate to create a discrepancy that is not scripted. **Resend last billing event** proves idempotency. **Reset demo** reloads the sandbox.

## How it works

```mermaid
flowchart LR
  Feed[Provider billing event] --> Ingest[Ingestion + deterministic checks]
  Ingest -->|clean| Auto[Auto-match under approved policy]
  Ingest -->|exception| WI[(Work item)]
  WI --> Queue[(Durable job queue)]
  Queue --> Compute[Compute Investigator or Capacity Planner]
  Compute -->|handoff| Finance[Cost Accountant]
  Compute & Finance & Vendor & Policy & Budget --> Gateway[Tool gateway: RBAC, scope, validation, evidence, audit]
  Finance -->|request approval| Human[Controller decision]
  Human -->|rejected| Policy[Policy Analyst]
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
- **Collaboration** happens through the shared work item. The Compute Investigator records structured findings and hands off; the Cost Accountant reads them, proposes, and can send questions back.
- **Durability.** Jobs live in SQLite. Interrupted jobs are re-queued on restart, and approvals pause a workflow until a human decides.
- **Live updates.** Activity rows are streamed over server-sent events; a reconnect replays missed rows.

### Agents and tools

| Agent | Tools |
| --- | --- |
| Compute Investigator | `get_work_item`, `get_instance_lifecycle`, `get_gpu_job_logs`, `get_experiment`, `get_provider_usage`, `get_billing_terms`, `submit_compute_findings`, `handoff_to_finance`, `request_human_info` |
| Capacity Planner | `get_work_item`, `find_related_experiments`, `get_experiment`, `get_billing_terms`, `submit_compute_findings`, `handoff_to_finance`, `request_human_info` |
| Cost Accountant | `get_work_item`, `get_project_budget`, `get_allocation_policy`, `search_precedents`, `calculate_cost_allocation`, `propose_adjustment`, `propose_vendor_dispute`, `request_human_approval`, `submit_for_posting`, `request_more_info` |
| Vendor Liaison | `get_work_item`, `get_dispute_package`, `get_billing_terms`, `send_vendor_dispute`, `close_dispute` |
| Budget Analyst | `get_work_item`, `get_posted_charges`, `get_project_budget`, `forecast_project_burn`, `record_budget_note` |
| Policy Analyst | `get_work_item`, `get_allocation_policy`, `search_precedents`, `propose_policy`, `handoff_to_finance` |

All arithmetic is application code: billable hours, expected charges, allocations (largest-remainder rounding, always summing exactly), and dispute amounts. Agents choose actions and cite evidence; they cannot type amounts.

### Controls

- Role-based permissions per tool; agents can only act on their assigned work item.
- Agents cannot decide approvals or post. Only the ledger gateway posts, and only with an approved request or an approved standing policy.
- Segregation of duties: requesters and proposers cannot approve their own items; approvers must be human controllers.
- Guardrails reject findings that contradict the computed figures (for example, calling an overcharge "explained") and ownership claims not supported by retrieved records.
- Journal entries must balance, use known accounts, and are idempotent. Postings, journal lines, and audit events are append-only (SQLite triggers). Proposal content is immutable; approval decisions are final.
- Denied and failed actions are logged after the transaction rolls back, so they are never lost.
- Repeated billing events are ignored without new work or postings.
- A dispute never reduces accounts payable. Only a vendor credit does.

## Tests

```bash
npm test
```

- **Arithmetic:** exact allocation sums and contract billable hours.
- **Correct billing:** an instance whose job ended early is explained with no dispute.
- **Scenario 1:** the Vendor Liaison sends the $1,200 dispute, and the liability stays unchanged until the Liaison books the vendor's credit.
- **Scenarios 2 and 3:** rejection, a policy proposed by the Policy Analyst, rework, policy approval, a restart from the same database file, then automatic reuse next month with exact amounts.
- **Denials:** agents approving or posting, and gateway posting without approval, are denied and audited.
- **Ledger integrity:** unbalanced entries are rejected, duplicate ingestion is ignored, and the audit log is append-only with its hash chain intact.
- **LLM wiring:** the real Agents SDK run loop is driven by the SDK's `ScriptedModel`, including recovery from a guardrail rejection.

## Project layout

```
src/server/agents      tools, gateway, LLM runner (Agents SDK), deterministic policies, prompts
src/server/workflow    ingestion, checks, approvals, decisions, ledger gateway, policies, jobs
src/server/domain      money, billing, allocation, state machine
src/server/security    actors, permissions, guard
src/server/sim         seed data and demo scenarios (simulated source systems)
src/app                pages and API routes (SSE at /api/stream)
src/components         dashboard, investigation workspace, audit trail
drizzle/               SQL migrations
tests/                 Vitest suite
```

## Limitations

- **LLM mode:** no OpenAI key was available while building, so LLM mode was verified through the SDK's scripted model, not live model calls. Deterministic replay is the default when no key is set.
- **One demo user:** there is no login. Every human action is taken as the controller, Priya Natarajan.
- **Simulated systems:** source systems, the ERP, and the vendor portal are simulated, and vendor responses are triggered from the UI.
- **Investigation page:** the Flow tab on an investigation still shows only the Compute Investigator and the Cost Accountant. The Canvas shows all six.
- **Existing databases:** actors are append-only, so a database created before the rename keeps the old names "Compute Agent" and "Finance Agent" until **Reset demo**. The four new employees are added automatically at startup.
- **Single-node storage:** SQLite runs on one node. The worker runs inside the Next.js server process; restart the dev server after changing server code.
- **Reset wipes everything:** Reset demo deletes the sandbox, including its audit log. It is a demo control, not a production feature.
