import { expect } from 'chai';
import sinon from 'sinon';
import { boundingBox, haversineKm } from '../src/services/geo/distance';
import { geocoder } from '../src/services/geo/geocoder';
import { ApiError } from '../src/shared/errors';
import { api, login, startStack, type Stack } from './helpers';

// Seed data: MG Road (12.9716, 77.5946), Indiranagar (12.9784, 77.6408), Koramangala (12.9352, 77.6245),
// Whitefield, Hebbal, HSR, Electronic City, Mysuru (~140 km away).
const MG_ROAD = { lat: 12.9716, lng: 77.5946 };

describe('Flow 6 — Nearby vehicle search with mocked geolocation', () => {
  let stack: Stack;
  let token: string;

  before(async () => {
    stack = await startStack();
    token = await login(stack, 'viewer');
  });
  afterEach(() => sinon.restore());
  after(async () => stack.close());

  it('computes great-circle distances correctly', () => {
    // MG Road → Indiranagar is roughly 5 km.
    const d = haversineKm(12.9716, 77.5946, 12.9784, 77.6408);
    expect(d).to.be.closeTo(5.06, 0.1);
    const box = boundingBox(12.9716, 77.5946, 10);
    expect(box.minLat).to.be.lessThan(12.9716);
    expect(box.maxLon).to.be.greaterThan(77.5946);
  });

  it('finds vehicles within the radius of a coordinate, nearest first', async () => {
    const res = await api(stack, token).get(`/api/maps/nearby?lat=${MG_ROAD.lat}&lng=${MG_ROAD.lng}&radiusKm=6`);

    expect(res.status).to.equal(200);
    expect(res.headers['x-served-by']).to.equal('geo-service');
    const plates = res.body.vehicles.map((v: any) => v.plateNumber);
    expect(plates).to.include.members(['KA01AB1234', 'KA01CD5678', 'KA02EF9012']);
    expect(plates).to.not.include('KA09QR8642'); // Mysuru
    expect(plates[0]).to.equal('KA01AB1234'); // distance 0
    const distances = res.body.vehicles.map((v: any) => v.distanceKm);
    expect(distances).to.deep.equal([...distances].sort((a: number, b: number) => a - b));
    distances.forEach((d: number) => expect(d).to.be.at.most(6));
  });

  it('geocodes an address with the (stubbed) provider and searches around it', async () => {
    const stub = sinon.stub(geocoder, 'geocode').resolves({
      latitude: 12.9784,
      longitude: 77.6408,
      formattedAddress: 'Indiranagar, Bengaluru, Karnataka, India',
      provider: 'google',
    });

    const res = await api(stack, token).get('/api/maps/nearby').query({ address: 'Indiranagar, Bengaluru', radiusKm: 2 });

    expect(res.status).to.equal(200);
    expect(stub.calledOnceWith('Indiranagar, Bengaluru')).to.equal(true);
    expect(res.body.center).to.include({ latitude: 12.9784, longitude: 77.6408, source: 'google' });
    expect(res.body.vehicles.map((v: any) => v.plateNumber)).to.deep.equal(['KA01CD5678']);
  });

  it('filters nearby results by status', async () => {
    const res = await api(stack, token).get(`/api/maps/nearby?lat=${MG_ROAD.lat}&lng=${MG_ROAD.lng}&radiusKm=50&status=maintenance`);
    expect(res.status).to.equal(200);
    expect(res.body.vehicles.map((v: any) => v.plateNumber)).to.deep.equal(['KA04JK7890']);
  });

  it('exposes the geocode endpoint (stubbed provider)', async () => {
    sinon.stub(geocoder, 'geocode').resolves({ latitude: 28.6139, longitude: 77.209, formattedAddress: 'New Delhi, India', provider: 'nominatim' });
    const res = await api(stack, token).get('/api/maps/geocode?address=New%20Delhi');
    expect(res.status).to.equal(200);
    expect(res.body).to.include({ latitude: 28.6139, longitude: 77.209, provider: 'nominatim' });
  });

  it('returns 404 when the address cannot be geocoded', async () => {
    sinon.stub(geocoder, 'geocode').rejects(new ApiError(404, 'ADDRESS_NOT_FOUND', 'No coordinates found'));
    const res = await api(stack, token).get('/api/maps/nearby?address=zzzz-unknown-place');
    expect(res.status).to.equal(404);
    expect(res.body.error.code).to.equal('ADDRESS_NOT_FOUND');
  });

  it('returns 502 when the geolocation provider is down', async () => {
    sinon.stub(geocoder, 'geocode').rejects(new ApiError(502, 'GEOCODER_UNAVAILABLE', 'Geocoding provider could not be reached'));
    const res = await api(stack, token).get('/api/maps/geocode?address=Somewhere');
    expect(res.status).to.equal(502);
  });

  it('validates the search parameters (400)', async () => {
    const noCenter = await api(stack, token).get('/api/maps/nearby?radiusKm=5');
    expect(noCenter.status).to.equal(400);
    const badRadius = await api(stack, token).get(`/api/maps/nearby?lat=1&lng=1&radiusKm=-3`);
    expect(badRadius.status).to.equal(400);
  });

  it('returns all vehicle positions as GeoJSON for the map', async () => {
    const res = await api(stack, token).get('/api/maps/vehicles');
    expect(res.status).to.equal(200);
    expect(res.body.type).to.equal('FeatureCollection');
    expect(res.body.features[0].geometry.type).to.equal('Point');
  });

  it('stores a GPS fix sent by a vehicle', async () => {
    const operator = await login(stack, 'operator');
    const list = await api(stack, operator).get('/api/vehicles?limit=1');
    const id = list.body.vehicles[0].id;
    const res = await api(stack, operator).put(`/api/maps/vehicles/${id}/location`).send({ latitude: 13.0, longitude: 77.7 });
    expect(res.status).to.equal(200);
    expect(res.body.vehicle.location).to.include({ latitude: 13.0, longitude: 77.7, source: 'gps' });
  });
});
