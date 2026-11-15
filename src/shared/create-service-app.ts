import express, { type Router } from 'express';
import morgan from 'morgan';
import { config } from '../config';
import { errorHandler, notFoundHandler } from './errors';

/** Common Express setup for every backend service. */
export function createServiceApp(name: string, router: Router) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  if (!config.isTest) {
    app.use(morgan(`[${name}] :method :url :status :response-time ms`));
  }
  app.get('/health', (_req, res) => {
    res.json({ service: name, status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });
  app.use((_req, res, next) => {
    res.setHeader('x-served-by', `${name}-service`);
    next();
  });
  app.use(router);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
