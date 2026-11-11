/** Errors the HTTP layer maps to status codes. `body` overrides the default { error } response. */
export class AppError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super(message, 400);
  }
}

export class NotFoundError extends AppError {
  constructor(message) {
    super(message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message) {
    super(message, 409);
  }
}

/** Some rows of an import are invalid: 422 with { errors: [{ row, error }] }. */
export class ImportError extends AppError {
  constructor(errors) {
    super(`${errors.length} invalid row(s)`, 422, { errors });
  }
}
