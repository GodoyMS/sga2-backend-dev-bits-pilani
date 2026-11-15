import { getPool } from './db';

/**
 * Schema for all services. Each service owns its tables (users → user service,
 * vehicles/vehicle_status_history → vehicle service, telemetry → telemetry service,
 * notifications → notification service); they share one Postgres instance for simplicity.
 */
const statements = [
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    phone TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS vehicles (
    id UUID PRIMARY KEY,
    plate_number TEXT NOT NULL UNIQUE,
    make TEXT,
    model TEXT,
    year INTEGER,
    vehicle_type TEXT NOT NULL DEFAULT 'truck',
    status TEXT NOT NULL DEFAULT 'active',
    address TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    location_source TEXT,
    location_updated_at TIMESTAMPTZ,
    assigned_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS vehicle_status_history (
    id UUID PRIMARY KEY,
    vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    changed_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS telemetry (
    id UUID PRIMARY KEY,
    vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    speed_kph DOUBLE PRECISION,
    heading DOUBLE PRECISION,
    battery_level DOUBLE PRECISION,
    fuel_level DOUBLE PRECISION,
    engine_temp_c DOUBLE PRECISION,
    event_type TEXT,
    is_critical BOOLEAN NOT NULL DEFAULT FALSE,
    critical_events JSONB,
    recorded_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY,
    vehicle_id UUID,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'sms',
    recipient TEXT NOT NULL,
    recipient_user_id UUID,
    message TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_message_id TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_vehicles_lat_lng ON vehicles (latitude, longitude)`,
  `CREATE INDEX IF NOT EXISTS idx_telemetry_vehicle ON telemetry (vehicle_id, recorded_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_vehicle ON notifications (vehicle_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status)`,
];

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  for (const sql of statements) {
    await pool.query(sql);
  }
}
