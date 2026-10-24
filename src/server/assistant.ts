import { Agent, run } from "@openai/agents";
import type { AppContext } from "./context";
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
  "You are the finance team's assistant inside ExperimentLedger. The person you talk to is the controller.",
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

