export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string = 'Resource not found') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string = 'Bad request') {
    super(message, 400);
    this.name = 'BadRequestError';
  }
}

export class ConflictError extends HttpError {
  constructor(message: string = 'Conflict') {
    super(message, 409);
    this.name = 'ConflictError';
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string = 'Forbidden') {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

export class WorkflowDeadlockError extends HttpError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'WorkflowDeadlockError';
  }
}

export class InvalidPhaseTransitionError extends HttpError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'InvalidPhaseTransitionError';
  }
}

export class SprintConflictError extends HttpError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'SprintConflictError';
  }
}

export class GateApprovalConflictError extends HttpError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'GateApprovalConflictError';
  }
}

export class WorkflowInvariantViolationError extends HttpError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'WorkflowInvariantViolationError';
  }
}
