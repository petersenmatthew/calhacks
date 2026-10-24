import { Agent, run } from "@openai/agents";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { buildDecision, type Decision } from "@/lib/decision";
import { buildFrames, frameText, NODE_OF } from "@/lib/frames";
import type { AppContext } from "./context";
import { projects } from "./db/schema";
import { getDashboard, getWorkspace } from "./queries";

export type ChatMessage = { role: "user" | "assistant"; content: string };

const usd = (c: number) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** A compact, read-only picture of the books for the assistant. Facts only, no instructions. */
function briefing(ctx: AppContext, taskId: string | null) {
  const d = getDashboard(ctx);
  const m = d.metrics;
  const items = d.workItems.filter((i) => i.period === d.period);
  const lines = items.map((i) => {
    const waiting = i.pendingApproval ? "waiting on controller approval" : i.state === "NEEDS_INFO" ? "waiting on controller answer" : i.state.toLowerCase();
    const p = d.providers[i.providerId]?.shortName ?? i.providerId;
    return [i.id, p, i.title, "billed " + usd(i.amountCents), i.discrepancyCents ? "variance " + usd(i.discrepancyCents) : "no variance", waiting, "last: " + i.latestAction].join(" | ");
  });
  const parts = [
    "Company: Atlas Research, an AI lab. Period " + d.period + ".",
    "Reconciled " + (m.reconciledPct * 100).toFixed(1) + "% of " + usd(m.totalSpendCents) + " GPU spend across " + m.lineCount + " invoice lines.",
    "Potential overbilling " + usd(m.potentialOverchargeCents) + " on " + m.potentialOverchargeCount + " items. Pending approvals " + m.pendingApprovals + ". Month close target " + m.monthClose.target + ".",
    "Agents: " + d.agents.map((a) => (d.actors[a.agentId]?.name ?? a.agentId) + " " + a.status + (a.queued ? " (" + a.queued + " queued)" : "")).join("; ") + ".",
    "Tasks:",
    ...lines,
  ];
  if (taskId) {
    const w = getWorkspace(ctx, taskId);
    if (w) {
      const p = [...w.proposals].reverse()[0];
      parts.push(
        "",
        "The controller is looking at " + w.item.id + ": " + w.item.title + ".",
        ...w.findings.map((f) => "Finding: " + f.summary),
        ...(p ? ["Latest proposal (" + p.status + "): " + p.summary, "Rationale: " + p.rationale] : []),
        ...(w.item.pendingQuestion ? ["Open question: " + w.item.pendingQuestion.question] : []),
        ...w.policies.filter((x) => x.status === "APPROVED").map((x) => "Active policy " + x.policyKey + " v" + x.version + ": " + x.statement),
      );
    }
  }
  return parts.join("\n");
}

const INSTRUCTIONS = [
  "You are the finance team's assistant inside MOA. The person you talk to is the controller.",
  "Answer from the briefing only. If the briefing does not say, say you do not know.",
  "Be brief: one to three short sentences. Plain text. No headings, no bold, no emojis. Use a short list only when asked to list things.",
  "Refer to tasks by id, for example WI-1009, so the controller can click them.",
  "You cannot approve, post, or change anything. Decisions happen in the task view; point there when asked to act.",
].join(" ");

export async function askAssistant(ctx: AppContext, messages: ChatMessage[], taskId: string | null) {
  if (!ctx.config.llmAvailable) {
    return "Live answers need an OpenAI key. Set OPENAI_API_KEY and restart.";
  }
  const transcript = messages
    .slice(-10)
    .map((m) => (m.role === "user" ? "Controller: " : "Assistant: ") + m.content)
    .join("\n");
  const agent = new Agent({ name: "Assistant", instructions: INSTRUCTIONS, model: ctx.config.model });
  const input = "Briefing:\n" + briefing(ctx, taskId) + "\n\nConversation so far:\n" + transcript + "\n\nReply to the controller's last message.";
  const result = await run(agent, input, { maxTurns: 1 });
  return String(result.finalOutput ?? "").trim() || "I could not answer that.";
}

const clip = (v: unknown, n: number) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return s.length > n ? s.slice(0, n) + "..." : s;
};

