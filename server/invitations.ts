import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB, Row } from './db.js';
import { AppError, assert, audit, hashPassword, id, secretBox, today } from './core.js';
import { lockPricing } from './pricing.js';
import { PROVIDERS, PROVIDER_KEYS } from './providers.js';

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const unavailable = () => new AppError(410, '邀请链接无效、已到期、已停用或名额已用完', 'INVITATION_UNAVAILABLE');

export async function invitationMigration(tx: DB) {
  await tx.query(`CREATE TABLE invitations (
    id text PRIMARY KEY, inviter_id text NOT NULL REFERENCES users(id), name text NOT NULL,
    token_hash text NOT NULL UNIQUE, token_secret text NOT NULL,
    expires_at timestamptz, max_uses integer CHECK(max_uses>0),
    used_count integer NOT NULL DEFAULT 0 CHECK(used_count>=0 AND (max_uses IS NULL OR used_count<=max_uses)),
    revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await tx.query('CREATE INDEX invitations_inviter ON invitations(inviter_id,created_at DESC)');
  await tx.query(`CREATE TABLE invitation_rates (
    invitation_id text NOT NULL REFERENCES invitations(id),
    provider text NOT NULL CHECK(provider IN (${PROVIDER_KEYS.map(p => `'${p}'`).join(',')})),
    rate numeric(5,4) NOT NULL CHECK(rate>=0 AND rate<=1), PRIMARY KEY(invitation_id,provider)
  )`);
  await tx.query(`CREATE TABLE invitation_redemptions (
    invitation_id text NOT NULL REFERENCES invitations(id), user_id text PRIMARY KEY REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
}

// Restrict anonymous access to these two method/route combinations.
export function isPublicInvitation(method: string, route?: string) {
  return (method === 'GET' || method === 'HEAD') && route === '/api/invitations/:token'
    || method === 'POST' && route === '/api/invitations/:token/register';
}

async function activeTeam(tx: DB, inviterId: string) {
  // Row locks serialize registration against disabling any ancestor.
  const chain = await tx.query(`WITH RECURSIVE chain AS (
    SELECT id,parent_id FROM users WHERE id=$1
    UNION ALL SELECT u.id,u.parent_id FROM users u JOIN chain c ON c.parent_id=u.id
  ) SELECT u.id,u.active FROM users u JOIN chain c ON c.id=u.id ORDER BY u.id FOR SHARE OF u`, [inviterId]);
  if (!chain.length || chain.some(u => !u.active)) throw unavailable();
}

export function registerInvitations(app: FastifyInstance, db: DB, box: ReturnType<typeof secretBox>, appUrl: string) {
  const fields = 'id,inviter_id,name,expires_at,max_uses,used_count,revoked_at,created_at';
  const publicFields = (row: Row) => Object.fromEntries(fields.split(',').map(key => [key, row[key]]));
  const link = (row: Row) => new URL(`/invite/${box.decrypt<string>(row.token_secret)}`, appUrl).href;
  const rates = async (tx: DB, invitationId: string) => Object.fromEntries((await tx.query(
    'SELECT provider,rate FROM invitation_rates WHERE invitation_id=$1 ORDER BY provider', [invitationId],
  )).map(row => [row.provider, row.rate]));

  async function available(tx: DB, rawToken: unknown, lock = false) {
    const parsed = tokenSchema.safeParse(rawToken);
    if (!parsed.success) throw unavailable();
    const [invite] = await tx.query(`SELECT *, (expires_at IS NULL OR expires_at>clock_timestamp()) AS unexpired
      FROM invitations WHERE token_hash=$1${lock ? ' FOR UPDATE' : ''}`, [digest(parsed.data)]);
    if (!invite || invite.revoked_at || !invite.unexpired || invite.max_uses !== null && invite.used_count >= invite.max_uses) throw unavailable();
    await activeTeam(tx, invite.inviter_id);
    if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) throw unavailable();
    return invite;
  }

  app.get('/api/team/invitations', async req => {
    const invitations = await db.query(`SELECT ${fields},token_secret FROM invitations WHERE inviter_id=$1 ORDER BY created_at DESC,id`, [req.user.id]);
    const quotes = await db.query(`SELECT r.* FROM invitation_rates r JOIN invitations i ON i.id=r.invitation_id WHERE i.inviter_id=$1`, [req.user.id]);
    return { invitations: invitations.map(row => ({ ...publicFields(row), url: link(row), rates: Object.fromEntries(quotes.filter(q => q.invitation_id === row.id).map(q => [q.provider, q.rate])) })) };
  });

  app.post('/api/team/invitations', async req => {
    const data = z.object({
      name: z.string().trim().min(1).max(80),
      rates: z.partialRecord(z.enum(PROVIDER_KEYS), z.number().min(0).max(1).multipleOf(0.0001)).refine(value => Object.keys(value).length > 0, '请至少设置一个平台价格'),
      expiresInDays: z.number().int().min(1).max(365).nullable().default(30),
      maxUses: z.number().int().min(1).max(1000000).nullable().default(null),
    }).strict().parse(req.body);
    const token = randomBytes(32).toString('base64url');
    return db.transaction(async tx => {
      await lockPricing(tx);
      await activeTeam(tx, req.user.id);
      const [count] = await tx.query(`SELECT count(*) AS count FROM invitations WHERE inviter_id=$1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>now()) AND (max_uses IS NULL OR used_count<max_uses)`, [req.user.id]);
      assert(Number(count.count) < 100, '最多保留 100 条有效邀请链接，请先停用不再使用的链接', 409);
      const [invite] = await tx.query(`INSERT INTO invitations(id,inviter_id,name,token_hash,token_secret,expires_at,max_uses)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [id(), req.user.id, data.name, digest(token), box.encrypt(token), data.expiresInDays === null ? null : new Date(Date.now() + data.expiresInDays * 86400000), data.maxUses]);
      for (const [provider, rate] of Object.entries(data.rates)) await tx.query('INSERT INTO invitation_rates(invitation_id,provider,rate) VALUES($1,$2,$3)', [invite.id, provider, rate]);
      await audit(tx, req.user.id, 'invitation.create', invite.id, { name: data.name, rates: data.rates, expiresInDays: data.expiresInDays, maxUses: data.maxUses });
      return { invitation: { ...publicFields(invite), url: link(invite), rates: data.rates } };
    });
  });

  app.delete('/api/team/invitations/:id', async req => {
    const target = z.string().uuid().parse((req.params as Row).id);
    await db.transaction(async tx => {
      const [invite] = await tx.query('SELECT id,revoked_at FROM invitations WHERE id=$1 AND inviter_id=$2 FOR UPDATE', [target, req.user.id]);
      assert(invite, '邀请链接不存在', 404);
      if (invite.revoked_at) return;
      await tx.query('UPDATE invitations SET revoked_at=now() WHERE id=$1', [target]);
      await audit(tx, req.user.id, 'invitation.revoke', target);
    });
    return { ok: true };
  });

  app.get('/api/invitations/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async req => db.transaction(async tx => {
    const invite = await available(tx, (req.params as Row).token);
    const [inviter] = await tx.query('SELECT name FROM users WHERE id=$1', [invite.inviter_id]);
    return { inviterName: inviter.name, rates: await rates(tx, invite.id), providers: PROVIDERS, expiresAt: invite.expires_at };
  }));

  app.post('/api/invitations/:token/register', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async req => {
    const data = z.object({ name: z.string().trim().min(1).max(80), email: z.email().max(200).transform(v => v.toLowerCase()), password: z.string().min(12, '密码至少 12 位').max(200) }).strict().parse(req.body);
    // Check the invitation before doing password hashing, then recheck under lock.
    await db.transaction(tx => available(tx, (req.params as Row).token));
    const hash = await hashPassword(data.password);
    return db.transaction(async tx => {
      await lockPricing(tx);
      const invite = await available(tx, (req.params as Row).token, true);
      const quotes = await rates(tx, invite.id), userId = id(), effective = today();
      assert(Object.keys(quotes).length, '邀请链接尚未设置价格', 409);
      const [existing] = await tx.query('SELECT id FROM users WHERE email=$1', [data.email]);
      assert(!existing, '该邮箱已注册，请直接登录或联系邀请人', 409);
      await tx.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$4,$5)', [userId, invite.inviter_id, data.email, data.name, hash]);
      for (const [provider, rate] of Object.entries(quotes)) await tx.query('INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5,$6)', [id(), userId, provider, rate, effective, invite.inviter_id]);
      await tx.query('INSERT INTO invitation_redemptions(invitation_id,user_id) VALUES($1,$2)', [invite.id, userId]);
      await tx.query('UPDATE invitations SET used_count=used_count+1 WHERE id=$1', [invite.id]);
      await audit(tx, invite.inviter_id, 'team.create', userId, { name: data.name, invitationId: invite.id });
      await audit(tx, userId, 'invitation.accept', invite.id, { inviterId: invite.inviter_id, rates: quotes, effectiveDate: effective });
      return { ok: true };
    });
  });
}
