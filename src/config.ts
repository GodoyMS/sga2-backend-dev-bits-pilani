import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const list = (value: string | undefined, fallback: string[] = []): string[] =>
  value ? value.split(',').map((v) => v.trim()).filter(Boolean) : fallback;

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const env = process.env.NODE_ENV ?? 'development';

const twilioConfigured = Boolean(
  process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    (process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_MESSAGING_SERVICE_SID),
);

export const config = {
  env,
  isTest: env === 'test',
  port: int(process.env.PORT, 8080),

  /** When set, only that service is started (user | vehicle | telemetry | geo | notification | gateway). */
  service: process.env.SERVICE ?? 'all',

  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/fleet',
  databaseSsl: process.env.DATABASE_SSL === 'true',

  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-only-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  },

  gateway: {
    apiKeys: list(process.env.API_KEYS, ['demo-fleet-key']),
    rateLimitWindowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: int(process.env.RATE_LIMIT_MAX, 100),
    proxyTimeoutMs: int(process.env.PROXY_TIMEOUT_MS, 10_000),
  },

  /** Shared secret used for service-to-service calls behind the gateway. */
  serviceToken: process.env.SERVICE_TOKEN ?? 'dev-internal-service-token',

  servicePorts: {
    user: int(process.env.USER_SERVICE_PORT, 4001),
    vehicle: int(process.env.VEHICLE_SERVICE_PORT, 4002),
    telemetry: int(process.env.TELEMETRY_SERVICE_PORT, 4003),
    geo: int(process.env.GEO_SERVICE_PORT, 4004),
    notification: int(process.env.NOTIFICATION_SERVICE_PORT, 4005),
  },

  geocoding: {
    provider: (process.env.GEOCODER_PROVIDER ??
      (process.env.GOOGLE_MAPS_API_KEY ? 'google' : 'nominatim')) as 'google' | 'nominatim',
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY ?? '',
    nominatimUrl: process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org',
    userAgent: process.env.GEOCODER_USER_AGENT ?? 'FleetManagementSystem/1.0 (academic project)',
    timeoutMs: int(process.env.GEOCODER_TIMEOUT_MS, 8_000),
  },

  sms: {
    provider: (process.env.SMS_PROVIDER ?? (twilioConfigured ? 'twilio' : 'stub')) as 'twilio' | 'stub',
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    twilioFromNumber: process.env.TWILIO_FROM_NUMBER ?? '',
    twilioMessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID ?? '',
    /** Extra on-call numbers (E.164) that receive every critical alert. */
    alertPhoneNumbers: list(process.env.ALERT_PHONE_NUMBERS),
    /** The stub provider fails for this number so the "failed" path can be demonstrated. */
    stubFailNumber: process.env.STUB_SMS_FAIL_NUMBER ?? '+15005550001',
  },

  telemetry: {
    lowBatteryThreshold: int(process.env.LOW_BATTERY_THRESHOLD, 20),
    engineOverheatC: int(process.env.ENGINE_OVERHEAT_C, 115),
  },

  seed: {
    enabled: process.env.SEED_DEMO_DATA !== 'false',
    adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123',
    adminPhone: process.env.SEED_ADMIN_PHONE ?? '',
  },
};

export type ServiceName = keyof typeof config.servicePorts;

/** Base URLs of the backend services. Filled in at startup (or from env when services run separately). */
export const serviceUrls: Record<ServiceName, string> = {
  user: process.env.USER_SERVICE_URL ?? `http://127.0.0.1:${config.servicePorts.user}`,
  vehicle: process.env.VEHICLE_SERVICE_URL ?? `http://127.0.0.1:${config.servicePorts.vehicle}`,
  telemetry: process.env.TELEMETRY_SERVICE_URL ?? `http://127.0.0.1:${config.servicePorts.telemetry}`,
  geo: process.env.GEO_SERVICE_URL ?? `http://127.0.0.1:${config.servicePorts.geo}`,
  notification:
    process.env.NOTIFICATION_SERVICE_URL ?? `http://127.0.0.1:${config.servicePorts.notification}`,
};
