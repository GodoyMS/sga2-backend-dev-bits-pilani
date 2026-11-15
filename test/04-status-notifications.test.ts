import { expect } from 'chai';
import { api, login, startStack, type Stack } from './helpers';

describe('Flow 4 — Vehicle status update and SMS notification', () => {
  let stack: Stack;
  let adminToken: string;
  let operatorToken: string;
  let vehicleId: string;
  let operatorId: string;

  before(async () => {
    stack = await startStack();
    adminToken = await login(stack, 'admin');
    operatorToken = await login(stack, 'operator');
    const me = await api(stack, operatorToken).get('/api/users/me');
    operatorId = me.body.user.id;
    // Give the operator a phone so they are a "relevant user" for their assigned vehicle.
    await api(stack, adminToken).patch(`/api/users/${operatorId}`).send({ phone: '+15551230002' });
    const v = await api(stack, adminToken)
      .post('/api/vehicles')
      .send({ plateNumber: 'STAT001', latitude: 12.9, longitude: 77.5, assignedUserId: operatorId });
    vehicleId = v.body.vehicle.id;
  });
  after(async () => stack.close());

  it('changes the status, records history and notifies admin + assigned operator', async () => {
    const before = stack.sms.outbox.length;
    const res = await api(stack, operatorToken)
      .patch(`/api/vehicles/${vehicleId}/status`)
      .send({ status: 'maintenance', reason: 'Brake inspection' });

    expect(res.status).to.equal(200);
    expect(res.body.changed).to.equal(true);
    expect(res.body.previousStatus).to.equal('active');
    expect(res.body.vehicle.status).to.equal('maintenance');
    expect(res.body.notification.summary).to.deep.equal({ total: 2, sent: 2, failed: 0 });

    const sent = stack.sms.outbox.slice(before);
    expect(sent.map((m) => m.to)).to.have.members(['+15551230001', '+15551230002']);
    expect(sent[0].body).to.match(/STAT001 status changed active -> maintenance \(Brake inspection\)/);

    const history = await api(stack, operatorToken).get(`/api/vehicles/${vehicleId}/status-history`);
    expect(history.body.history[0]).to.include({ fromStatus: 'active', toStatus: 'maintenance', reason: 'Brake inspection' });
  });

  it('records each SMS in the notification log with status "sent"', async () => {
    const res = await api(stack, adminToken).get(`/api/notifications?vehicleId=${vehicleId}`);
    expect(res.status).to.equal(200);
    expect(res.headers['x-served-by']).to.equal('notification-service');
    expect(res.body.count).to.equal(2);
    res.body.notifications.forEach((n: any) => {
      expect(n).to.include({ eventType: 'STATUS_CHANGED', status: 'sent', channel: 'sms', provider: 'stub' });
      expect(n.providerMessageId).to.be.a('string');
    });
  });

  it('does not notify when the status is unchanged', async () => {
    const before = stack.sms.outbox.length;
    const res = await api(stack, operatorToken).patch(`/api/vehicles/${vehicleId}/status`).send({ status: 'maintenance' });
    expect(res.status).to.equal(200);
    expect(res.body.changed).to.equal(false);
    expect(stack.sms.outbox.length).to.equal(before);
  });

  it('records a "failed" notification when the SMS provider rejects a number', async () => {
    await api(stack, adminToken).patch(`/api/users/${operatorId}`).send({ phone: '+15005550001' }); // stub fail number
    const res = await api(stack, operatorToken).patch(`/api/vehicles/${vehicleId}/status`).send({ status: 'active' });

    expect(res.status).to.equal(200);
    expect(res.body.notification.summary).to.deep.equal({ total: 2, sent: 1, failed: 1 });

    const failed = await api(stack, adminToken).get(`/api/notifications?status=failed&vehicleId=${vehicleId}`);
    expect(failed.body.count).to.equal(1);
    expect(failed.body.notifications[0]).to.include({ status: 'failed', recipient: '+15005550001' });
    expect(failed.body.notifications[0].error).to.match(/Simulated carrier failure/);
    expect(failed.body.stats.failed).to.be.at.least(1);
  });

  it('rejects an invalid status value with 400', async () => {
    const res = await api(stack, operatorToken).patch(`/api/vehicles/${vehicleId}/status`).send({ status: 'flying' });
    expect(res.status).to.equal(400);
  });

  it('lets an admin send a test SMS', async () => {
    const res = await api(stack, adminToken)
      .post('/api/notifications/test-sms')
      .send({ to: '+15551239999', message: 'Hello fleet' });
    expect(res.status).to.equal(201);
    expect(res.body.notification).to.include({ status: 'sent', eventType: 'TEST' });
  });
});
