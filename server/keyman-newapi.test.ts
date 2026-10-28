import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyManClient } from './keyman-newapi.js';
import { createApp } from './app.js';
import { bootstrap, id, secretBox } from './core.js';
import { migrate } from './db.js';
import { openTestDB } from './test-db.js';
import { syncPublishedKeyTasks } from './key-market.js';

describe('KeyMan NewAPI adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('authenticates with tenant headers and maps gateway/channel responses', async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push({ path: url.pathname + url.search, init });
      if (url.pathname.endsWith('/system/auth/login')) return Response.json({ code: 0, data: { accessToken: 'access-token-fixture', refreshToken: 'refresh-token-fixture' } });
      if (url.pathname.endsWith('/newapi/gateway/simple-list')) return Response.json({ code: 0, data: [{ id: 7, name: 'fixture gateway' }] });
      if (url.pathname.endsWith('/newapi/channel/groups')) return Response.json({ code: 0, data: ['default', 'vertex_gemini'] });
      if (url.pathname.endsWith('/newapi/channel/console-status')) return Response.json({ code: 0, data: { quota_per_unit: 500000 } });
      if (url.pathname.endsWith('/newapi/channel/page')) return Response.json({ code: 0, data: { list: [{ id: 11, name: 'fixture channel', status: 1, usedQuota: 100000, models: ['gpt-4o'] }], total: 1 } });
      if (url.pathname.endsWith('/newapi/channel/create')) return Response.json({ code: 0, data: { id: 12, name: 'created', status: 1, usedQuota: 0 } });
      return Response.json({ code: 0, data: {} });
    }) as typeof fetch;
    try {
      const client = new KeyManClient('https://kapi.xkk.io/admin-api', { kind: 'password', username: 'fixture', password: 'fixture', tenantId: '1' });
      await client.authenticate();
      const status = await client.status();
      const channels = await client.listChannels('7');
      const groups = await client.listGroups('7');
      const created = await client.createChannel({ gatewayId: '7', key: 'sk-fixture-secret', name: 'fixture', models: ['gpt-4o'], groups: ['vertex_gemini'], socks5ProxyLevel: 'high' });
      expect(status.quotaPerUnit).toBe(500000);
      expect(channels[0]).toMatchObject({ id: '11', usedQuota: 100000, models: ['gpt-4o'] });
      expect(groups).toEqual(['default', 'vertex_gemini']);
      expect(created.id).toBe('12');
      const pageCall = calls.find(call => call.path.includes('/newapi/channel/page'))!;
      expect(new Headers(pageCall.init?.headers).get('Authorization')).toBe('Bearer access-token-fixture');
      expect(new Headers(pageCall.init?.headers).get('tenant-id')).toBe('1');
      const createCall = calls.find(call => call.path.endsWith('/newapi/channel/create'))!;
      expect(JSON.parse(String(createCall.init?.body))).toMatchObject({ gatewayId: '7', keys: ['sk-fixture-secret'], groups: ['vertex_gemini'], autoBan: 1, mode: 'security_gateway' });
      expect(JSON.parse(String(createCall.init?.body)).setting).toContain('"socks5_proxy_level":"high"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('creates a KeyMan task channel through the existing key-market boundary', async () => {
    const originalFetch = globalThis.fetch;
    let usedQuota = 0;
    let expireSession = false;
    let refreshCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/system/auth/login')) return Response.json({ code: 0, data: { accessToken: 'access-token-fixture', refreshToken: 'refresh-token-fixture' } });
      if (url.pathname.endsWith('/system/auth/refresh-token')) {
        refreshCalls++;
        return Response.json({ code: 0, data: { accessToken: 'refreshed-access-token-fixture', refreshToken: 'refreshed-refresh-token-fixture' } });
      }
      if (expireSession && new Headers(init?.headers).get('Authorization') === 'Bearer access-token-fixture') return Response.json({ code: 401, msg: '登录已过期' });
      if (url.pathname.endsWith('/newapi/gateway/simple-list')) return Response.json({ code: 0, data: [{ id: 7, name: 'fixture gateway' }] });
      if (url.pathname.endsWith('/newapi/channel/groups')) return Response.json({ code: 0, data: ['default', 'supplier-east'] });
      if (url.pathname.endsWith('/newapi/channel/console-status')) return Response.json({ code: 0, data: { quota_per_unit: 500000 } });
      if (url.pathname.endsWith('/newapi/channel/page')) return Response.json({ code: 0, data: { list: [{ id: 12, name: 'fixture', status: 1, usedQuota, models: ['gpt-4o'] }], total: 1 } });
      if (url.pathname.endsWith('/newapi/channel/create')) return Response.json({ code: 0, data: { id: 12, name: 'fixture', status: 1, usedQuota: 0 } });
      if (url.pathname.endsWith('/newapi/channel/test')) return Response.json({ code: 0, data: { success: true } });
      return Response.json({ code: 0, data: {} });
    }) as typeof fetch;
    const db = await openTestDB();
    try {
      await migrate(db);
      await bootstrap(db, { ADMIN_EMAIL: 'keyman-owner@example.com', ADMIN_PASSWORD: 'keyman-owner-password' });
      const { app } = await createApp(db, { encryptionKey: 'cd'.repeat(32), appUrl: 'http://localhost:3000' });
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'keyman-owner@example.com', password: 'keyman-owner-password' }, headers: { 'x-ccmax-request': '1' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const request = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, 'x-ccmax-request': '1' } });
      const connection = await request('POST', '/api/new-api-connections', { name: 'keyman fixture', baseUrl: 'https://keyman.xkk.io', adapterType: 'keyman_newapi', authType: 'password', username: 'fixture', password: 'fixture', quotaPerUnit: 500000 });
      expect(connection.statusCode).toBe(200);
      const connectionId = connection.json().connection.id;
      const task = await request('POST', '/api/key-tasks', { connectionId, templateType: 'keyman_newapi', gatewayId: '7', name: 'KeyMan fixture task', resourceType: 'OpenAI', provider: 'OpenAI', models: ['gpt-4o'] });
      expect(task.statusCode).toBe(200);
      const taskId = task.json().task.id;
      expect((await request('PATCH', `/api/key-tasks/${taskId}`, { state: 'published' })).statusCode).toBe(200);
      const options = await request('GET', `/api/key-tasks/${taskId}/options`);
      expect(options.statusCode).toBe(200);
      expect(options.json().groups).toEqual(['default', 'supplier-east']);
      const channel = await request('POST', `/api/key-tasks/${taskId}/channels`, { secrets: ['sk-keyman-fixture'], idempotencyKey: id() });
      expect(channel.statusCode).toBe(200);
      expect(channel.json().channels).toHaveLength(1);
      expect(channel.json().channel.token_masked).not.toContain('sk-keyman-fixture');
      usedQuota = 500000;
      expireSession = true;
      expect((await request('POST', `/api/key-tasks/${taskId}/sync`, {})).statusCode).toBe(200);
      expect((await db.query('SELECT used_usd FROM task_channels'))[0].used_usd).toBe('1.00000000');
      const [stored] = await db.query('SELECT credentials FROM new_api_connections WHERE id=$1', [connectionId]);
      expect(stored.credentials).not.toContain('refreshed-access-token-fixture');
      expect(secretBox('cd'.repeat(32)).decrypt(stored.credentials)).toMatchObject({ token: 'refreshed-access-token-fixture', refreshToken: 'refreshed-refresh-token-fixture' });
      expect((await request('POST', `/api/key-tasks/${taskId}/sync`, {})).statusCode).toBe(200);
      expect(refreshCalls).toBe(1);
      await app.close();
    } finally {
      globalThis.fetch = originalFetch;
      await db.close();
    }
  });

  it('recovers a failed connection and gates task creation and publication on its connection and gateway', async () => {
    const originalFetch = globalThis.fetch;
    let loginCalls = 0;
    let gatewayAvailable = true;
    let denyGateway = false;
    let lastTenant = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/system/auth/login')) {
        loginCalls++;
        const body = JSON.parse(String(init?.body));
        if (body.captchaVerification === 'captcha-fixture') return Response.json({ code: 0, data: { accessToken: 'captcha-access-token-fixture' } });
        return Response.json({ code: 400, msg: '验证码不能为空', data: null });
      }
      if (url.pathname.endsWith('/newapi/gateway/simple-list')) {
        lastTenant = new Headers(init?.headers).get('tenant-id') || '';
        if (denyGateway) return Response.json({ code: 403, msg: '网关访问被拒绝' });
        return Response.json({ code: 0, data: gatewayAvailable ? [{ id: 7, name: 'fixture gateway' }] : [] });
      }
      return Response.json({ code: 0, data: [] });
    }) as typeof fetch;
    const db = await openTestDB();
    try {
      await migrate(db);
      await bootstrap(db, { ADMIN_EMAIL: 'keyman-captcha@example.com', ADMIN_PASSWORD: 'keyman-captcha-password' });
      const { app } = await createApp(db, { encryptionKey: 'ef'.repeat(32), appUrl: 'http://localhost:3000' });
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'keyman-captcha@example.com', password: 'keyman-captcha-password' }, headers: { 'x-ccmax-request': '1' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const request = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, 'x-ccmax-request': '1' } });
      const saved = await request('POST', '/api/new-api-connections', { name: 'KeyMan captcha fixture', baseUrl: 'https://keyman.xkk.io/#/newapi/channel', adapterType: 'keyman_newapi', authType: 'password', tenantId: '1', username: 'fixture', password: 'fixture', quotaPerUnit: 500000 });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().verified).toBe(false);
      expect(saved.json().connection.status).toBe('error');
      expect(saved.json().connection.base_url).toBe('https://kapi.xkk.io/admin-api');
      expect((await request('GET', '/api/new-api-connections')).json().connections).toHaveLength(1);
      const connectionId = saved.json().connection.id;
      const createTask = (gatewayId?: string) => request('POST', '/api/key-tasks', { connectionId, name: 'Recovered task', resourceType: 'OpenAI', provider: 'OpenAI', models: ['gpt-4o'], gatewayId });
      expect((await createTask('7')).statusCode).toBe(409);
      const renamed = await request('PATCH', `/api/new-api-connections/${connectionId}`, { name: 'Retry fixture' });
      expect(renamed.json().connection.last_error).toContain('验证码不能为空');
      const bypass = await request('PATCH', `/api/new-api-connections/${connectionId}`, { status: 'connected' });
      expect(bypass.json().verified).toBe(false);
      expect(bypass.json().connection.status).toBe('error');
      const recovered = await request('PATCH', `/api/new-api-connections/${connectionId}`, { baseUrl: 'https://keyman.xkk.io/#/newapi/channel', username: 'fixture', password: 'fixture', captchaVerification: 'captcha-fixture' });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toMatchObject({ verified: true, connection: { id: connectionId, status: 'connected', base_url: 'https://kapi.xkk.io/admin-api', last_error: null } });
      expect(recovered.json().connection.last_sync_at).toBeTruthy();
      expect(recovered.body).not.toContain('captcha-access-token-fixture');
      const loginCount = loginCalls;
      const tenantChange = await request('PATCH', `/api/new-api-connections/${connectionId}`, { tenantId: '2', quotaPerUnit: 1000000 });
      expect(tenantChange.statusCode).toBe(200);
      expect(lastTenant).toBe('2');
      expect(tenantChange.json().connection.quota_per_unit).toBe('1000000.00000000');
      expect(loginCalls).toBe(loginCount);
      expect((await createTask()).statusCode).toBe(400);
      expect((await createTask('missing')).statusCode).toBe(409);
      const task = await createTask('7');
      expect(task.statusCode).toBe(200);
      const taskId = task.json().task.id;
      await request('PATCH', `/api/new-api-connections/${connectionId}`, { status: 'disabled' });
      expect((await createTask('7')).statusCode).toBe(409);
      expect((await request('PATCH', `/api/key-tasks/${taskId}`, { state: 'published' })).statusCode).toBe(409);
      denyGateway = true;
      expect((await request('POST', `/api/new-api-connections/${connectionId}/test`, {})).statusCode).toBe(400);
      const failedEdit = await request('PATCH', `/api/new-api-connections/${connectionId}`, { quotaPerUnit: 500000 });
      expect(failedEdit.json()).toMatchObject({ verified: false, connection: { status: 'error', last_error: 'KeyMan：网关访问被拒绝' } });
      denyGateway = false;
      expect((await request('POST', `/api/new-api-connections/${connectionId}/test`, {})).statusCode).toBe(200);
      gatewayAvailable = false;
      expect((await request('PATCH', `/api/key-tasks/${taskId}`, { state: 'published' })).statusCode).toBe(409);
      expect((await request('GET', '/api/key-tasks')).json().tasks[0].state).toBe('draft');
      gatewayAvailable = true;
      expect((await request('PATCH', `/api/key-tasks/${taskId}`, { state: 'published' })).statusCode).toBe(200);
      await request('PATCH', `/api/new-api-connections/${connectionId}`, { status: 'disabled' });
      expect((await request('POST', `/api/key-tasks/${taskId}/channels`, { secret: 'sk-disabled-fixture' })).statusCode).toBe(409);
      expect((await request('POST', `/api/key-tasks/${taskId}/sync`, {})).statusCode).toBe(409);
      expect(await syncPublishedKeyTasks(db, secretBox('ef'.repeat(32)))).toEqual([]);
      expect((await request('GET', '/api/new-api-connections')).json().connections[0].status).toBe('disabled');
      expect((await request('POST', `/api/new-api-connections/${connectionId}/test`, {})).statusCode).toBe(200);
      expect((await request('PATCH', `/api/key-tasks/${taskId}`, { state: 'closed' })).statusCode).toBe(200);
      expect((await request('PATCH', `/api/key-tasks/${taskId}`, { state: 'published' })).statusCode).toBe(409);
      expect((await request('GET', '/api/new-api-connections')).json().connections).toHaveLength(1);
      expect(loginCalls).toBe(loginCount);
      await app.close();
    } finally {
      globalThis.fetch = originalFetch;
      await db.close();
    }
  });
});
