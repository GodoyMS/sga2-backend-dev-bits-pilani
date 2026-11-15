import twilio from 'twilio';
import { config } from '../../config';

export interface SmsResult {
  providerMessageId: string;
  providerStatus: string;
}

export interface SmsProvider {
  readonly name: string;
  send(to: string, body: string): Promise<SmsResult>;
}

const E164 = /^\+[1-9]\d{7,14}$/;

/** Real SMS through Twilio (works with trial accounts for verified numbers). */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  private client = twilio(config.sms.twilioAccountSid, config.sms.twilioAuthToken);

  async send(to: string, body: string): Promise<SmsResult> {
    const msg = await this.client.messages.create({
      to,
      body,
      ...(config.sms.twilioMessagingServiceSid
        ? { messagingServiceSid: config.sms.twilioMessagingServiceSid }
        : { from: config.sms.twilioFromNumber }),
    });
    return { providerMessageId: msg.sid, providerStatus: msg.status };
  }
}

/**
 * Local SMS stub used in development and tests. Keeps an in-memory outbox and
 * fails for invalid numbers or the configured "fail" number, so both the
 * `sent` and `failed` paths can be exercised without a real provider.
 */
export class StubSmsProvider implements SmsProvider {
  readonly name = 'stub';
  readonly outbox: { to: string; body: string; id: string; at: Date }[] = [];

  async send(to: string, body: string): Promise<SmsResult> {
    if (!E164.test(to)) throw new Error(`Invalid destination number: ${to}`);
    if (to === config.sms.stubFailNumber) throw new Error('Simulated carrier failure (stub)');
    const id = `SMSTUB${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    this.outbox.push({ to, body, id, at: new Date() });
    return { providerMessageId: id, providerStatus: 'delivered' };
  }
}

let provider: SmsProvider | null = null;

export function getSmsProvider(): SmsProvider {
  if (!provider) provider = config.sms.provider === 'twilio' ? new TwilioSmsProvider() : new StubSmsProvider();
  return provider;
}

/** Lets tests inject a provider. */
export function setSmsProvider(p: SmsProvider): void {
  provider = p;
}
