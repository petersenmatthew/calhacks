/**
 * A control violation (permission, segregation of duties, approval, or state
 * machine). Thrown inside transactions; the outermost guard records it in the
 * audit log after the rollback so denials are never lost.
 */
export class ControlError extends Error {
  recorded = false;
  constructor(
    message: string,
    public readonly rule: string,
    public readonly outcome: "DENIED" | "FAILED" = "DENIED",
  ) {
    super(message);
    this.name = "ControlError";
  }
}

export function isControlError(error: unknown): error is ControlError {
  return error instanceof ControlError;
}
