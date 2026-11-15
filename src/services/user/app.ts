import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authenticateUserOrService, authorize, optionalAuth, ROLES, signToken, verifyToken, type Role } from '../../shared/auth';
import { createServiceApp } from '../../shared/create-service-app';
import { query, queryOne } from '../../shared/db';
import { ah, ApiError } from '../../shared/errors';

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  phone: string | null;
  created_at: Date;
}

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format, e.g. +14155550123');

const registerSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email().transform((v) => v.toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters').max(100),
  phone: e164.optional(),
  role: z.enum(ROLES).optional(),
});

const loginSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase()),
  password: z.string().min(1),
});

const updateSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  phone: e164.nullable().optional(),
  role: z.enum(ROLES).optional(),
});

export const toPublicUser = (u: UserRow) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  phone: u.phone,
  createdAt: u.created_at,
});

export async function createUser(input: { name: string; email: string; password: string; role: Role; phone?: string | null }) {
  const hash = await bcrypt.hash(input.password, 10);
  const [row] = await query<UserRow>(
    `INSERT INTO users (id, name, email, password_hash, role, phone) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [randomUUID(), input.name, input.email.toLowerCase(), hash, input.role, input.phone ?? null],
  );
  return row;
}

const router = Router();

/** Public self-registration creates a viewer. Only an admin may assign another role. */
router.post(
  '/api/users/register',
  optionalAuth,
  ah(async (req, res) => {
    const body = registerSchema.parse(req.body);
    if (body.role && body.role !== 'viewer' && req.user?.role !== 'admin') {
      throw ApiError.forbidden('Only an admin can create operator or admin accounts');
    }
    const existing = await queryOne<UserRow>(`SELECT id FROM users WHERE email = $1`, [body.email]);
    if (existing) throw ApiError.conflict('Email is already registered');
    const user = await createUser({ ...body, role: body.role ?? 'viewer' });
    res.status(201).json({ user: toPublicUser(user) });
  }),
);

router.post(
  '/api/users/login',
  ah(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await queryOne<UserRow>(`SELECT * FROM users WHERE email = $1`, [email]);
    const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!user || !ok) throw ApiError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    const token = signToken(user);
    const claims = verifyToken(token) as unknown as { exp: number };
    res.json({ token, tokenType: 'Bearer', expiresAt: new Date(claims.exp * 1000).toISOString(), user: toPublicUser(user) });
  }),
);

/** Verifies a JWT and returns its decoded claims. */
router.get(
  '/api/users/verify',
  authenticate,
  ah(async (req, res) => {
    const token = req.header('authorization')!.split(' ')[1];
    const claims = verifyToken(token) as unknown as Record<string, unknown>;
    res.json({ valid: true, claims });
  }),
);

router.get(
  '/api/users/me',
  authenticate,
  ah(async (req, res) => {
    const user = await queryOne<UserRow>(`SELECT * FROM users WHERE id = $1`, [req.user!.id]);
    if (!user) throw ApiError.notFound('User not found');
    res.json({ user: toPublicUser(user) });
  }),
);

router.get(
  '/api/users',
  authenticateUserOrService,
  authorize('admin'),
  ah(async (req, res) => {
    const role = typeof req.query.role === 'string' ? req.query.role : undefined;
    const rows = role
      ? await query<UserRow>(`SELECT * FROM users WHERE role = $1 ORDER BY created_at`, [role])
      : await query<UserRow>(`SELECT * FROM users ORDER BY created_at`);
    res.json({ count: rows.length, users: rows.map(toPublicUser) });
  }),
);

router.get(
  '/api/users/:id',
  authenticateUserOrService,
  ah(async (req, res) => {
    if (req.user!.role !== 'admin' && req.user!.role !== 'service' && req.user!.id !== req.params.id) {
      throw ApiError.forbidden('You can only view your own profile');
    }
    if (!z.string().uuid().safeParse(req.params.id).success) throw ApiError.badRequest('id must be a UUID');
    const user = await queryOne<UserRow>(`SELECT * FROM users WHERE id = $1`, [req.params.id]);
    if (!user) throw ApiError.notFound('User not found');
    res.json({ user: toPublicUser(user) });
  }),
);

router.patch(
  '/api/users/:id',
  authenticate,
  authorize('admin'),
  ah(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw ApiError.badRequest('id must be a UUID');
    const body = updateSchema.parse(req.body);
    const current = await queryOne<UserRow>(`SELECT * FROM users WHERE id = $1`, [req.params.id]);
    if (!current) throw ApiError.notFound('User not found');
    const [row] = await query<UserRow>(
      `UPDATE users SET name = $2, phone = $3, role = $4 WHERE id = $1 RETURNING *`,
      [
        current.id,
        body.name ?? current.name,
        body.phone === undefined ? current.phone : body.phone,
        body.role ?? current.role,
      ],
    );
    res.json({ user: toPublicUser(row) });
  }),
);

export function createUserService() {
  return createServiceApp('user', router);
}
