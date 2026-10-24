import { eq } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { AppContext } from "./context";
import { settings } from "./db/schema";
import { authorize, guard } from "./security/authorize";
import { ControlError } from "./security/errors";

export type ExecutionMode = "llm" | "deterministic";

export function getExecutionMode(ctx: AppContext): ExecutionMode {
  const row = ctx.db.select().from(settings).where(eq(settings.key, "execution_mode")).get();
  const mode = (row?.value as ExecutionMode | undefined) ?? ctx.config.defaultMode;
  if (mode === "llm" && !ctx.config.llmAvailable) return "deterministic";
  return mode;
}

export function setExecutionMode(ctx: AppContext, actorId: string, mode: ExecutionMode) {
  return guard(ctx, { actorId, action: "settings.execution_mode" }, () => {
    authorize(ctx, actorId, "settings:update");
    if (mode === "llm" && !ctx.config.llmAvailable) {
      throw new ControlError("OPENAI_API_KEY is not configured on the server", "CONFIGURATION", "FAILED");
    }
    ctx.db
      .insert(settings)
      .values({ key: "execution_mode", value: mode })
      .onConflictDoUpdate({ target: settings.key, set: { value: mode } })
      .run();
    appendAudit(ctx, { actorId, action: "settings.execution_mode", category: "system", details: { mode } });
    return mode;
  });
}
