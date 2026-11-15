import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { newDb } from 'pg-mem';
import request from 'supertest';
import { serviceUrls, type ServiceName } from '../src/config';
import { createGateway, type GatewayOptions } from '../src/gateway/app';
import { SERVICE_FACTORIES } from '../src/index';
import { seedDemoData } from '../src/seed';
import { setPool } from '../src/shared/db';
import { runMigrations } from '../src/shared/migrations';
import { setSmsProvider, StubSmsProvider } from '../src/services/notification/sms';

export const API_KEY = 'test-api-key';

export const USERS = {
  admin: { email: 'admin@fleet.local', password: 'Admin@123' },
  operator: { email: 'operator@fleet.local', password: 'Operator@123' },
  viewer: { email: 'viewer@fleet.local', password: 'Viewer@123' },
};

export interface Stack {
  gateway: ReturnType<typeof createGateway>;
  sms: StubSmsProvider;
  targets: Record<ServiceName, string>;
  servers: Partial<Record<ServiceName, Server>>;
  close: () => Promise<void>;
}

/**
 * Boots the whole system in-process: an in-memory Postgres (pg-mem) with demo data,
 * the five backend services on random local ports, and the API Gateway in front.
 */
export async function startStack(gatewayOverrides: Partial<GatewayOptions> = {}): Promise<Stack> {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  setPool(new Pool());
  await runMigrations();
  await seedDemoData();

  const sms = new StubSmsProvider();
  setSmsProvider(sms);

  const servers: Partial<Record<ServiceName, Server>> = {};
  const targets = {} as Record<ServiceName, string>;
  for (const [name, factory] of Object.entries(SERVICE_FACTORIES) as [ServiceName, () => any][]) {
    const server: Server = await new Promise((resolve) => {
      const s = factory().listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    targets[name] = `http://127.0.0.1:${port}`;
    serviceUrls[name] = targets[name];
    servers[name] = server;
  }

  const gateway = createGateway({
    targets,
    apiKeys: [API_KEY, 'second-test-key'],
    rateLimit: { windowMs: 60_000, max: 10_000 },
    ...gatewayOverrides,
  });

  return {
    gateway,
    sms,
    targets,
    servers,
    close: async () => {
      await Promise.all(Object.values(servers).map((s) => new Promise((r) => s!.close(() => r(null)))));
    },
  };
}

/** Logs in through the gateway and returns the JWT. */
export async function login(stack: Stack, who: keyof typeof USERS): Promise<string> {
  const res = await request(stack.gateway).post('/api/users/login').set('x-api-key', API_KEY).send(USERS[who]);
  if (res.status !== 200) throw new Error(`login failed for ${who}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

/** Supertest agent preconfigured with the API key (and optionally a JWT). */
export function api(stack: Stack, token?: string) {
  const wrap = (method: 'get' | 'post' | 'put' | 'patch' | 'delete') => (url: string) => {
    const r = request(stack.gateway)[method](url).set('x-api-key', API_KEY);
    return token ? r.set('authorization', `Bearer ${token}`) : r;
  };
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete') };
}
