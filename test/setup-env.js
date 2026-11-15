// Loaded by Mocha before any test file, so config.ts picks up test settings.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.API_KEYS = 'test-api-key,second-test-key';
process.env.SERVICE_TOKEN = 'test-service-token';
process.env.SMS_PROVIDER = 'stub';
process.env.GEOCODER_PROVIDER = 'nominatim';
process.env.SEED_ADMIN_PHONE = '+15551230001';
process.env.ALERT_PHONE_NUMBERS = '';
process.env.STUB_SMS_FAIL_NUMBER = '+15005550001';
