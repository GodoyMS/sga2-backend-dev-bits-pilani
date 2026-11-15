import { expect } from 'chai';
import { api, login, startStack, type Stack } from './helpers';

describe('Flow 5 — Role-based access control', () => {
  let stack: Stack;
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;
  let vehicleId: string;

  before(async () => {
    stack = await startStack();
    adminToken = await login(stack, 'admin');
    operatorToken = await login(stack, 'operator');
    viewerToken = await login(stack, 'viewer');
    const v = await api(stack, adminToken).post('/api/vehicles').send({ plateNumber: 'RBAC001', latitude: 1, longitude: 1 });
    vehicleId = v.body.vehicle.id;
  });
  after(async () => stack.close());

  it('blocks a viewer from deleting a vehicle (403 FORBIDDEN)', async () => {
    const res = await api(stack, viewerToken).delete(`/api/vehicles/${vehicleId}`);
    expect(res.status).to.equal(403);
    expect(res.body.error.code).to.equal('FORBIDDEN');
    expect(res.body.error.message).to.include('admin');
  });

  it('blocks an operator from deleting a vehicle (403)', async () => {
    const res = await api(stack, operatorToken).delete(`/api/vehicles/${vehicleId}`);
    expect(res.status).to.equal(403);
  });

  it('blocks unauthenticated deletes (401)', async () => {
    const res = await api(stack).delete(`/api/vehicles/${vehicleId}`);
    expect(res.status).to.equal(401);
  });

  it('confirms the vehicle still exists after the rejected attempts', async () => {
    const res = await api(stack, viewerToken).get(`/api/vehicles/${vehicleId}`);
    expect(res.status).to.equal(200);
  });

  it('blocks a viewer from registering vehicles or changing status (403)', async () => {
    const create = await api(stack, viewerToken).post('/api/vehicles').send({ plateNumber: 'RBAC002' });
    expect(create.status).to.equal(403);
    const status = await api(stack, viewerToken).patch(`/api/vehicles/${vehicleId}/status`).send({ status: 'idle' });
    expect(status.status).to.equal(403);
  });

  it('restricts the user list and notification log by role', async () => {
    expect((await api(stack, viewerToken).get('/api/users')).status).to.equal(403);
    expect((await api(stack, operatorToken).get('/api/users')).status).to.equal(403);
    expect((await api(stack, adminToken).get('/api/users')).status).to.equal(200);
    expect((await api(stack, viewerToken).get('/api/notifications')).status).to.equal(403);
    expect((await api(stack, operatorToken).get('/api/notifications')).status).to.equal(200);
  });

  it('ignores an x-service-token sent by a client through the gateway', async () => {
    const res = await api(stack).delete(`/api/vehicles/${vehicleId}`).set('x-service-token', 'test-service-token');
    expect(res.status).to.equal(401);
  });

  it('allows an admin to delete the vehicle (204), after which it is gone (404)', async () => {
    const del = await api(stack, adminToken).delete(`/api/vehicles/${vehicleId}`);
    expect(del.status).to.equal(204);
    const get = await api(stack, adminToken).get(`/api/vehicles/${vehicleId}`);
    expect(get.status).to.equal(404);
  });
});
