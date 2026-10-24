# Hyphenate track context

We are entering the Hyphenate track at Cal Hacks 13.0: "The Hyphenated Enterprise: autonomous systems for finance." Source: the Hyphenate workshop deck, [hyphenate-workshop.pdf](./hyphenate-workshop.pdf).

## The brief

Build the system a finance team would bring on board. Pick a company, pick a few finance roles, and make it autonomous: AI that does the work on its own and explains every call. One area done deep beats ten done shallow.

## Prizes

- 1st: $8,000. 2nd: $5,000. 3rd: $3,000.
- Top 5 teams: expedited interview at Hyphenate for every member.

## How they judge

1. Is it real enough?
2. Would you hire it?
3. Did we see something new?
4. Did it have a "wow" moment?

## Strong vs. weak (from the deck)

Strong:

- A real company with a messy corner, and an answer key
- A few roles done deep, named in one line
- Asks at the right moment, and handles a no
- Limits enforced in code; a record of every call
- A moment on stage, and a score to back it

Weak:

- A chatbot over a spreadsheet, or a one-shot extractor
- Ten workflows, none of them deep
- Clean happy-path data that only works on the script
- An admin key, and "the prompt tells it not to"
- Memory that ends with the context window; "trust me"

## Their blueprint

Systems of record (bank, ERP, CRM, contracts) hold the truth about the business. A system of work holds the truth about the work: work items, decisions and reasons, questions and approvals, learned policies, and the log. You build the system of work. One gateway checks every write to the records.

A good system of work:

- **Self-learning:** learns the job at onboarding by mining past records and drafting policies for approval.
- **Self-improving:** turns each human correction into precedent, then proposes a general policy.
- **Audit trail:** answers "why?" months later with one query over an append-only log.

Build pieces: stateful sync of the records into one shape (cursor per source, stable ids, no duplicates); actors, actions, and resources with permissions checked on every call; agent tools that are CRUD on work items through a state machine; every transition logged as a diff, including denied attempts.

## How ExperimentLedger maps to it

Company: Atlas Research (fictional AI lab). Roles: GPU invoice reconciliation (Payables) and shared cost allocation, by a Compute Agent and a Finance Agent.

Already covered:

- Work items with a state machine, a tool gateway, role permissions, and separation of duties
- Append-only, hash-chained audit log, including denied actions
- Asks the controller for approval and reworks after a rejection
- Corrections become a reusable policy (ALLOC-SHARED v2) that later posts without approval
- Idempotent ingestion

Added for autonomy (see README, "What runs on its own"):

- **Continuous sync:** a scheduler inside the worker pulls provider billing feeds every few seconds with a cursor per source (`sync_cursors`), so work starts without clicks. An HTTP feed adapter (`BILLING_FEED_URL`) is the hook for a real provider.
- **Time:** a business clock drives follow-ups. Approvals are reminded after 1 day and escalated to the CFO after 3; unanswered vendor disputes are chased by the Finance Agent at 14 days and escalated at 30.
- **Self-learning at onboarding:** the Finance Agent mines six months of AP history and proposes a materiality policy ($50) that the history supports; once approved, small variances post without a dispute.
- **Answer key and score:** 14 planted cases with hand-computed outcomes (`npm run eval`, or the Autonomy page).

Remaining gaps:

- **Live LLM:** LLM mode has only been tested with the SDK's scripted model. Run `npm run eval -- --llm` once a key is available; the deterministic score is a check of the plumbing, not of model judgment.
- **Simulated systems of record:** provider feeds, scheduler, meters, ERP and the vendor portal are simulated.
