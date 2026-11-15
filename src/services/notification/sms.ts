import twilio from 'twilio';
import { config } from '../../config';

export interface SmsResult {
  providerMessageId: string;
  providerStatus: string;
  /** Set when the provider delivered a substitute body (e.g. a Twilio trial template). */
  note?: string;
}

export interface SmsProvider {
  readonly name: string;
  send(to: string, body: string): Promise<SmsResult>;
}

const E164 = /^\+[1-9]\d{7,14}$/;

/** Twilio error returned when a trial account sends a custom body instead of a predefined template. */
const TWILIO_TRIAL_TEMPLATE_ERROR = 572006;

/**
 * Real SMS through Twilio.
 * Trial accounts may only send to verified numbers and only Twilio's predefined templates; when Twilio
 * rejects the custom alert text for that reason, the alert is re-sent with TWILIO_TRIAL_TEMPLATE
 * (default `sms_delivery_updates`). The full alert text is still stored in the notification log.
 * Upgraded accounts send the custom text as-is.
 */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  private client = twilio(config.sms.twilioAccountSid, config.sms.twilioAuthToken);

  private create(to: string, body: string) {
    return this.client.messages.create({
      to,
      body,
      ...(config.sms.twilioMessagingServiceSid
        ? { messagingServiceSid: config.sms.twilioMessagingServiceSid }
        : { from: config.sms.twilioFromNumber }),
    });
  }

  async send(to: string, body: string): Promise<SmsResult> {
    try {
      const msg = await this.create(to, body);
      return { providerMessageId: msg.sid, providerStatus: msg.status };
    } catch (err) {
      if ((err as { code?: number }).code !== TWILIO_TRIAL_TEMPLATE_ERROR) throw err;
      const template = config.sms.twilioTrialTemplate;
      const msg = await this.create(to, template);
      return {
        providerMessageId: msg.sid,
        providerStatus: msg.status,
        note: `Twilio trial account: delivered with predefined template "${template}"`,
      };
    }
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
