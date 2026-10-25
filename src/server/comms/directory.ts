import { ACTOR, controllerName } from "../security/actors";

/*
 * Atlas Research's people and Slack channels. The handles are what the bot
 * mentions; SLACK_USER_IDS maps them to real Slack user ids when a real
 * workspace is connected.
 */

export interface Person {
  handle: string;
  name: string;
  title: string;
  email: string;
  actorId?: string;
  projectId?: string;
}

export const PEOPLE: Person[] = [
  // The controller is whoever uses the app, so Slack and email use the same name the app shows (CONTROLLER_NAME).
  {
    handle: "priya",
    get name() {
      return controllerName();
    },
    title: "Controller",
    email: "controller@atlas-research.ai",
    actorId: ACTOR.controller,
  },
  { handle: "dana", name: "Dana Whitfield", title: "CFO", email: "dana@atlas-research.ai", actorId: ACTOR.cfo },
  { handle: "maya", name: "Dr. Maya Chen", title: "Lead, Frontier Language Models", email: "maya@atlas-research.ai", projectId: "PRJ-FLM" },
  { handle: "ravi", name: "Ravi Shah", title: "Lead, Multimodal Perception", email: "ravi@atlas-research.ai", projectId: "PRJ-MMP" },
  { handle: "elena", name: "Elena Petrova", title: "Lead, RL and Agents", email: "elena@atlas-research.ai", projectId: "PRJ-RLA" },
  { handle: "diego", name: "Diego Alvarez", title: "Lead, Inference Efficiency", email: "diego@atlas-research.ai", projectId: "PRJ-INF" },
];

export const CHANNELS = [
  { name: "finance-approvals", purpose: "Decisions waiting on the controller or CFO" },
  { name: "vendor-disputes", purpose: "Disputes sent to cloud providers, follow-ups, and replies" },
  { name: "budget-alerts", purpose: "Teams trending over their monthly compute budget" },
  { name: "finance-ops", purpose: "Questions the agents need a person to answer" },
] as const;

export type ChannelName = (typeof CHANNELS)[number]["name"];

export const BOT = { name: "MOA", title: "MOA bot" };

export function person(handle: string) {
  return PEOPLE.find((p) => p.handle === handle);
}

export function leadFor(projectId: string | null | undefined) {
  return PEOPLE.find((p) => p.projectId && p.projectId === projectId) ?? null;
}

export const CONTROLLER = "priya";
export const CFO = "dana";
