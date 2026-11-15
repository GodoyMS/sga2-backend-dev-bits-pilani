import { randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { authenticateUserOrService, authorize } from '../../shared/auth';
import { createServiceApp } from '../../shared/create-service-app';
import { query, queryOne } from '../../shared/db';
import { ah, ApiError } from '../../shared/errors';
import { callService } from '../../shared/service-client';
import type { VehicleRow } from '../../shared/vehicle-model';

export const CRITICAL_EVENTS = ['ENGINE_FAULT', 'LOW_BATTERY', 'EMERGENCY_STOP', 'ENGINE_OVERHEAT'] as const;
const EVENT_TYPES = [...CRITICAL_EVENTS, 'HEARTBEAT', 'IGNITION_ON', 'IGNITION_OFF', 'HARSH_BRAKING'] as const;

const telemetrySchema = z.object({
  vehicleId: z.string().uuid(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  speedKph: z.number().min(0).max(400).optional(),
  heading: z.number().min(0).max(360).optional(),
  batteryLevel: z.number().min(0).max(100).optional(),
  fuelLevel: z.number().min(0).max(100).optional(),
  engineTempC: z.number().min(-50).max(250).optional(),
  eventType: z.enum(EVENT_TYPES).default('HEARTBEAT'),
  recordedAt: z.string().datetime({ offset: true }).optional(),
});

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  criticalOnly: z.enum(['true', 'false']).optional(),
});

interface TelemetryRow {
  id: string;
  vehicle_id: string;
  latitude: number;
  longitude: number;
  speed_kph: number | null;
  heading: number | null;
  battery_level: number | null;
  fuel_level: number | null;
  engine_temp_c: number | null;
  event_type: string | null;
  is_critical: boolean;
  critical_events: string[] | null;
  recorded_at: Date;
  received_at: Date;
}

const toTelemetry = (t: TelemetryRow) => ({
  id: t.id,
  vehicleId: t.vehicle_id,
  latitude: Number(t.latitude),
  longitude: Number(t.longitude),
  speedKph: t.speed_kph,
  heading: t.heading,
  batteryLevel: t.battery_level,
  fuelLevel: t.fuel_level,
  engineTempC: t.engine_temp_c,
  eventType: t.event_type,
  isCritical: t.is_critical,
  criticalEvents: t.critical_events ?? [],
  recordedAt: t.recorded_at,
  receivedAt: t.received_at,
});

/** Critical events = the reported event (if critical) plus threshold-based detections. */
export function detectCriticalEvents(t: z.infer<typeof telemetrySchema>): string[] {
  const events = new Set<string>();
  if ((CRITICAL_EVENTS as readonly string[]).includes(t.eventType)) events.add(t.eventType);
  if (t.batteryLevel !== undefined && t.batteryLevel < config.telemetry.lowBatteryThreshold) events.add('LOW_BATTERY');
  if (t.engineTempC !== undefined && t.engineTempC >= config.telemetry.engineOverheatC) events.add('ENGINE_OVERHEAT');
  return [...events];
}

function describe(event: string, plate: string, t: z.infer<typeof telemetrySchema>): string {
  const where = `at ${t.latitude.toFixed(5)},${t.longitude.toFixed(5)}`;
  switch (event) {
    case 'LOW_BATTERY':
      return `Vehicle ${plate} LOW BATTERY${t.batteryLevel !== undefined ? ` (${t.batteryLevel}%)` : ''} ${where}.`;
    case 'ENGINE_OVERHEAT':
      return `Vehicle ${plate} ENGINE OVERHEAT (${t.engineTempC}C) ${where}.`;
    case 'EMERGENCY_STOP':
      return `Vehicle ${plate} EMERGENCY STOP ${where}. Immediate attention required.`;
    default:
      return `Vehicle ${plate} ${event.replace(/_/g, ' ')} ${where}.`;
  }
}

const router = Router();
router.use('/api/telemetry', authenticateUserOrService);

/** Ingest a telemetry reading: store it, update the vehicle's last known GPS position, alert on critical events. */
router.post(
  '/api/telemetry',
  authorize('admin', 'operator'),
  ah(async (req, res) => {
    const t = telemetrySchema.parse(req.body);
    const vehicle = await queryOne<VehicleRow>(`SELECT * FROM vehicles WHERE id = $1`, [t.vehicleId]);
    if (!vehicle) throw ApiError.notFound('Vehicle not found');

    const criticalEvents = detectCriticalEvents(t);
    const recordedAt = t.recordedAt ? new Date(t.recordedAt).toISOString() : new Date().toISOString();

    const [row] = await query<TelemetryRow>(
      `INSERT INTO telemetry (id, vehicle_id, latitude, longitude, speed_kph, heading, battery_level, fuel_level, engine_temp_c, event_type, is_critical, critical_events, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        randomUUID(),
        t.vehicleId,
        t.latitude,
        t.longitude,
        t.speedKph ?? null,
        t.heading ?? null,
        t.batteryLevel ?? null,
        t.fuelLevel ?? null,
        t.engineTempC ?? null,
        t.eventType,
        criticalEvents.length > 0,
        JSON.stringify(criticalEvents),
        recordedAt,
      ],
    );

    // Latest GPS fix becomes the vehicle's current position (ignore out-of-order readings).
    await query(
      `UPDATE vehicles SET latitude = $2, longitude = $3, location_source = 'telemetry', location_updated_at = $4, updated_at = NOW()
       WHERE id = $1 AND (location_updated_at IS NULL OR location_updated_at <= $4)`,
      [t.vehicleId, t.latitude, t.longitude, recordedAt],
    );

    const notifications: unknown[] = [];
    for (const event of criticalEvents) {
      try {
        notifications.push(
          await callService('notification', '/api/notifications/events', {
            method: 'POST',
            requestId: req.header('x-request-id'),
            body: {
              vehicleId: t.vehicleId,
              eventType: event,
              severity: 'critical',
              message: describe(event, vehicle.plate_number, t),
              notifyUserIds: vehicle.assigned_user_id ? [vehicle.assigned_user_id] : [],
            },
          }),
        );
      } catch (err) {
        notifications.push({ eventType: event, error: (err as Error).message });
      }
    }

    res.status(201).json({ telemetry: toTelemetry(row), criticalEvents, notifications });
  }),
);

router.get(
  '/api/telemetry/vehicle/:vehicleId',
  ah(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.vehicleId).success) throw ApiError.badRequest('vehicleId must be a UUID');
    const q = historyQuery.parse(req.query);
    const vehicle = await queryOne(`SELECT id FROM vehicles WHERE id = $1`, [req.params.vehicleId]);
    if (!vehicle) throw ApiError.notFound('Vehicle not found');
    const rows = await query<TelemetryRow>(
      `SELECT * FROM telemetry WHERE vehicle_id = $1 ${q.criticalOnly === 'true' ? 'AND is_critical = TRUE' : ''}
       ORDER BY recorded_at DESC LIMIT $2`,
      [req.params.vehicleId, q.limit],
    );
    res.json({ vehicleId: req.params.vehicleId, count: rows.length, telemetry: rows.map(toTelemetry) });
  }),
);

router.get(
  '/api/telemetry/:id',
  ah(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw ApiError.badRequest('id must be a UUID');
    const row = await queryOne<TelemetryRow>(`SELECT * FROM telemetry WHERE id = $1`, [req.params.id]);
    if (!row) throw ApiError.notFound('Telemetry record not found');
    res.json({ telemetry: toTelemetry(row) });
  }),
);

export function createTelemetryService() {
  return createServiceApp('telemetry', router);
}
