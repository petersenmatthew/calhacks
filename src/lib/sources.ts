/**
 * xAnthropenAI's systems of record, shown as logos inside the canvas ring.
 * Each tool an employee calls reads from (or writes to) one of them.
 */
export type SourceId = "lambda" | "coreweave" | "nebius" | "kubernetes" | "wandb" | "netsuite" | "ironclad";

export type Source = { id: SourceId; name: string; logo: string; kind: string };

export const SOURCES: Source[] = [
  { id: "lambda", name: "Lambda", logo: "/logos/lambda.png", kind: "GPU cloud billing" },
  { id: "coreweave", name: "CoreWeave", logo: "/logos/coreweave.png", kind: "Reserved GPU capacity" },
  { id: "nebius", name: "Nebius", logo: "/logos/nebius.png", kind: "GPU cloud billing" },
  { id: "kubernetes", name: "Kubernetes", logo: "/logos/kubernetes.png", kind: "Cluster events and job logs" },
  { id: "wandb", name: "Weights & Biases", logo: "/logos/wandb.png", kind: "Experiment runs and owners" },
  { id: "netsuite", name: "NetSuite", logo: "/logos/netsuite.png", kind: "Ledger, AP, budgets" },
  { id: "ironclad", name: "Ironclad", logo: "/logos/ironclad.png", kind: "Provider contracts" },
];

export const SOURCE: Record<SourceId, Source> = Object.fromEntries(SOURCES.map((s) => [s.id, s])) as Record<SourceId, Source>;

export const PROVIDER_SOURCE: Record<string, SourceId> = {
  "PRV-HELIOS": "lambda",
  "PRV-STRATUS": "coreweave",
  "PRV-MERIDIAN": "nebius",
};

/** Which system a tool's data comes from. "provider" means the work item's GPU cloud. */
const TOOL_SOURCE: Record<string, SourceId | "provider"> = {
  get_work_item: "provider",
  get_provider_usage: "provider",
  get_instance_lifecycle: "kubernetes",
  get_gpu_job_logs: "kubernetes",
  find_related_experiments: "kubernetes",
  get_experiment: "wandb",
  get_billing_terms: "ironclad",
  get_project_budget: "netsuite",
  get_posted_charges: "netsuite",
  forecast_project_burn: "netsuite",
  submit_for_posting: "netsuite",
  send_vendor_dispute: "provider",
};

/** Tools that send data out to the system instead of reading from it. */
export const WRITE_TOOLS = new Set(["submit_for_posting", "send_vendor_dispute"]);

export function sourceForTool(tool: string | null | undefined, providerId: string | null | undefined): Source | null {
  const s = tool ? TOOL_SOURCE[tool] : undefined;
  if (!s) return null;
  if (s === "provider") {
    const id = providerId ? PROVIDER_SOURCE[providerId] : undefined;
    return id ? SOURCE[id] : null;
  }
  return SOURCE[s];
}
