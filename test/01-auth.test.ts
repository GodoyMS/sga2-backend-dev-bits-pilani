import { expect } from 'chai';
import jwt from 'jsonwebtoken';
import { api, login, startStack, USERS, type Stack } from './helpers';

describe('Flow 1 — User login and JWT verification', () => {
  let stack: Stack;
  before(async () => {
    stack = await startStack();
  });
  after(async () => stack.close());

  it('logs in with valid credentials and returns a signed JWT', async () => {
    const res = await api(stack).post('/api/users/login').send(USERS.admin);

    expect(res.status).to.equal(200);
    expect(res.body).to.include.keys('token', 'tokenType', 'expiresAt', 'user');
    expect(res.body.tokenType).to.equal('Bearer');
    expect(res.body.user).to.include({ email: 'admin@fleet.local', role: 'admin' });
    expect(res.body.user).to.not.have.property('password_hash');

    const decoded = jwt.verify(res.body.token, 'test-jwt-secret') as jwt.JwtPayload;
    expect(decoded.sub).to.equal(res.body.user.id);
    expect(decoded.role).to.equal('admin');
    expect(decoded.iss).to.equal('fleet-user-service');
  });

  it('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
    const res = await api(stack).post('/api/users/login').send({ email: USERS.admin.email, password: 'wrong-password' });
    expect(res.status).to.equal(401);
    expect(res.body.error.code).to.equal('INVALID_CREDENTIALS');
  });

  it('rejects a malformed login body with 400', async () => {
    const res = await api(stack).post('/api/users/login').send({ email: 'not-an-email' });
    expect(res.status).to.equal(400);
    expect(res.body.error.code).to.equal('VALIDATION_ERROR');
  });

  it('verifies a valid token via GET /api/users/verify', async () => {
    const token = await login(stack, 'operator');
    const res = await api(stack, token).get('/api/users/verify');
    expect(res.status).to.equal(200);
    expect(res.body.valid).to.equal(true);
    expect(res.body.claims).to.include({ email: 'operator@fleet.local', role: 'operator' });
  });

  it('returns the current profile from /api/users/me', async () => {
    const token = await login(stack, 'viewer');
    const res = await api(stack, token).get('/api/users/me');
    expect(res.status).to.equal(200);
    expect(res.body.user.role).to.equal('viewer');
  });

  it('rejects requests without a token (401 TOKEN_MISSING)', async () => {
    const res = await api(stack).get('/api/users/me');
    expect(res.status).to.equal(401);
    expect(res.body.error.code).to.equal('TOKEN_MISSING');
  });

  it('rejects a tampered token (401 TOKEN_INVALID)', async () => {
    const forged = jwt.sign({ sub: 'x', role: 'admin', email: 'a@b.c', name: 'x' }, 'some-other-secret', {
      issuer: 'fleet-user-service',
    });
    const res = await api(stack, forged).get('/api/users/verify');
    expect(res.status).to.equal(401);
    expect(res.body.error.code).to.equal('TOKEN_INVALID');
  });

  it('rejects an expired token (401 TOKEN_EXPIRED)', async () => {
    const expired = jwt.sign(
      { sub: 'x', role: 'admin', email: 'a@b.c', name: 'x', exp: Math.floor(Date.now() / 1000) - 60 },
      'test-jwt-secret',
      { issuer: 'fleet-user-service' },
    );
    const res = await api(stack, expired).get('/api/users/verify');
    expect(res.status).to.equal(401);
    expect(res.body.error.code).to.equal('TOKEN_EXPIRED');
  });

  it('registers a new viewer and lets them log in', async () => {
    const reg = await api(stack)
      .post('/api/users/register')
      .send({ name: 'New Person', email: 'new@fleet.local', password: 'Password1!' });
    expect(reg.status).to.equal(201);
    expect(reg.body.user.role).to.equal('viewer');

    const res = await api(stack).post('/api/users/login').send({ email: 'new@fleet.local', password: 'Password1!' });
    expect(res.status).to.equal(200);
  });

  it('does not let anonymous users self-register as admin (403)', async () => {
    const res = await api(stack)
      .post('/api/users/register')
      .send({ name: 'Sneaky', email: 'sneaky@fleet.local', password: 'Password1!', role: 'admin' });
    expect(res.status).to.equal(403);
  });
});
