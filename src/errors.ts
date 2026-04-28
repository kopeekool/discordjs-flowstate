/**
 * Base class for every error thrown by `discordjs-flowstate`. Catch this if you
 * want to handle library failures distinctly from generic runtime errors.
 */
export class FlowStateError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FlowStateError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a flow definition references a state that does not exist in the
 * `states` map.
 */
export class UnknownStateError extends FlowStateError {
  constructor(flowId: string, state: string) {
    super(
      "UNKNOWN_STATE",
      `Flow "${flowId}" has no state named "${state}".`,
    );
    this.name = "UnknownStateError";
  }
}

/**
 * Thrown when a flow definition fails validation at construction time.
 */
export class InvalidFlowDefinitionError extends FlowStateError {
  constructor(message: string) {
    super("INVALID_FLOW_DEFINITION", message);
    this.name = "InvalidFlowDefinitionError";
  }
}

/**
 * Thrown when a routed interaction references an execution that no longer
 * exists in the storage adapter (expired, completed, or never created).
 */
export class ExecutionNotFoundError extends FlowStateError {
  constructor(executionId: string) {
    super(
      "EXECUTION_NOT_FOUND",
      `No active execution with id "${executionId}". It may have expired or completed.`,
    );
    this.name = "ExecutionNotFoundError";
  }
}

/**
 * Thrown when a transition's guard returns `false`.
 */
export class GuardRejectedError extends FlowStateError {
  constructor(state: string, trigger: string) {
    super(
      "GUARD_REJECTED",
      `Guard for transition "${state}" → "${trigger}" rejected.`,
    );
    this.name = "GuardRejectedError";
  }
}

/**
 * Thrown when a non-owner attempts to advance an `ownerOnly` state.
 */
export class NotFlowOwnerError extends FlowStateError {
  constructor() {
    super(
      "NOT_FLOW_OWNER",
      "Only the user who started this flow can interact with it.",
    );
    this.name = "NotFlowOwnerError";
  }
}
