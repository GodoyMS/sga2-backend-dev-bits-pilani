import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'VALIDATION_ERROR', message, details);
  }
  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new ApiError(401, code, message);
  }
  static forbidden(message = 'You do not have permission to perform this action') {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Resource not found') {
    return new ApiError(404, 'NOT_FOUND', message);
  }
  static conflict(message: string) {
    return new ApiError(409, 'CONFLICT', message);
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export function errorBody(code: string, message: string, details?: unknown, requestId?: string): ErrorBody {
  return { error: { code, message, ...(details !== undefined && { details }), ...(requestId && { requestId }) } };
}

/** Wraps async route handlers so rejected promises reach the error middleware (Express 4). */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const notFoundHandler: RequestHandler = (req, res) => {
  res
    .status(404)
    .json(errorBody('ROUTE_NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`, undefined, req.header('x-request-id')));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.header('x-request-id');

  if (err instanceof ApiError) {
    res.status(err.status).json(errorBody(err.code, err.message, err.details, requestId));
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json(
      errorBody(
        'VALIDATION_ERROR',
        'Request validation failed',
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId,
      ),
    );
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json(errorBody('INVALID_JSON', 'Request body is not valid JSON', undefined, requestId));
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json(errorBody('PAYLOAD_TOO_LARGE', 'Request body is too large', undefined, requestId));
    return;
  }
  if (err?.code === '23505') {
    res.status(409).json(errorBody('CONFLICT', 'A record with the same unique value already exists', undefined, requestId));
    return;
  }

  if (process.env.NODE_ENV !== 'test') console.error('[unhandled]', err);
  res.status(500).json(errorBody('INTERNAL_ERROR', 'Unexpected server error', undefined, requestId));
};
