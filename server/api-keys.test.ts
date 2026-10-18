import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createApp } from './app.js';
import { migrate, type DB } from './db.js';
import { bootstrap, id } from './core.js';
import { openTestDB, seedSettlement } from './test-db.js';
import { apiEndpoints, apiScopes } from '../shared/integration.js';

describe('agent API authentication and permissions', () => {
  let db: DB, app: FastifyInstance, ownerId: string, a: string, b: string, leaf: string, cookie: string;
  const password = 'agent-api-password';
  async function login(email: string) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-ccmax-request': '1' }, payload: { email, password } });
    expect(response.statusCode).toBe(200);
    return String(response.headers['set-cookie']).split(';')[0];
  }
  async function session(method: string, url: string, payload?: unknown, asCookie = cookie) {
    return app.inject({ method, url, headers: { cookie: asCookie, 'x-ccmax-request': '1' }, payload } as InjectOptions);
  }
  async function createKey(scopes: readonly string[] = ['read'], asCookie = cookie) {
    const response = await session('POST', '/api/settings/api-keys', { name: 'Website backend', scopes, expiresInDays: 90, currentPassword: password }, asCookie);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ token: string; key: { id: string } }>();
  }
  async function call(token: string, method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...extraHeaders }, payload } as InjectOptions);
  }
  beforeEach(async () => {
    db = await openTestDB(); await migrate(db);
    await bootstrap(db, { ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: password });
    const [owner] = await db.query("SELECT * FROM users WHERE role='owner'"); ownerId = owner.id;
    a = id(); b = id(); leaf = id();
    for (const [user, parent, email] of [[a, ownerId, 'a@example.com'], [b, ownerId, 'b@example.com'], [leaf, a, 'leaf@example.com']]) {
      await db.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$3,$4)', [user, parent, email, owner.password_hash]);
      for (const provider of ['gatelink', 'ai008', 'minicc']) await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,'1970-01-01',$5)", [id(), user, provider, user === leaf ? 0.1 : 0.3, parent]);
      await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,true)', [id(), user, `account-${email}`]);
    }
    ({ app } = await createApp(db, { encryptionKey: 'ab'.repeat(32), appUrl: 'http://localhost:3000' }));
    cookie = await login('a@example.com');
  });
  afterEach(async () => { await app.close(); await db.close(); });

  it('shows a scoped secret once, stores only its hash, and authenticates without website cookies or CSRF headers', async () => {
    const issued = await createKey();
    expect(issued.token).toMatch(/^ccmax_sk_[\w-]{43}$/);
    const listed = await session('GET', '/api/settings/api-keys');
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body).not.toContain(issued.token);
    expect(listed.body).not.toContain('token_hash');
    const [stored] = await db.query('SELECT * FROM api_keys WHERE id=$1', [issued.key.id]);
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.token_hash).not.toBe(issued.token);
    expect(stored.scopes).toEqual(['read']);
    const accounts = await call(issued.token, 'GET', '/api/accounts');
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json().accounts.map((account: any) => account.owner_id).sort()).toEqual([a, leaf].sort());
    expect(accounts.body).not.toContain(`account-b@example.com`);
    expect((await db.query('SELECT last_used_at FROM api_keys WHERE id=$1', [issued.key.id]))[0].last_used_at).toBeTruthy();
    const me = await call(issued.token, 'GET', '/api/auth/me');
    expect(me.json().user.id).toBe(a);
    expect(me.headers['set-cookie']).toBeUndefined();
    const preview = await call(issued.token, 'GET', '/api/invoices/preview?from=2000-01-01&to=2000-01-01');
    expect(preview.statusCode).toBe(200); expect(preview.json()).toMatchObject({ userId: a, ready: { count: 0 }, unassigned: { count: 0 } });
    expect((await call(issued.token, 'GET', `/api/invoices/preview?userId=${b}&from=2000-01-01&to=2000-01-01`)).statusCode).toBe(403);
    expect((await call(issued.token, 'POST', '/api/invoices', { userId: a, from: '2000-01-01', to: '2000-01-01', previewToken: preview.json().previewToken })).json().code).toBe('INSUFFICIENT_SCOPE');
  });

  it('enforces scopes, never falls back to cookies, and keeps key/password/admin endpoints session-only', async () => {
    const read = await createKey();
    const denied = await call(read.token, 'POST', '/api/accounts', { email: 'new@example.com' });
    expect(denied.statusCode).toBe(403); expect(denied.json().code).toBe('INSUFFICIENT_SCOPE');
    const full = await createKey(apiScopes);
    for (const [method, path, payload] of [
      ['GET', '/api/settings/api-keys'], ['POST', '/api/settings/api-keys', {}], ['DELETE', `/api/settings/api-keys/${read.key.id}`],
      ['POST', '/api/auth/password', {}], ['POST', '/api/auth/logout', {}], ['POST', '/api/connections', {}],
      ['POST', '/api/usage/import', {}],
    ] as const) {
      const response = await call(full.token, method, path, payload, { cookie, 'x-ccmax-request': '1' });
      expect(response.statusCode, path).toBe(403); expect(response.json().code).toBe('SESSION_REQUIRED');
    }
    const invalid = await call('invalid', 'GET', '/api/accounts', undefined, { cookie });
    expect(invalid.statusCode).toBe(401); expect(invalid.json().code).toBe('INVALID_API_KEY');
    expect((await app.inject({ url: '/api/accounts' })).statusCode).toBe(401);
  });

  it('allows only own-account writes and direct-child management, retaining sibling isolation and audit attribution', async () => {
    const issued = await createKey(['read', 'accounts:write', 'team:write']);
    const created = await call(issued.token, 'POST', '/api/accounts', { email: 'api-created@example.com', userId: b });
    expect(created.statusCode).toBe(200); expect(created.json().account.owner_id).toBe(a);
    const child = await call(issued.token, 'POST', '/api/team', { name: 'API child', email: 'api-child@example.com', password, rates: { minicc: 0.2 } });
    expect(child.statusCode).toBe(200); expect(child.json().user.parent_id).toBe(a);
    expect((await call(issued.token, 'PATCH', `/api/team/${b}`, { active: false })).statusCode).toBe(403);
    const [siblingAccount] = await db.query('SELECT id FROM accounts WHERE owner_id=$1', [b]);
    expect((await call(issued.token, 'POST', `/api/accounts/${siblingAccount.id}/proxy`, { proxyId: id() })).statusCode).toBe(403);
    expect((await call(issued.token, 'POST', '/api/withdrawals', { amount: '1', method: 'test', destination: 'test', key: id() })).json().code).toBe('INSUFFICIENT_SCOPE');
    const audits = await db.query("SELECT * FROM audits WHERE action='api.request' AND target_id=$1 ORDER BY created_at", [issued.key.id]);
    expect(audits.some(row => row.actor_id === a && row.details.route === '/api/accounts' && row.details.status === 200)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(issued.token);
    expect(JSON.stringify(audits)).not.toContain(password);
  });

  it('grants financial writes only explicitly and keeps withdrawals idempotent', async () => {
    const issued = await createKey(['read', 'finance:write']);
    await seedSettlement(db, a, '10');
    const payload = { amount: '2', method: '币安 ID', destination: '123456789', key: id() };
    const first = await call(issued.token, 'POST', '/api/withdrawals', payload);
    const second = await call(issued.token, 'POST', '/api/withdrawals', payload);
    expect(first.statusCode).toBe(200); expect(second.json().id).toBe(first.json().id);
    expect((await call(issued.token, 'GET', '/api/finance')).json().balance.available).toBe('8.00000000');
    expect((await call(issued.token, 'POST', '/api/accounts', { email: 'not-allowed@example.com' })).json().code).toBe('INSUFFICIENT_SCOPE');
  });

  it('scopes pricing reports and reviewed batches to the caller and their direct children',async()=>{
    const read=await createKey(),writer=await createKey(['read','team:write']);
    const report=await call(read.token,'GET','/api/team/pricing');
    expect(report.statusCode).toBe(200);expect(report.body).not.toContain(b);
    const input={provider:'ai008',userIds:[leaf],mode:'fixed',value:0.2};
    expect((await call(read.token,'POST','/api/team/rates/preview',input)).json().code).toBe('INSUFFICIENT_SCOPE');
    const preview=await call(writer.token,'POST','/api/team/rates/preview',input);expect(preview.statusCode).toBe(200);
    const data={...input,snapshot:preview.json().snapshot};
    expect((await call(read.token,'POST','/api/team/rates/batch',data)).json().code).toBe('INSUFFICIENT_SCOPE');
    expect((await call(writer.token,'POST','/api/team/rates/batch',data)).statusCode).toBe(200);
    expect((await call(writer.token,'POST','/api/team/rates/preview',{...input,userIds:[b]})).statusCode).toBe(403);
  });

  it('limits key management to its owner and immediately rejects revoked or expired keys', async () => {
    const issued = await createKey();
    const otherCookie = await login('b@example.com');
    expect((await session('GET', '/api/settings/api-keys', undefined, otherCookie)).json().keys).toHaveLength(0);
    expect((await session('DELETE', `/api/settings/api-keys/${issued.key.id}`, undefined, otherCookie)).statusCode).toBe(404);
    expect((await session('DELETE', `/api/settings/api-keys/${issued.key.id}`)).statusCode).toBe(200);
    expect((await session('DELETE', `/api/settings/api-keys/${issued.key.id}`)).statusCode).toBe(200);
    expect((await call(issued.token, 'GET', '/api/accounts')).statusCode).toBe(401);
    const expired = await createKey();
    await db.query("UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.key.id]);
    expect((await call(expired.token, 'GET', '/api/accounts')).json().code).toBe('INVALID_API_KEY');
  });

  it('blocks keys for disabled users/ancestors and revokes them on password change or reset', async () => {
    const issued = await createKey();
    await db.query('UPDATE users SET active=false WHERE id=$1', [ownerId]);
    expect((await call(issued.token, 'GET', '/api/accounts')).statusCode).toBe(403);
    await db.query('UPDATE users SET active=true WHERE id=$1', [ownerId]);
    await db.query('UPDATE users SET active=false WHERE id=$1', [a]);
    expect((await call(issued.token, 'GET', '/api/accounts')).statusCode).toBe(401);
    await db.query('UPDATE users SET active=true WHERE id=$1', [a]);
    expect((await session('POST', '/api/auth/password', { currentPassword: password, newPassword: 'changed-password-123' })).statusCode).toBe(200);
    expect((await call(issued.token, 'GET', '/api/accounts')).statusCode).toBe(401);
    const bCookie = await login('b@example.com'), otherKey = await createKey(['read'], bCookie);
    const ownerCookie = await login('owner@example.com');
    expect((await session('PATCH', `/api/team/${b}`, { newPassword: 'reset-password-123' }, ownerCookie)).statusCode).toBe(200);
    expect((await call(otherKey.token, 'GET', '/api/accounts')).statusCode).toBe(401);
  });

  it('requires password confirmation, rejects privilege injection and caps active keys', async () => {
    const body = { name: 'key', scopes: ['read'], expiresInDays: 90, currentPassword: password };
    expect((await session('POST', '/api/settings/api-keys', { ...body, currentPassword: 'wrong' })).statusCode).toBe(400);
    expect((await session('POST', '/api/settings/api-keys', { ...body, userId: b })).statusCode).toBe(400);
    expect((await session('POST', '/api/settings/api-keys', { ...body, scopes: ['admin'] })).statusCode).toBe(400);
    expect((await session('POST', '/api/settings/api-keys', { ...body, scopes: ['accounts:write'] })).statusCode).toBe(400);
    for (let i = 0; i < 10; i++) await db.query("INSERT INTO api_keys(id,user_id,name,prefix,token_hash,scopes,expires_at) VALUES($1,$2,'fixture','masked',$3,ARRAY['read'],now()+interval '1 day')", [id(), a, `fixture-${i}`]);
    expect((await session('POST', '/api/settings/api-keys', body)).statusCode).toBe(409);
  });

  it('retains website CSRF checks and supplies a per-user API rate limit with Retry-After', async () => {
    const issued = await createKey(['read', 'accounts:write']);
    expect((await app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie }, payload: { email: 'csrf@example.com' } })).statusCode).toBe(403);
    expect((await session('POST', '/api/accounts', { email: 'origin@example.com' })).statusCode).toBe(200);
    const external = await app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie, origin: 'https://other.example.com', 'x-ccmax-request': '1' }, payload: { email: 'no@example.com' } });
    expect(external.statusCode).toBe(403);
    for (let i = 0; i < 120; i++) expect((await call(issued.token, 'GET', '/api/auth/me')).statusCode).toBe(200);
    const second = await createKey();
    const limited = await call(second.token, 'GET', '/api/auth/me');
    expect(limited.statusCode).toBe(429); expect(limited.json().code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('publishes a matching OpenAPI contract and self-contained guide without requiring a secret', async () => {
    const response = await app.inject({ url: '/api/openapi.json' });
    expect(response.statusCode).toBe(200); const spec = response.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers).toEqual([{ url: 'http://localhost:3000' }]);
    for (const endpoint of apiEndpoints) {
      const path = endpoint.path.replace(/:(\w+)/g, '{$1}');
      expect(spec.paths[path][endpoint.method.toLowerCase()]['x-required-scope']).toBe(endpoint.scope);
      expect(app.hasRoute({ method: endpoint.method, url: endpoint.path }), endpoint.path).toBe(true);
    }
    expect(spec.paths).not.toHaveProperty('/api/settings/api-keys');
    const guide = await app.inject({ url: '/api/docs' });
    expect(guide.statusCode).toBe(200); expect(guide.headers['content-type']).toContain('text/html');
    expect(guide.body).toContain('Authorization: Bearer');
    expect(guide.body).toContain('server-to-server');
  });
});
