import { ZodError } from "zod";
import { isControlError } from "./security/errors";

export function errorResponse(error: unknown) {
  if (isControlError(error)) {
    return Response.json({ error: error.message, rule: error.rule }, { status: error.outcome === "DENIED" ? 403 : 422 });
  }
  if (error instanceof ZodError) {
    return Response.json({ error: "Invalid request", issues: error.issues }, { status: 400 });
  }
  console.error(error);
  return Response.json({ error: error instanceof Error ? error.message : "Unexpected error" }, { status: 500 });
}
