import { randomUUID } from 'crypto';
import { config } from './config';
import { query, queryOne } from './shared/db';
import { createUser } from './services/user/app';

/** Demo fleet around Bengaluru so the map and nearby search have data to show. */
const DEMO_VEHICLES = [
  { plate: 'KA01AB1234', make: 'Tata', model: 'Ace Gold', type: 'truck', status: 'active', lat: 12.9716, lng: 77.5946, address: 'MG Road, Bengaluru' },
  { plate: 'KA01CD5678', make: 'Ashok Leyland', model: 'Dost+', type: 'truck', status: 'active', lat: 12.9784, lng: 77.6408, address: 'Indiranagar, Bengaluru' },
  { plate: 'KA02EF9012', make: 'Mahindra', model: 'Supro', type: 'van', status: 'idle', lat: 12.9352, lng: 77.6245, address: 'Koramangala, Bengaluru' },
  { plate: 'KA03GH3456', make: 'Maruti Suzuki', model: 'Eeco', type: 'van', status: 'active', lat: 12.9698, lng: 77.75, address: 'Whitefield, Bengaluru' },
  { plate: 'KA04JK7890', make: 'Tata', model: 'Nexon EV', type: 'car', status: 'maintenance', lat: 13.0358, lng: 77.597, address: 'Hebbal, Bengaluru' },
  { plate: 'KA05LM2468', make: 'Eicher', model: 'Pro 2049', type: 'truck', status: 'active', lat: 12.9121, lng: 77.6446, address: 'HSR Layout, Bengaluru' },
  { plate: 'KA51NP1357', make: 'Volvo', model: '9400', type: 'bus', status: 'active', lat: 12.8399, lng: 77.677, address: 'Electronic City, Bengaluru' },
  { plate: 'KA09QR8642', make: 'BharatBenz', model: '1617R', type: 'truck', status: 'offline', lat: 12.2958, lng: 76.6394, address: 'Mysuru' },
] as const;

export async function seedDemoData(): Promise<{ created: boolean }> {
  const existing = await queryOne(`SELECT id FROM users LIMIT 1`);
  if (existing) return { created: false };

  await createUser({
    name: 'Fleet Admin',
    email: 'admin@fleet.local',
    password: config.seed.adminPassword,
    role: 'admin',
    phone: config.seed.adminPhone || null,
  });
  const operator = await createUser({
    name: 'Ravi Operator',
    email: 'operator@fleet.local',
    password: 'Operator@123',
    role: 'operator',
    phone: null,
  });
  await createUser({ name: 'Vera Viewer', email: 'viewer@fleet.local', password: 'Viewer@123', role: 'viewer', phone: null });

  for (const [i, v] of DEMO_VEHICLES.entries()) {
    await query(
      `INSERT INTO vehicles (id, plate_number, make, model, year, vehicle_type, status, address, latitude, longitude, location_source, location_updated_at, assigned_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'seed', NOW(), $11)`,
      [randomUUID(), v.plate, v.make, v.model, 2021 + (i % 4), v.type, v.status, v.address, v.lat, v.lng, i < 3 ? operator.id : null],
    );
  }
  return { created: true };
}
