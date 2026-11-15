import { expect } from 'chai';
import sinon from 'sinon';
import { geocoder } from '../src/services/geo/geocoder';
import { api, login, startStack, type Stack } from './helpers';

describe('Flow 2 — Vehicle registration and retrieval', () => {
  let stack: Stack;
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;

  before(async () => {
    stack = await startStack();
    adminToken = await login(stack, 'admin');
    operatorToken = await login(stack, 'operator');
    viewerToken = await login(stack, 'viewer');
  });
  afterEach(() => sinon.restore());
  after(async () => stack.close());

  it('registers a vehicle with explicit GPS coordinates', async () => {
    const res = await api(stack, adminToken).post('/api/vehicles').send({
      plateNumber: 'ka01zz0001',
      make: 'Tata',
      model: 'Ultra',
      year: 2023,
      vehicleType: 'truck',
      latitude: 12.95,
      longitude: 77.6,
    });

    expect(res.status).to.equal(201);
    expect(res.headers['x-served-by']).to.equal('vehicle-service');
    expect(res.body.vehicle).to.include({ plateNumber: 'KA01ZZ0001', status: 'active', make: 'Tata' });
    expect(res.body.vehicle.location).to.include({ latitude: 12.95, longitude: 77.6, source: 'manual' });
  });

  it('geocodes the address when no coordinates are given (mocked Google Maps / OSM)', async () => {
    const stub = sinon.stub(geocoder, 'geocode').resolves({
      latitude: 12.9719,
      longitude: 77.6412,
      formattedAddress: '100 Feet Road, Indiranagar, Bengaluru, India',
      provider: 'google',
    });

    const res = await api(stack, operatorToken)
      .post('/api/vehicles')
      .send({ plateNumber: 'KA01ZZ0002', make: 'Mahindra', address: '100 Feet Road, Indiranagar, Bengaluru' });

    expect(res.status).to.equal(201);
    expect(stub.calledOnceWith('100 Feet Road, Indiranagar, Bengaluru')).to.equal(true);
    expect(res.body.geocoding).to.include({ status: 'ok', provider: 'google' });
    expect(res.body.vehicle.location).to.include({ latitude: 12.9719, longitude: 77.6412, source: 'geocoded:google' });
  });

  it('still registers the vehicle if geocoding fails, flagging the failure', async () => {
    sinon.stub(geocoder, 'geocode').rejects(new Error('provider down'));
    const res = await api(stack, adminToken)
      .post('/api/vehicles')
      .send({ plateNumber: 'KA01ZZ0003', address: 'Nowhere Street 999' });

    expect(res.status).to.equal(201);
    expect(res.body.vehicle.location).to.equal(null);
    expect(res.body.geocoding.status).to.equal('failed');
  });

  it('retrieves a vehicle by id', async () => {
    const created = await api(stack, adminToken)
      .post('/api/vehicles')
      .send({ plateNumber: 'KA01ZZ0004', latitude: 12.9, longitude: 77.5 });
    const res = await api(stack, viewerToken).get(`/api/vehicles/${created.body.vehicle.id}`);

    expect(res.status).to.equal(200);
    expect(res.body.vehicle.id).to.equal(created.body.vehicle.id);
    expect(res.body.vehicle.plateNumber).to.equal('KA01ZZ0004');
  });

  it('lists vehicles and filters by status', async () => {
    const all = await api(stack, viewerToken).get('/api/vehicles');
    expect(all.status).to.equal(200);
    expect(all.body.count).to.be.greaterThan(8);

    const idle = await api(stack, viewerToken).get('/api/vehicles?status=idle');
    expect(idle.status).to.equal(200);
    expect(idle.body.vehicles).to.not.be.empty;
    idle.body.vehicles.forEach((v: any) => expect(v.status).to.equal('idle'));
  });

  it('rejects a duplicate plate number with 409', async () => {
    const res = await api(stack, adminToken).post('/api/vehicles').send({ plateNumber: 'KA01ZZ0001' });
    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal('CONFLICT');
  });

  it('validates the payload (400) and ids (400)', async () => {
    const bad = await api(stack, adminToken).post('/api/vehicles').send({ plateNumber: 'X', latitude: 200 });
    expect(bad.status).to.equal(400);
    expect(bad.body.error.code).to.equal('VALIDATION_ERROR');
    expect(bad.body.error.details).to.be.an('array').that.is.not.empty;

    const badId = await api(stack, adminToken).get('/api/vehicles/not-a-uuid');
    expect(badId.status).to.equal(400);
  });

  it('returns 404 for an unknown vehicle', async () => {
    const res = await api(stack, adminToken).get('/api/vehicles/2b7a6f0e-8a0a-4b8e-9a43-2f9d7d0f1a11');
    expect(res.status).to.equal(404);
  });
});
