import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(message, statusCode = 400, code = 'bad_request', fields = null, details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;
    this.details = details;
  }
}

export function notFound(message = 'Resource not found', code = 'not_found') {
  return new AppError(message, 404, code);
}

export function unauthorized(message = 'Authentication required', code = 'unauthorized') {
  return new AppError(message, 401, code);
}

export function forbidden(message = 'You do not have permission for this resource', code = 'forbidden') {
  return new AppError(message, 403, code);
}

export function conflict(message = 'Resource conflict', code = 'conflict') {
  return new AppError(message, 409, code);
}

export function validationError(message = 'Validation failed', fields = null, details = null) {
  return new AppError(message, 400, 'validation_failed', fields, details);
}

export function errorHandler(err, req, res, next) {
  const requestId = req.id || 'req_unknown';

  if (err instanceof ZodError) {
    const fields = {};
    for (const issue of err.issues) {
      const fieldPath = issue.path.join('.');
      fields[fieldPath] = issue.message;
    }
    return res.status(400).json({
      code: 'validation_failed',
      message: 'Validation failed for request parameters or body',
      fields,
      requestId
    });
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
      ...(err.fields ? { fields: err.fields } : {}),
      ...(err.details ? { details: err.details } : {}),
      requestId
    });
  }

  console.error('[Unhandled Error]', err);
  return res.status(500).json({
    code: 'internal_error',
    message: err.message || 'An internal server error occurred',
    requestId
  });
}
