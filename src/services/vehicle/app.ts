import { randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { authenticateUserOrService, authorize } from '../../shared/auth';
import { createServiceApp } from '../../shared/create-service-app';
import { query, queryOne } from '../../shared/db';
import { ah, ApiError } from '../../shared/errors';
import { callService } from '../../shared/service-client';
import { toVehicle, VEHICLE_STATUSES, type VehicleRow } from '../../shared/vehicle-model';

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

const createSchema = z
  .object({
    plateNumber: z.string().trim().min(2).max(20).transform((v) => v.toUpperCase()),
    make: z.string().max(50).optional(),
    model: z.string().max(50).optional(),
    year: z.number().int().min(1950).max(2100).optional(),
    vehicleType: z.enum(['truck', 'van', 'car', 'bus', 'motorcycle']).default('truck'),
    status: z.enum(VEHICLE_STATUSES).default('active'),
    address: z.string().trim().min(3).max(300).optional(),
    latitude: lat.optional(),
    longitude: lng.optional(),
    assignedUserId: z.string().uuid().optional(),
  })
  .refine((v) => (v.latitude === undefined) === (v.longitude === undefined), {
    message: 'latitude and longitude must be provided together',
  });

const updateSchema = z.object({
  make: z.string().max(50).optional(),
  model: z.string().max(50).optional(),
  year: z.number().int().min(1950).max(2100).optional(),
  vehicleType: z.enum(['truck', 'van', 'car', 'bus', 'motorcycle']).optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
});

const statusSchema = z.object({
  status: z.enum(VEHICLE_STATUSES),
  reason: z.string().max(200).optional(),
});

const listQuery = z.object({
  status: z.enum(VEHICLE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const uuid = z.string().uuid();
function requireUuid(id: string) {
  if (!uuid.safeParse(id).success) throw ApiError.badRequest('id must be a UUID');
}

async function findVehicle(id: string): Promise<VehicleRow> {
  requireUuid(id);
  const row = await queryOne<VehicleRow>(`SELECT * FROM vehicles WHERE id = $1`, [id]);
  if (!row) throw ApiError.notFound('Vehicle not found');
  return row;
}

const router = Router();
router.use('/api/vehicles', authenticateUserOrService);

/** Register a vehicle. If only an address is given it is geocoded through the geolocation service. */
router.post(
  '/api/vehicles',
  authorize('admin', 'operator'),
  ah(async (req, res) => {
    const body = createSchema.parse(req.body);
    const dup = await queryOne(`SELECT id FROM vehicles WHERE plate_number = $1`, [body.plateNumber]);
    if (dup) throw ApiError.conflict(`Vehicle with plate ${body.plateNumber} already exists`);

    let latitude = body.latitude ?? null;
    let longitude = body.longitude ?? null;
    let source: string | null = latitude !== null ? 'manual' : null;
    let geocoding: Record<string, unknown> | undefined;

    if (latitude === null && body.address) {
      try {
        const g = await callService<{ latitude: number; longitude: number; provider: string; formattedAddress: string }>(
          'geo',
          `/api/maps/geocode?address=${encodeURIComponent(body.address)}`,
          { requestId: req.header('x-request-id') },
        );
        latitude = g.latitude;
        longitude = g.longitude;
        source = `geocoded:${g.provider}`;
        geocoding = { status: 'ok', provider: g.provider, formattedAddress: g.formattedAddress };
      } catch (err) {
        geocoding = { status: 'failed', error: (err as Error).message };
      }
    }

    const [row] = await query<VehicleRow>(
      `INSERT INTO vehicles (id, plate_number, make, model, year, vehicle_type, status, address, latitude, longitude, location_source, location_updated_at, assigned_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        randomUUID(),
        body.plateNumber,
        body.make ?? null,
        body.model ?? null,
        body.year ?? null,
        body.vehicleType,
        body.status,
        body.address ?? null,
        latitude,
        longitude,
        source,
        latitude !== null ? new Date().toISOString() : null,
        body.assignedUserId ?? null,
      ],
    );
    res.status(201).json({ vehicle: toVehicle(row), ...(geocoding && { geocoding }) });
  }),
);

router.get(
  '/api/vehicles',
  ah(async (req, res) => {
    const q = listQuery.parse(req.query);
    const rows = q.status
      ? await query<VehicleRow>(`SELECT * FROM vehicles WHERE status = $1 ORDER BY created_at DESC LIMIT $2`, [q.status, q.limit])
      : await query<VehicleRow>(`SELECT * FROM vehicles ORDER BY created_at DESC LIMIT $1`, [q.limit]);
    res.json({ count: rows.length, vehicles: rows.map(toVehicle) });
  }),
);

router.get(
  '/api/vehicles/:id',
  ah(async (req, res) => {
    res.json({ vehicle: toVehicle(await findVehicle(req.params.id)) });
  }),
);

router.patch(
  '/api/vehicles/:id',
  authorize('admin', 'operator'),
  ah(async (req, res) => {
    const current = await findVehicle(req.params.id);
    const body = updateSchema.parse(req.body);
    const [row] = await query<VehicleRow>(
      `UPDATE vehicles SET make = $2, model = $3, year = $4, vehicle_type = $5, assigned_user_id = $6, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        current.id,
        body.make ?? current.make,
        body.model ?? current.model,
        body.year ?? current.year,
        body.vehicleType ?? current.vehicle_type,
        body.assignedUserId === undefined ? current.assigned_user_id : body.assignedUserId,
      ],
    );
    res.json({ vehicle: toVehicle(row) });
  }),
);

/** Change operational status and notify admins + the assigned user by SMS. */
router.patch(
  '/api/vehicles/:id/status',
  authorize('admin', 'operator'),
  ah(async (req, res) => {
    const current = await findVehicle(req.params.id);
    const { status, reason } = statusSchema.parse(req.body);
    if (current.status === status) {
      res.json({ vehicle: toVehicle(current), changed: false, notification: null });
      return;
    }

    const [row] = await query<VehicleRow>(
      `UPDATE vehicles SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [current.id, status],
    );
    await query(
      `INSERT INTO vehicle_status_history (id, vehicle_id, from_status, to_status, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), current.id, current.status, status, reason ?? null, req.user!.role === 'service' ? null : req.user!.id],
    );

    const severity = status === 'out_of_service' || status === 'offline' ? 'warning' : 'info';
    let notification: unknown;
    try {
      notification = await callService('notification', '/api/notifications/events', {
        method: 'POST',
        requestId: req.header('x-request-id'),
        body: {
          vehicleId: current.id,
          eventType: 'STATUS_CHANGED',
          severity,
          message: `Vehicle ${current.plate_number} status changed ${current.status} -> ${status}${reason ? ` (${reason})` : ''}.`,
          notifyUserIds: current.assigned_user_id ? [current.assigned_user_id] : [],
        },
      });
    } catch (err) {
      // The status change itself succeeded; report the notification problem without failing the request.
      notification = { error: (err as Error).message };
    }

    res.json({ vehicle: toVehicle(row), changed: true, previousStatus: current.status, notification });
  }),
);

router.get(
  '/api/vehicles/:id/status-history',
  ah(async (req, res) => {
    await findVehicle(req.params.id);
    const rows = await query(
      `SELECT id, from_status AS "fromStatus", to_status AS "toStatus", reason, changed_by AS "changedBy", created_at AS "createdAt"
       FROM vehicle_status_history WHERE vehicle_id = $1 ORDER BY created_at DESC`,
      [req.params.id],
    );
    res.json({ count: rows.length, history: rows });
  }),
);

/** Admin only — operators and viewers get 403. */
router.delete(
  '/api/vehicles/:id',
  authorize('admin'),
  ah(async (req, res) => {
    const v = await findVehicle(req.params.id);
    await query(`DELETE FROM vehicles WHERE id = $1`, [v.id]);
    res.status(204).end();
  }),
);

export function createVehicleService() {
  return createServiceApp('vehicle', router);
}
