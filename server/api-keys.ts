import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB, Row } from './db.js';
import { AppError, assert, audit, id, verifyPassword } from './core.js';
import { apiEndpoints, apiScopes, integrationSpec, type ApiScope } from '../shared/integration.js';
import { integrationGuide } from './integration-guide.js';

export type ApiKeyIdentity = { id: string; scopes: ApiScope[] };
declare module 'fastify' { interface FastifyRequest { apiKey: ApiKeyIdentity | null; } }
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const publicFields = 'id,name,prefix,scopes,expires_at,revoked_at,last_used_at,created_at';

export function apiKeyService(db: DB, appUrl: string) {
  async function authenticate(authorization: string): Promise<{ user: Row; identity: ApiKeyIdentity }> {
    const token = /^Bearer (ccmax_sk_[A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1];
    if (!token) throw new AppError(401, 'API 密钥无效、已过期或已撤销', 'INVALID_API_KEY');
    const [row] = await db.query(`SELECT u.*,k.id AS api_key_id,k.scopes AS api_key_scopes FROM api_keys k JOIN users u ON u.id=k.user_id
      WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND k.expires_at>now() AND u.active=true`, [hash(token)]);
    if (!row) throw new AppError(401, 'API 密钥无效、已过期或已撤销', 'INVALID_API_KEY');
    const { api_key_id, api_key_scopes, ...user } = row;
    return { user, identity: { id: api_key_id, scopes: api_key_scopes } };
  }
  function authorize(identity: ApiKeyIdentity, method: string, route?: string) {
    const endpoint = apiEndpoints.find(endpoint => endpoint.path === route && endpoint.method === (method === 'HEAD' ? 'GET' : method));
    if (!endpoint) throw new AppError(403, '此接口仅支持网页登录操作', 'SESSION_REQUIRED');
    if (!identity.scopes.includes(endpoint.scope)) throw new AppError(403, 'API 密钥缺少此操作所需权限', 'INSUFFICIENT_SCOPE');
  }
  async function used(identity: ApiKeyIdentity) {
    await db.query(`UPDATE api_keys SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')`, [identity.id]);
  }
  function register(app: FastifyInstance) {
    app.get('/api/openapi.json', async () => integrationSpec(appUrl));
    app.get('/api/docs', async (_req, reply) => reply.type('text/html; charset=utf-8').send(integrationGuide(appUrl)));
    app.get('/api/settings/api-keys', async req => ({
      keys: await db.query(`SELECT ${publicFields} FROM api_keys WHERE user_id=$1 ORDER BY (revoked_at IS NULL AND expires_at>now()) DESC,created_at DESC LIMIT 100`, [req.user.id]),
      baseUrl: new URL(appUrl).origin, scopes: apiScopes, maxActiveKeys: 10,
    }));
    app.post('/api/settings/api-keys', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
      const body = z.object({
        name: z.string().trim().min(1).max(80),
        scopes: z.array(z.enum(apiScopes)).min(1).max(apiScopes.length).refine(values => values.includes('read') && new Set(values).size === values.length, 'API 密钥必须包含只读权限且不能重复'),
        expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).default(90),
        currentPassword: z.string().min(1).max(200),
      }).strict().parse(req.body);
      assert(await verifyPassword(body.currentPassword, req.user.password_hash), '当前密码错误');
      const token = `ccmax_sk_${randomBytes(32).toString('base64url')}`;
      const created = await db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ccmax:api-keys:${req.user.id}`]);
        const [user] = await tx.query('SELECT password_hash,active FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
        assert(user?.active && user.password_hash === req.user.password_hash, '登录已过期或账号已停用', 401);
        const [count] = await tx.query('SELECT count(*) AS count FROM api_keys WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()', [req.user.id]);
        assert(Number(count.count) < 10, '最多保留 10 个有效 API 密钥，请先撤销不再使用的密钥', 409);
        const [key] = await tx.query(`INSERT INTO api_keys(id,user_id,name,prefix,token_hash,scopes,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${publicFields}`, [id(), req.user.id, body.name, token.slice(0, 17), hash(token), body.scopes, new Date(Date.now() + body.expiresInDays * 86400000)]);
        await audit(tx, req.user.id, 'api_key.create', key.id, { name: key.name, scopes: key.scopes });
        return key;
      });
      reply.header('Pragma', 'no-cache');
      return { key: created, token };
    });
    app.delete('/api/settings/api-keys/:id', async req => {
      const target = z.string().uuid().parse((req.params as Row).id);
      await db.transaction(async tx => {
        const [key] = await tx.query('SELECT id,revoked_at FROM api_keys WHERE id=$1 AND user_id=$2 FOR UPDATE', [target, req.user.id]);
        assert(key, 'API 密钥不存在', 404);
        if (key.revoked_at) return;
        await tx.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1', [target]);
        await audit(tx, req.user.id, 'api_key.revoke', target);
      });
      return { ok: true };
    });
  }
  return { authenticate, authorize, used, register };
}