/**
 * The controller talking to one employee about one frame of its work. The
 * employee answers in first person from the frame and the raw tool calls behind it.
 */
export async function askAboutFrame(ctx: AppContext, messages: ChatMessage[], taskId: string, frameId: string) {
  if (!ctx.config.llmAvailable) {
    return "Live answers need an OpenAI key. Set OPENAI_API_KEY and restart.";
  }
  const w = getWorkspace(ctx, taskId);
  const frame = w ? buildFrames(w).find((f) => f.id === frameId) : undefined;
  if (!w || !frame) return "I can't find that frame anymore. It may have been replaced by newer work.";

  const actorId = Object.keys(NODE_OF).find((id) => NODE_OF[id] === frame.node)!;
  const me = w.actors[actorId];
  const ids = new Set([frame.id, ...(frame.members ?? [])].filter((id) => id.startsWith("act-")).map((id) => Number(id.slice(4))));
  const calls = w.activity
    .filter((a) => ids.has(a.id))
    .map((a) => ["Call " + (a.toolName ?? a.type) + " at " + a.createdAt + " by " + (w.actors[a.actorId]?.name ?? a.actorId), "Args: " + clip(a.args, 800), "Result: " + clip(a.result, 1800)].join("\n"));
  const mine = w.activity
    .filter((a) => a.actorId === actorId && (a.toolName || a.status === "error" || a.status === "denied"))
    .map((a) => a.createdAt.slice(11, 19) + " " + (a.status === "error" || a.status === "denied" ? "BLOCKED " : "") + (a.toolName ?? "") + ": " + a.title);
  // What came after this frame, so a blocked step that was then redone is not described as still pending.
  const frameIds = [...ids];
  const lastId = frameIds.length ? Math.max(...frameIds) : 0;
  const after = w.activity
    .filter((a) => a.id > lastId)
    .slice(0, 15)
    .map((a) => a.createdAt.slice(11, 19) + " " + (w.actors[a.actorId]?.name ?? a.actorId) + ": " + a.title + (a.status === "error" || a.status === "denied" ? " (blocked)" : ""));
  const waiting = w.approvals.filter((a) => a.status === "PENDING").map((a) => "Waiting on the controller: approval " + a.id + " for " + a.subjectId + ".");

  const briefingText = [
    "Task " + w.item.id + ": " + w.item.title + " (state " + w.item.state.toLowerCase() + ").",
    "",
    "The frame the controller is looking at:",
    frameText(frame.spec),
    "",
    calls.length ? "Tool calls behind this frame:\n" + calls.join("\n\n") : "This frame comes from system records (intake rules, the ledger gateway or policy memory) rather than one of your tool calls.",
    "",
    "Everything you did on this task, in order:",
    ...(mine.length ? mine : ["(nothing yet)"]),
    "",
    "What happened on the task after this frame, in order:",
    ...(after.length ? after : ["(nothing; this is the latest step)"]),
    "Task state now: " + w.item.state.toLowerCase().replace(/_/g, " ") + ".",
    ...waiting,
    ...w.findings.map((f) => "Finding " + f.id + ": " + f.summary),
    ...w.policies.filter((x) => x.status === "APPROVED").map((x) => "Active policy " + x.policyKey + " v" + x.version + ": " + x.statement),
  ].join("\n");

  const name = me?.name ?? actorId;
  const instructions = [
    "You are " + name + (me?.title ? ", " + me.title : "") + ", an AI employee on the Atlas Research finance team.",
    "The controller opened one of your work frames and is asking you about it. Answer in first person as the one who did this work.",
    "Answer only from the briefing: the frame, the tool calls behind it, and your activity. If it does not say, say you do not know or what you would need to check.",
    "If the frame is a blocked or failed step, check what happened after it: if you or a teammate redid it successfully, say so and give the result (for example the proposal id and where the task stands now). Never say something still needs to be done when the briefing shows it was done.",
    "Be brief: two to four short sentences. Plain text. No headings, no bold, no emojis. Cite exact numbers, record ids and clause numbers when they matter.",
    "If the controller disagrees, explain your reasoning once, plainly. You cannot change records from this chat; say the controller can decide or redirect the work in the task view.",
  ].join(" ");
  const transcript = messages
    .slice(-10)
    .map((m) => (m.role === "user" ? "Controller: " : name + ": ") + m.content)
    .join("\n");
  const agent = new Agent({ name, instructions, model: ctx.config.model });
  const result = await run(agent, "Briefing:\n" + briefingText + "\n\nConversation so far:\n" + transcript + "\n\nReply to the controller's last message.", { maxTurns: 1 });
  return String(result.finalOutput ?? "").trim() || "I could not answer that.";
}


