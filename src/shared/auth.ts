import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config';
import { ApiError } from './errors';

export const ROLES = ['admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role | 'service';
}

export interface TokenClaims {
  sub: string;
  email: string;
  name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(user: { id: string; email: string; name: string; role: Role }): string {
  const claims: TokenClaims = { sub: user.id, email: user.email, name: user.name, role: user.role };
  return jwt.sign(claims, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn as SignOptions['expiresIn'],
    issuer: 'fleet-user-service',
  });
}

export function verifyToken(token: string): TokenClaims {
  try {
    return jwt.verify(token, config.jwt.secret, { issuer: 'fleet-user-service' }) as TokenClaims;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw ApiError.unauthorized('Token has expired', 'TOKEN_EXPIRED');
    throw ApiError.unauthorized('Token is invalid', 'TOKEN_INVALID');
  }
}

function bearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

function isServiceCall(req: Request): boolean {
  return req.header('x-service-token') === config.serviceToken;
}

/** Requires a valid JWT (Authorization: Bearer <token>). */
export const authenticate: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  try {
    const token = bearer(req);
    if (!token) throw ApiError.unauthorized('Missing bearer token', 'TOKEN_MISSING');
    const claims = verifyToken(token);
    req.user = { id: claims.sub, email: claims.email, name: claims.name, role: claims.role };
    next();
  } catch (err) {
    next(err);
  }
};

/** Role-based access control. Must run after `authenticate`. Internal service calls are always allowed. */
export const authorize =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (req.user.role === 'service' || roles.includes(req.user.role)) return next();
    next(ApiError.forbidden(`This action requires one of the roles: ${roles.join(', ')}`));
  };

/** Accepts either an internal service token (service-to-service call) or a JWT. */
export const authenticateUserOrService: RequestHandler = (req, res, next) => {
  if (isServiceCall(req)) {
    req.user = { id: 'system', email: 'system@fleet.internal', name: 'internal-service', role: 'service' };
    return next();
  }
  authenticate(req, res, next);
};

/** Optional auth: attaches req.user when a valid token is present, ignores it otherwise. */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = bearer(req);
  if (token) {
    try {
      const claims = verifyToken(token);
      req.user = { id: claims.sub, email: claims.email, name: claims.name, role: claims.role };
    } catch {
      /* ignore */
    }
  }
  next();
};
