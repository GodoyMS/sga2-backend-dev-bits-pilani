import { randomUUID } from 'crypto';
import fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import cors from 'cors';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { config, type ServiceName } from '../config';
import { errorBody, errorHandler } from '../shared/errors';

/** Gateway route prefix → backend service. */
export const ROUTE_TABLE: { prefix: string; service: ServiceName }[] = [
  { prefix: '/api/users', service: 'user' },
  { prefix: '/api/vehicles', service: 'vehicle' },
  { prefix: '/api/telemetry', service: 'telemetry' },
  { prefix: '/api/maps', service: 'geo' },
  { prefix: '/api/notifications', service: 'notification' },
];

export interface GatewayOptions {
  /** Base URL for each backend service. */
  targets: Record<ServiceName, string>;
  apiKeys?: string[];
  rateLimit?: { windowMs: number; max: number };
  proxyTimeoutMs?: number;
}

const ROOT = path.resolve(__dirname, '..', '..');

export function loadOpenApiSpec(): Record<string, any> {
  return YAML.parse(fs.readFileSync(path.join(ROOT, 'docs', 'openapi.yaml'), 'utf8'));
}

/** Rejects requests without a valid `x-api-key` header. */
export function apiKeyGuard(validKeys: string[]): RequestHandler {
  const keys = new Set(validKeys);
  return (req, res, next) => {
    const key = req.header('x-api-key');
    const requestId = req.header('x-request-id');
    if (!key) {
      res.status(401).json(errorBody('API_KEY_MISSING', 'An API key is required in the x-api-key header', undefined, requestId));
      return;
    }
    if (!keys.has(key)) {
      res.status(403).json(errorBody('API_KEY_INVALID', 'The API key provided is not valid', undefined, requestId));
      return;
    }
    next();
  };
}

export function createGateway(opts: GatewayOptions) {
  const apiKeys = opts.apiKeys ?? config.gateway.apiKeys;
  const limits = opts.rateLimit ?? { windowMs: config.gateway.rateLimitWindowMs, max: config.gateway.rateLimitMax };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(cors({ exposedHeaders: ['x-request-id', 'x-served-by', 'x-gateway', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'retry-after'] }));

  // Correlation id for every request, forwarded to the services.
  app.use((req, res, next) => {
    const id = req.header('x-request-id') || randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    res.setHeader('x-gateway', 'fleet-api-gateway');
    next();
  });
  if (!config.isTest) app.use(morgan('[gateway] :method :url :status :response-time ms'));

  // ---- Public endpoints (no API key) ----
  app.get('/', (_req, res) => {
    res.json({
      name: 'Fleet Management System API Gateway',
      docs: '/docs',
      openapi: '/openapi.json',
      mapConsole: '/map',
      health: '/health',
      routes: ROUTE_TABLE.map((r) => ({ route: `${r.prefix}/*`, service: `${r.service}-service` })),
    });
  });
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'gateway', uptimeSeconds: Math.round(process.uptime()) });
  });
  app.get('/health/services', async (_req, res) => {
    const results = await Promise.all(
      ROUTE_TABLE.map(async ({ service }) => {
        try {
          const r = await fetch(`${opts.targets[service]}/health`, { signal: AbortSignal.timeout(3000) });
          return { service, status: r.ok ? 'up' : 'down' };
        } catch {
          return { service, status: 'down' };
        }
      }),
    );
    const allUp = results.every((r) => r.status === 'up');
    res.status(allUp ? 200 : 503).json({ status: allUp ? 'ok' : 'degraded', services: results });
  });

  const spec = loadOpenApiSpec();
  app.get('/openapi.json', (_req, res) => res.json(spec));
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Fleet Management System API',
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    }),
  );
  app.get('/map', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'map.html')));
  app.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js'))));

  // ---- Protected API: API key → rate limit → body validation → proxy ----
  app.use('/api', apiKeyGuard(apiKeys));
  app.use(
    '/api',
    rateLimit({
      windowMs: limits.windowMs,
      limit: limits.max,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => req.header('x-api-key') ?? req.ip ?? 'anonymous',
      handler: (req, res) => {
        res
          .status(429)
          .json(
            errorBody(
              'RATE_LIMIT_EXCEEDED',
              `Too many requests: limit is ${limits.max} per ${Math.round(limits.windowMs / 1000)}s per API key`,
              undefined,
              req.header('x-request-id'),
            ),
          );
      },
    }),
  );
  // Parse JSON at the edge so malformed bodies are rejected before reaching a service.
  app.use('/api', express.json({ limit: '100kb' }));

  for (const { prefix, service } of ROUTE_TABLE) {
    app.use(
      createProxyMiddleware<Request, Response>({
        target: opts.targets[service],
        pathFilter: (pathname) => pathname === prefix || pathname.startsWith(`${prefix}/`),
        changeOrigin: true,
        proxyTimeout: opts.proxyTimeoutMs ?? config.gateway.proxyTimeoutMs,
        on: {
          proxyReq: (proxyReq, req) => {
            proxyReq.setHeader('x-forwarded-by', 'fleet-api-gateway');
            proxyReq.removeHeader('x-service-token'); // never let clients impersonate internal services
            fixRequestBody(proxyReq, req);
          },
          error: (err, req, res) => {
            const r = res as ServerResponse<IncomingMessage>;
            if (!('writeHead' in r) || r.headersSent) return;
            const code = (err as NodeJS.ErrnoException).code;
            const timedOut = code === 'ECONNRESET' || code === 'ETIMEDOUT';
            r.writeHead(timedOut ? 504 : 503, { 'content-type': 'application/json' });
            r.end(
              JSON.stringify(
                errorBody(
                  timedOut ? 'SERVICE_TIMEOUT' : 'SERVICE_UNAVAILABLE',
                  timedOut ? `${service} service did not respond in time` : `${service} service is unavailable`,
                  { service, reason: code ?? err.message },
                  (req as IncomingMessage).headers['x-request-id'] as string,
                ),
              ),
            );
          },
        },
      }),
    );
  }

  app.use('/api', (req: Request, res: Response) => {
    res
      .status(404)
      .json(errorBody('ROUTE_NOT_FOUND', `No backend service handles ${req.method} ${req.originalUrl}`, undefined, req.header('x-request-id')));
  });
  app.use((req: Request, res: Response) => {
    res.status(404).json(errorBody('ROUTE_NOT_FOUND', `Unknown path ${req.originalUrl}`));
  });
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => errorHandler(err, req, res, next));
  return app;
}
