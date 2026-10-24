export const WORK_ITEM_STATES = [
  "NEW",
  "INVESTIGATING",
  "NEEDS_INFO",
  "PROPOSED",
  "NEEDS_APPROVAL",
  "APPROVED",
  "POSTED",
  "DISPUTED",
  "RESOLVED",
] as const;

export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

/** Valid work-item state transitions. Anything else is rejected and audited. */
export const TRANSITIONS: Record<WorkItemState, WorkItemState[]> = {
  NEW: ["INVESTIGATING", "NEEDS_INFO"],
  INVESTIGATING: ["NEEDS_INFO", "PROPOSED"],
  NEEDS_INFO: ["INVESTIGATING"],
  PROPOSED: ["NEEDS_APPROVAL", "APPROVED", "INVESTIGATING", "NEEDS_INFO"],
  NEEDS_APPROVAL: ["APPROVED", "INVESTIGATING"],
  APPROVED: ["POSTED", "DISPUTED"],
  POSTED: ["RESOLVED"],
  DISPUTED: ["RESOLVED"],
  RESOLVED: [],
};

export function canTransition(from: WorkItemState, to: WorkItemState) {
  return TRANSITIONS[from].includes(to);
}

export const OPEN_STATES: WorkItemState[] = WORK_ITEM_STATES.filter((s) => s !== "RESOLVED");
