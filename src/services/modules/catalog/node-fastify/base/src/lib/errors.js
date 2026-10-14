export class AppError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = 'Bad request', details) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this resource') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message = 'Conflict', details) => new AppError(409, 'conflict', message, details);

const CODES = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited'
};

export function errorHandler(err, req, reply) {
  if (err.validation) {
    return reply.status(400).send({
      code: 'validation_error',
      message: 'Request validation failed',
      fields: err.validation.map((v) => ({ path: v.instancePath || v.params?.missingProperty || '', message: v.message })),
      requestId: req.id
    });
  }
  const status = Number(err.statusCode ?? err.status) || 500;
  if (status >= 500) {
    req.log.error({ err }, 'request failed');
    return reply.status(status).send({ code: 'internal_error', message: 'Something went wrong', requestId: req.id });
  }
  const code = typeof err.code === 'string' && !err.code.startsWith('FST_') ? err.code : (CODES[status] ?? 'error');
  return reply.status(status).send({ code, message: err.message, details: err.details, requestId: req.id });
}

export function notFoundHandler(req, reply) {
  return reply.status(404).send({ code: 'not_found', message: 'Route not found', requestId: req.id });
}
