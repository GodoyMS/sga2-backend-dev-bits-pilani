import { randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { authenticate, authenticateUserOrService, authorize } from '../../shared/auth';
import { createServiceApp } from '../../shared/create-service-app';
import { query, queryOne } from '../../shared/db';
import { ah, ApiError } from '../../shared/errors';
import { getSmsProvider } from './sms';

export const NOTIFICATION_EVENT_TYPES = [
  'ENGINE_FAULT',
  'LOW_BATTERY',
  'EMERGENCY_STOP',
  'ENGINE_OVERHEAT',
  'STATUS_CHANGED',
  'TEST',
] as const;

interface NotificationRow {
  id: string;
  vehicle_id: string | null;
  event_type: string;
  severity: string;
  channel: string;
  recipient: string;
  recipient_user_id: string | null;
  message: string;
  provider: string;
  status: 'sent' | 'failed';
  provider_message_id: string | null;
  error: string | null;
  created_at: Date;
  sent_at: Date | null;
}

const toNotification = (n: NotificationRow) => ({
  id: n.id,
  vehicleId: n.vehicle_id,
  eventType: n.event_type,
  severity: n.severity,
  channel: n.channel,
  recipient: n.recipient,
  recipientUserId: n.recipient_user_id,
  message: n.message,
  provider: n.provider,
  status: n.status,
  providerMessageId: n.provider_message_id,
  error: n.error,
  createdAt: n.created_at,
  sentAt: n.sent_at,
});

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format');

const eventSchema = z.object({
  vehicleId: z.string().uuid().optional(),
  eventType: z.enum(NOTIFICATION_EVENT_TYPES),
  severity: z.enum(['info', 'warning', 'critical']).default('critical'),
  message: z.string().min(1).max(320),
  /** Additional users to notify (e.g. the driver assigned to the vehicle). Admins are always notified. */
  notifyUserIds: z.array(z.string().uuid()).max(20).optional(),
});

const testSmsSchema = z.object({
  to: e164,
  message: z.string().min(1).max(320).default('Fleet Management System test message'),
});

const listQuery = z.object({
  status: z.enum(['sent', 'failed']).optional(),
  vehicleId: z.string().uuid().optional(),
  eventType: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

async function sendAndRecord(input: {
  vehicleId?: string | null;
  eventType: string;
  severity: string;
  recipient: string;
  recipientUserId?: string | null;
  message: string;
}): Promise<NotificationRow> {
  const provider = getSmsProvider();
  let status: 'sent' | 'failed' = 'sent';
  let providerMessageId: string | null = null;
  let providerLabel = provider.name;
  let error: string | null = null;
  try {
    const result = await provider.send(input.recipient, input.message);
    providerMessageId = result.providerMessageId;
    if (result.note) providerLabel = `${provider.name} (trial template)`;
  } catch (err) {
    status = 'failed';
    error = (err as Error).message.slice(0, 500);
  }
  const [row] = await query<NotificationRow>(
    `INSERT INTO notifications (id, vehicle_id, event_type, severity, channel, recipient, recipient_user_id, message, provider, status, provider_message_id, error, sent_at)
     VALUES ($1, $2, $3, $4, 'sms', $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      randomUUID(),
      input.vehicleId ?? null,
      input.eventType,
      input.severity,
      input.recipient,
      input.recipientUserId ?? null,
      input.message,
      providerLabel,
      status,
      providerMessageId,
      error,
      status === 'sent' ? new Date().toISOString() : null,
    ],
  );
  return row;
}

/** Fleet admins with a phone number, plus any explicitly requested users and on-call numbers. */
async function resolveRecipients(notifyUserIds: string[] = []) {
  const recipients = new Map<string, string | null>();
  const admins = await query<{ id: string; phone: string }>(
    `SELECT id, phone FROM users WHERE role = 'admin' AND phone IS NOT NULL`,
  );
  admins.forEach((a) => recipients.set(a.phone, a.id));
  for (const id of notifyUserIds) {
    const u = await queryOne<{ id: string; phone: string | null }>(`SELECT id, phone FROM users WHERE id = $1`, [id]);
    if (u?.phone && !recipients.has(u.phone)) recipients.set(u.phone, u.id);
  }
  config.sms.alertPhoneNumbers.forEach((p) => {
    if (!recipients.has(p)) recipients.set(p, null);
  });
  return [...recipients.entries()].map(([phone, userId]) => ({ phone, userId }));
}

const router = Router();

/**
 * Vehicle event → SMS to fleet administrators (and relevant users).
 * Called by the telemetry and vehicle services; admins can also call it directly.
 */
router.post(
  '/api/notifications/events',
  authenticateUserOrService,
  authorize('admin'),
  ah(async (req, res) => {
    const evt = eventSchema.parse(req.body);
    const recipients = await resolveRecipients(evt.notifyUserIds);
    const body = `[Fleet ${evt.severity.toUpperCase()}] ${evt.message}`.slice(0, 320);

    const rows: NotificationRow[] = [];
    if (recipients.length === 0) {
      const [row] = await query<NotificationRow>(
        `INSERT INTO notifications (id, vehicle_id, event_type, severity, channel, recipient, message, provider, status, error)
         VALUES ($1, $2, $3, $4, 'sms', 'none', $5, $6, 'failed', 'No recipients with a phone number are configured') RETURNING *`,
        [randomUUID(), evt.vehicleId ?? null, evt.eventType, evt.severity, body, getSmsProvider().name],
      );
      rows.push(row);
    }
    for (const r of recipients) {
      rows.push(
        await sendAndRecord({
          vehicleId: evt.vehicleId,
          eventType: evt.eventType,
          severity: evt.severity,
          recipient: r.phone,
          recipientUserId: r.userId,
          message: body,
        }),
      );
    }

    const sent = rows.filter((r) => r.status === 'sent').length;
    res.status(201).json({
      eventType: evt.eventType,
      provider: getSmsProvider().name,
      summary: { total: rows.length, sent, failed: rows.length - sent },
      notifications: rows.map(toNotification),
    });
  }),
);

/** Send a one-off SMS (useful for checking the Twilio setup). */
router.post(
  '/api/notifications/test-sms',
  authenticate,
  authorize('admin'),
  ah(async (req, res) => {
    const { to, message } = testSmsSchema.parse(req.body);
    const row = await sendAndRecord({ eventType: 'TEST', severity: 'info', recipient: to, message });
    res.status(row.status === 'sent' ? 201 : 502).json({ notification: toNotification(row) });
  }),
);

router.get(
  '/api/notifications',
  authenticateUserOrService,
  authorize('admin', 'operator'),
  ah(async (req, res) => {
    const q = listQuery.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status) where.push(`status = $${params.push(q.status)}`);
    if (q.vehicleId) where.push(`vehicle_id = $${params.push(q.vehicleId)}`);
    if (q.eventType) where.push(`event_type = $${params.push(q.eventType)}`);
    params.push(q.limit);
    const rows = await query<NotificationRow>(
      `SELECT * FROM notifications ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    const stats = await query<{ status: string; count: number }>(
      `SELECT status, COUNT(*)::int AS count FROM notifications GROUP BY status`,
    );
    res.json({
      provider: getSmsProvider().name,
      stats: Object.fromEntries(stats.map((s) => [s.status, Number(s.count)])),
      count: rows.length,
      notifications: rows.map(toNotification),
    });
  }),
);

router.get(
  '/api/notifications/:id',
  authenticateUserOrService,
  authorize('admin', 'operator'),
  ah(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw ApiError.badRequest('id must be a UUID');
    const row = await queryOne<NotificationRow>(`SELECT * FROM notifications WHERE id = $1`, [req.params.id]);
    if (!row) throw ApiError.notFound('Notification not found');
    res.json({ notification: toNotification(row) });
  }),
);

/** Retry a failed notification. */
router.post(
  '/api/notifications/:id/retry',
  authenticate,
  authorize('admin'),
  ah(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw ApiError.badRequest('id must be a UUID');
    const row = await queryOne<NotificationRow>(`SELECT * FROM notifications WHERE id = $1`, [req.params.id]);
    if (!row) throw ApiError.notFound('Notification not found');
    if (row.status !== 'failed') throw ApiError.conflict('Only failed notifications can be retried');
    const retried = await sendAndRecord({
      vehicleId: row.vehicle_id,
      eventType: row.event_type,
      severity: row.severity,
      recipient: row.recipient,
      recipientUserId: row.recipient_user_id,
      message: row.message,
    });
    res.status(201).json({ notification: toNotification(retried) });
  }),
);

export function createNotificationService() {
  return createServiceApp('notification', router);
}
