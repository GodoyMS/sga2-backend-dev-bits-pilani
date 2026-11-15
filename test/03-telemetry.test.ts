import { expect } from 'chai';
import { api, login, startStack, type Stack } from './helpers';

describe('Flow 3 — Vehicle telemetry submission and storage', () => {
  let stack: Stack;
  let operatorToken: string;
  let adminToken: string;
  let vehicleId: string;

  before(async () => {
    stack = await startStack();
    operatorToken = await login(stack, 'operator');
    adminToken = await login(stack, 'admin');
    const v = await api(stack, adminToken)
      .post('/api/vehicles')
      .send({ plateNumber: 'TEL0001', latitude: 12.9, longitude: 77.5 });
    vehicleId = v.body.vehicle.id;
  });
  after(async () => stack.close());

  it('stores a normal telemetry reading and updates the vehicle position', async () => {
    const res = await api(stack, operatorToken).post('/api/telemetry').send({
      vehicleId,
      latitude: 12.9611,
      longitude: 77.6387,
      speedKph: 42.5,
      batteryLevel: 88,
      fuelLevel: 63,
      engineTempC: 90,
    });

    expect(res.status).to.equal(201);
    expect(res.headers['x-served-by']).to.equal('telemetry-service');
    expect(res.body.telemetry).to.include({ vehicleId, latitude: 12.9611, longitude: 77.6387, isCritical: false });
    expect(res.body.criticalEvents).to.deep.equal([]);
    expect(res.body.notifications).to.deep.equal([]);

    const stored = await api(stack, operatorToken).get(`/api/telemetry/${res.body.telemetry.id}`);
    expect(stored.status).to.equal(200);
    expect(stored.body.telemetry.speedKph).to.equal(42.5);

    const vehicle = await api(stack, operatorToken).get(`/api/vehicles/${vehicleId}`);
    expect(vehicle.body.vehicle.location).to.include({ latitude: 12.9611, longitude: 77.6387, source: 'telemetry' });
  });

  it('returns telemetry history for a vehicle, newest first', async () => {
    await api(stack, operatorToken)
      .post('/api/telemetry')
      .send({ vehicleId, latitude: 12.97, longitude: 77.64, recordedAt: new Date(Date.now() + 1000).toISOString() });

    const res = await api(stack, operatorToken).get(`/api/telemetry/vehicle/${vehicleId}?limit=10`);
    expect(res.status).to.equal(200);
    expect(res.body.count).to.equal(2);
    const times = res.body.telemetry.map((t: any) => new Date(t.recordedAt).getTime());
    expect(times[0]).to.be.at.least(times[1]);
  });

  it('flags critical events (engine fault + low battery) and sends SMS alerts', async () => {
    const before = stack.sms.outbox.length;
    const res = await api(stack, operatorToken).post('/api/telemetry').send({
      vehicleId,
      latitude: 12.98,
      longitude: 77.65,
      batteryLevel: 7,
      eventType: 'ENGINE_FAULT',
    });

    expect(res.status).to.equal(201);
    expect(res.body.telemetry.isCritical).to.equal(true);
    expect(res.body.criticalEvents).to.have.members(['ENGINE_FAULT', 'LOW_BATTERY']);
    expect(res.body.notifications).to.have.length(2);
    expect(res.body.notifications[0].summary.sent).to.be.at.least(1);

    const newMessages = stack.sms.outbox.slice(before);
    expect(newMessages.some((m) => m.body.includes('ENGINE FAULT') && m.body.includes('TEL0001'))).to.equal(true);
    expect(newMessages.some((m) => m.body.includes('LOW BATTERY'))).to.equal(true);
    expect(newMessages.every((m) => m.to === '+15551230001')).to.equal(true);

    const critical = await api(stack, operatorToken).get(`/api/telemetry/vehicle/${vehicleId}?criticalOnly=true`);
    expect(critical.body.count).to.equal(1);
  });

  it('rejects invalid telemetry with 400', async () => {
    const res = await api(stack, operatorToken).post('/api/telemetry').send({ vehicleId, latitude: 'north', longitude: 500 });
    expect(res.status).to.equal(400);
    expect(res.body.error.code).to.equal('VALIDATION_ERROR');
  });

  it('returns 404 for telemetry from an unknown vehicle', async () => {
    const res = await api(stack, operatorToken)
      .post('/api/telemetry')
      .send({ vehicleId: '2b7a6f0e-8a0a-4b8e-9a43-2f9d7d0f1a11', latitude: 1, longitude: 1 });
    expect(res.status).to.equal(404);
  });

  it('does not let viewers submit telemetry (403)', async () => {
    const viewer = await login(stack, 'viewer');
    const res = await api(stack, viewer).post('/api/telemetry').send({ vehicleId, latitude: 1, longitude: 1 });
    expect(res.status).to.equal(403);
  });
});
