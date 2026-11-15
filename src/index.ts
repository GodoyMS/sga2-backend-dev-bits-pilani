import type { Server } from 'http';
import type { Express } from 'express';
import { config, serviceUrls, type ServiceName } from './config';
import { createGateway } from './gateway/app';
import { runMigrations } from './shared/migrations';
import { seedDemoData } from './seed';
import { createGeoService } from './services/geo/app';
import { createNotificationService } from './services/notification/app';
import { createTelemetryService } from './services/telemetry/app';
import { createUserService } from './services/user/app';
import { createVehicleService } from './services/vehicle/app';
import { getSmsProvider } from './services/notification/sms';

export const SERVICE_FACTORIES: Record<ServiceName, () => Express> = {
  user: createUserService,
  vehicle: createVehicleService,
  telemetry: createTelemetryService,
  geo: createGeoService,
  notification: createNotificationService,
};

function listen(app: Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on('error', reject);
  });
}

/**
 * Starts the backend services on internal ports (loopback only) and the API Gateway
 * on the public PORT. Set SERVICE=<name> to run one service by itself instead.
 */
export async function main(): Promise<void> {
  await runMigrations();
  if (config.seed.enabled) {
    const { created } = await seedDemoData();
    if (created) console.log('[seed] demo users and vehicles created');
  }

  const only = config.service;
  if (only !== 'all' && only !== 'gateway') {
    const name = only as ServiceName;
    if (!SERVICE_FACTORIES[name]) throw new Error(`Unknown SERVICE "${only}"`);
    await listen(SERVICE_FACTORIES[name](), config.port, '0.0.0.0');
    console.log(`[${name}] listening on :${config.port}`);
    return;
  }

  if (only === 'all') {
    for (const [name, factory] of Object.entries(SERVICE_FACTORIES) as [ServiceName, () => Express][]) {
      const port = config.servicePorts[name];
      await listen(factory(), port, '127.0.0.1');
      serviceUrls[name] = `http://127.0.0.1:${port}`;
      console.log(`[${name}] service listening on 127.0.0.1:${port}`);
    }
  }

  await listen(createGateway({ targets: serviceUrls }), config.port, '0.0.0.0');
  console.log(`[gateway] listening on :${config.port}`);
  console.log(`[config] geocoder=${config.geocoding.provider} sms=${getSmsProvider().name}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal startup error', err);
    process.exit(1);
  });
}
