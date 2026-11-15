import { expect } from 'chai';
import request from 'supertest';
import { createGateway } from '../src/gateway/app';
import { API_KEY, startStack, USERS, type Stack } from './helpers';

describe('Flow 7 — API Gateway: API keys, routing, rate limiting, errors', () => {
  let stack: Stack;
  before(async () => {
    stack = await startStack();
  });
  after(async () => stack.close());

  describe('API key verification', () => {
    it('rejects requests without an API key (401 API_KEY_MISSING)', async () => {
      const res = await request(stack.gateway).get('/api/vehicles');
      expect(res.status).to.equal(401);
      expect(res.body.error.code).to.equal('API_KEY_MISSING');
    });

    it('rejects an unknown API key (403 API_KEY_INVALID)', async () => {
      const res = await request(stack.gateway).get('/api/vehicles').set('x-api-key', 'not-a-real-key');
      expect(res.status).to.equal(403);
      expect(res.body.error.code).to.equal('API_KEY_INVALID');
    });

    it('accepts any configured API key', async () => {
      const res = await request(stack.gateway).post('/api/users/login').set('x-api-key', 'second-test-key').send(USERS.admin);
      expect(res.status).to.equal(200);
    });

    it('keeps docs and health endpoints public', async () => {
      expect((await request(stack.gateway).get('/health')).status).to.equal(200);
      expect((await request(stack.gateway).get('/openapi.json')).body.openapi).to.match(/^3\./);
      expect((await request(stack.gateway).get('/docs/')).status).to.equal(200);
    });
  });

  describe('routing', () => {
    const cases: [string, string][] = [
      ['/api/users/login', 'user-service'],
      ['/api/vehicles', 'vehicle-service'],
      ['/api/telemetry/vehicle/2b7a6f0e-8a0a-4b8e-9a43-2f9d7d0f1a11', 'telemetry-service'],
      ['/api/maps/vehicles', 'geo-service'],
      ['/api/notifications', 'notification-service'],
    ];
    for (const [path, service] of cases) {
      it(`forwards ${path} to the ${service}`, async () => {
        const res = await request(stack.gateway).get(path).set('x-api-key', API_KEY);
        // Without a JWT most routes answer 401/404 — what matters is which service answered.
        expect(res.headers['x-served-by']).to.equal(service);
        expect(res.headers['x-gateway']).to.equal('fleet-api-gateway');
        expect(res.headers['x-request-id']).to.be.a('string');
      });
    }

    it('reports the health of every backend service', async () => {
      const res = await request(stack.gateway).get('/health/services');
      expect(res.status).to.equal(200);
      expect(res.body.services).to.have.length(5);
    });

    it('returns 404 ROUTE_NOT_FOUND for unknown API routes', async () => {
      const res = await request(stack.gateway).get('/api/spaceships').set('x-api-key', API_KEY);
      expect(res.status).to.equal(404);
      expect(res.body.error.code).to.equal('ROUTE_NOT_FOUND');
    });

    it('rejects malformed JSON at the gateway with 400 INVALID_JSON', async () => {
      const res = await request(stack.gateway)
        .post('/api/users/login')
        .set('x-api-key', API_KEY)
        .set('content-type', 'application/json')
        .send('{"email": "admin@fleet.local", "password": ');
      expect(res.status).to.equal(400);
      expect(res.body.error.code).to.equal('INVALID_JSON');
    });
  });

  describe('service unavailable', () => {
    it('returns 503 SERVICE_UNAVAILABLE when a backend service is down', async () => {
      const gw = createGateway({
        targets: { ...stack.targets, vehicle: 'http://127.0.0.1:1' }, // nothing listens on port 1
        apiKeys: [API_KEY],
        rateLimit: { windowMs: 60_000, max: 100 },
      });
      const res = await request(gw).get('/api/vehicles').set('x-api-key', API_KEY);
      expect(res.status).to.equal(503);
      expect(res.body.error.code).to.equal('SERVICE_UNAVAILABLE');
      expect(res.body.error.details.service).to.equal('vehicle');
    });
  });

  describe('rate limiting', () => {
    it('allows up to the limit, then returns 429 with rate-limit headers', async () => {
      const gw = createGateway({ targets: stack.targets, apiKeys: [API_KEY, 'other-key'], rateLimit: { windowMs: 60_000, max: 3 } });

      for (let i = 0; i < 3; i++) {
        const ok = await request(gw).get('/api/maps/vehicles').set('x-api-key', API_KEY);
        expect(ok.status).to.not.equal(429);
        expect(ok.headers).to.have.property('ratelimit');
      }
      const blocked = await request(gw).get('/api/maps/vehicles').set('x-api-key', API_KEY);
      expect(blocked.status).to.equal(429);
      expect(blocked.body.error.code).to.equal('RATE_LIMIT_EXCEEDED');
      expect(blocked.headers).to.have.property('retry-after');
    });

    it('tracks limits per API key', async () => {
      const gw = createGateway({ targets: stack.targets, apiKeys: [API_KEY, 'other-key'], rateLimit: { windowMs: 60_000, max: 1 } });
      expect((await request(gw).get('/api/maps/vehicles').set('x-api-key', API_KEY)).status).to.not.equal(429);
      expect((await request(gw).get('/api/maps/vehicles').set('x-api-key', API_KEY)).status).to.equal(429);
      expect((await request(gw).get('/api/maps/vehicles').set('x-api-key', 'other-key')).status).to.not.equal(429);
    });
  });
});