/* ------------------------------------------------------------------ talking through a decision */

/** A budget change the controller asked for alongside their decision. */
export type BudgetChange = { projectId: string; projectName: string; monthlyCents: number };

export type DecisionTurn = { reply: string; choiceId: string | null; note: string | null; budget: BudgetChange | null };

const Turn = z.object({
  reply: z.string().describe("What you say to the controller."),
  choice_id: z.string().nullable().describe("Id of the option the controller clearly chose in their last message, else null."),
  note: z
    .string()
    .nullable()
    .describe("Anything the controller said beyond the option: their extra instruction (the 'but' in 'yes, but'), or their own instruction or answer when they chose no option. Else null."),
  budget_project_id: z.string().nullable().describe("If the controller asked to set a project's monthly budget, that project's id, else null."),
  budget_monthly_usd: z.number().nullable().describe("The new monthly budget in US dollars, only when the controller gave or agreed to a figure, else null."),
  waiting_on_detail: z.boolean().describe("True when your reply asks the controller for a detail you still need before they confirm, such as a budget amount."),
});

/** Opening messages, kept until the decision changes. */
const openers = new Map<string, string>();

function decisionBriefing(ctx: AppContext, w: NonNullable<ReturnType<typeof getWorkspace>>, d: Decision) {
  const p = [...w.proposals].reverse()[0];
  return [
    "Task " + w.item.id + ": " + w.item.title + ". " + d.context + ".",
    "The decision on screen: " + d.title + ". " + d.ask + ".",
    "Options shown as buttons:",
    ...d.choices.map((c) => "- id " + c.id + ": " + c.label + (c.hint ? " (" + c.hint + ")" : "") + (c.primary ? " [your recommendation]" : "")),
    d.custom === "changes"
      ? "The controller may also tell you to do something else; that sends the work back with their instruction."
      : d.custom === "answer"
        ? "The controller may also answer in their own words."
        : "",
    "Facts behind your recommendation: " + d.why.join(" "),
    ...w.findings.map((f) => "Finding " + f.id + ": " + f.summary),
    ...(p ? ["Proposal " + p.id + " (" + p.status + "): " + p.summary, "Rationale: " + p.rationale] : []),
    ...(w.item.pendingQuestion ? ["Open question: " + w.item.pendingQuestion.question] : []),
    ...w.policies.filter((x) => x.status === "APPROVED").map((x) => "Active policy " + x.policyKey + " v" + x.version + ": " + x.statement),
    "Research project monthly compute budgets (the Budget Analyst can change one when the controller says so):",
    ...ctx.db.select().from(projects).all().map((x) => "- id " + x.id + ": " + x.name + ", " + usd(x.monthlyBudgetCents) + " a month"),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Without a model: the first fact and the recommendation. */
function plainOpener(d: Decision) {
  const rec = d.choices.find((c) => c.primary) ?? d.choices[0];
  return [d.why[0], rec ? "I'd go with " + rec.label.toLowerCase() + (rec.hint ? ", " + rec.hint : "") + "." : d.ask + "."].filter(Boolean).join(" ");
}

/**
 * The controller talking a decision through with the employee who asked for it.
 * With no messages it returns the employee's opening line. Otherwise it answers and,
 * when the controller has clearly decided, says which option (or what instruction) they meant.
 * Nothing is recorded here; the controller confirms in the task view.
 */
export async function discussDecision(ctx: AppContext, messages: ChatMessage[], taskId: string): Promise<DecisionTurn> {
  const w = getWorkspace(ctx, taskId);
  const d = w ? buildDecision(w) : null;
  if (!w || !d) return { reply: "This one is already decided.", choiceId: null, note: null, budget: null };
  const me = w.actors[d.askedBy];
  const name = me?.name ?? "Agent";
  const key = taskId + ":" + (d.approvalId ?? "q") + ":" + d.choices.map((c) => c.id).join(",");

  const none = { choiceId: null, note: null, budget: null };
  if (!messages.length && openers.has(key)) return { reply: openers.get(key)!, ...none };
  if (!ctx.config.llmAvailable) {
    if (!messages.length) return { reply: plainOpener(d), ...none };
    const said = messages.at(-1)!.content.toLowerCase();
    const pick = d.choices.find((c) => said.includes(c.label.toLowerCase().split(" ")[0]));
    return pick
      ? { reply: "Got it: " + pick.label.toLowerCase() + ". Confirm and I'll do it.", ...none, choiceId: pick.id }
      : { reply: "Live answers need an OpenAI key. Pick an option above, or set OPENAI_API_KEY.", ...none };
  }

  const instructions = [
    "You are " + name + (me?.title ? ", " + me.title : "") + ", an AI employee on the Atlas Research finance team, talking to the controller about a decision you need from them.",
    "Speak in first person, plainly, like a colleague. Plain text. No headings, no bold, no lists, no emojis.",
    "Use only the briefing. If it does not say, say what you would need to check.",
    messages.length
      ? [
          "Reply to the controller's last message in one to three short sentences. Never say it is done.",
          "If they clearly chose one of the options, set choice_id to its id.",
          "If they said yes to an option but also asked for something more (yes, but), set choice_id and also put the extra part in note, in their words, cleaned up. Do not drop it.",
          "If they want something that is not an option at all, leave choice_id null and put their instruction in note.",
          "If they asked to change a project's monthly budget, set budget_project_id and budget_monthly_usd. If they gave no figure (for example 'lower it'), ask what the new monthly budget should be and set waiting_on_detail.",
          "Say in one short sentence everything that will happen once they hit Confirm, including the extra part. If no one on the team can do the extra part, say so plainly.",
          "If they are asking or unsure, leave everything null.",
        ].join(" ")
      : "Write your opening message: under 25 words, like a quick note to a colleague. What happened in everyday words, then what you would do. No record ids, policy names or clause numbers. Do not list the options; they are shown as buttons. All other fields are null.",
  ].join(" ");
  // The opening line is part of the conversation the controller is replying to.
  const history = messages.length && openers.has(key) ? [{ role: "assistant" as const, content: openers.get(key)! }, ...messages] : messages;
  const transcript = history
    .slice(-12)
    .map((m) => (m.role === "user" ? "Controller: " : name + ": ") + m.content)
    .join("\n");
  const agent = new Agent({ name, instructions, model: ctx.config.model, outputType: Turn });
  const input = "Briefing:\n" + decisionBriefing(ctx, w, d) + (transcript ? "\n\nConversation so far:\n" + transcript : "");
  const result = await run(agent, input, { maxTurns: 1 });
  const out = result.finalOutput;
  const reply = out?.reply?.trim() || (messages.length ? "Sorry, say that again?" : plainOpener(d));
  if (!messages.length) {
    openers.set(key, reply);
    return { reply, ...none };
  }
  // Nothing to confirm while the employee is still asking for a detail.
  if (out?.waiting_on_detail) return { reply, ...none };
  const choiceId = out?.choice_id && d.choices.some((c) => c.id === out.choice_id) ? out.choice_id : null;
  const said = out?.note?.trim() ?? "";
  // With a choice, the note rides along with it. Without one, it only counts where free text is allowed.
  const note = said.length >= 3 && (choiceId || d.custom) ? said.slice(0, 1000) : null;
  const project = out?.budget_project_id ? ctx.db.select().from(projects).where(eq(projects.id, out.budget_project_id)).get() : undefined;
  const usdAmount = out?.budget_monthly_usd ?? 0;
  // A budget change only goes through alongside an approval.
  const approving = choiceId ? d.choices.find((c) => c.id === choiceId)?.action.type === "approve" : false;
  const budget =
    project && approving && usdAmount > 0 && usdAmount < 1e9 ? { projectId: project.id, projectName: project.name, monthlyCents: Math.round(usdAmount * 100) } : null;
  return { reply, choiceId, note, budget };
}
