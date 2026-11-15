import { Router } from 'express';
import { z } from 'zod';
import { authenticateUserOrService, authorize } from '../../shared/auth';
import { createServiceApp } from '../../shared/create-service-app';
import { query, queryOne } from '../../shared/db';
import { ah, ApiError } from '../../shared/errors';
import { toVehicle, VEHICLE_STATUSES, type VehicleRow } from '../../shared/vehicle-model';
import { boundingBox, haversineKm } from './distance';
import { geocoder } from './geocoder';

const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);

const geocodeQuery = z.object({ address: z.string().trim().min(3).max(300) });

const nearbyQuery = z
  .object({
    lat: lat.optional(),
    lng: lng.optional(),
    address: z.string().trim().min(3).max(300).optional(),
    radiusKm: z.coerce.number().positive().max(1000).default(5),
    status: z.enum(VEHICLE_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
  })
  .refine((q) => (q.lat !== undefined && q.lng !== undefined) || q.address, {
    message: 'Provide either lat & lng, or address',
  });

const locationBody = z.object({
  latitude: lat,
  longitude: lng,
  source: z.string().max(30).default('gps'),
});

const router = Router();
router.use('/api/maps', authenticateUserOrService);

/** Address → coordinates using Google Maps or OpenStreetMap. */
router.get(
  '/api/maps/geocode',
  ah(async (req, res) => {
    const { address } = geocodeQuery.parse(req.query);
    const result = await geocoder.geocode(address);
    res.json({ query: address, ...result });
  }),
);

/** Vehicles within `radiusKm` of a point (or of a geocoded address), nearest first. */
router.get(
  '/api/maps/nearby',
  ah(async (req, res) => {
    const q = nearbyQuery.parse(req.query);
    let center: { latitude: number; longitude: number; source: string; formattedAddress?: string };
    if (q.lat !== undefined && q.lng !== undefined) {
      center = { latitude: q.lat, longitude: q.lng, source: 'coordinates' };
    } else {
      const g = await geocoder.geocode(q.address!);
      center = { latitude: g.latitude, longitude: g.longitude, source: g.provider, formattedAddress: g.formattedAddress };
    }

    const box = boundingBox(center.latitude, center.longitude, q.radiusKm);
    const params: unknown[] = [box.minLat, box.maxLat, box.minLon, box.maxLon];
    let sql = `SELECT * FROM vehicles
               WHERE latitude IS NOT NULL AND longitude IS NOT NULL
                 AND latitude BETWEEN $1 AND $2 AND longitude BETWEEN $3 AND $4`;
    if (q.status) {
      params.push(q.status);
      sql += ` AND status = $${params.length}`;
    }
    const candidates = await query<VehicleRow>(sql, params);

    const vehicles = candidates
      .map((v) => ({
        ...toVehicle(v),
        distanceKm: Number(haversineKm(center.latitude, center.longitude, Number(v.latitude), Number(v.longitude)).toFixed(3)),
      }))
      .filter((v) => v.distanceKm <= q.radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, q.limit);

    res.json({ center, radiusKm: q.radiusKm, count: vehicles.length, vehicles });
  }),
);

/** Current position of every vehicle that has reported one (for the map view). */
router.get(
  '/api/maps/vehicles',
  ah(async (_req, res) => {
    const rows = await query<VehicleRow>(
      `SELECT * FROM vehicles WHERE latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY plate_number`,
    );
    res.json({
      type: 'FeatureCollection',
      count: rows.length,
      features: rows.map((v) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number(v.longitude), Number(v.latitude)] },
        properties: toVehicle(v),
      })),
    });
  }),
);

/** Store a GPS fix reported by a vehicle. */
router.put(
  '/api/maps/vehicles/:id/location',
  authorize('admin', 'operator'),
  ah(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw ApiError.badRequest('id must be a UUID');
    const body = locationBody.parse(req.body);
    const row = await queryOne<VehicleRow>(
      `UPDATE vehicles SET latitude = $2, longitude = $3, location_source = $4, location_updated_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.latitude, body.longitude, body.source],
    );
    if (!row) throw ApiError.notFound('Vehicle not found');
    res.json({ vehicle: toVehicle(row) });
  }),
);

export function createGeoService() {
  return createServiceApp('geo', router);
}
