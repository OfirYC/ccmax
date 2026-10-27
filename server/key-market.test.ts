import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { bootstrap, hashPassword, id, today } from './core.js';
import { migrate } from './db.js';
import { openTestDB } from './test-db.js';

describe('Key supply workspace', () => {
  afterEach(() => vi.restoreAllMocks());

  it('isolates workspace data and settles New API deltas exactly once', async () => {
    const db = await openTestDB();
    const originalFetch = globalThis.fetch;
    let usedQuota = 500000;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/user/login') return Response.json({ success: true }, { headers: { 'set-cookie': 'session=fixture; Path=/' } });
      if (url.pathname === '/api/status') return Response.json({ data: { quota_per_unit: 500000 } });
      if (url.pathname === '/api/channel/' && (init?.method || 'GET') === 'GET') return Response.json({ data: [{ id: 7, name: 'fixture', models: 'claude-opus-5', status: 1, used_quota: usedQuota }] });
      if (url.pathname === '/api/channel/' && init?.method === 'POST') return Response.json({ data: { id: 7, name: 'fixture', models: ['claude-opus-5'], status: 1, used_quota: 0 } });
      if (url.pathname.startsWith('/api/channel/update_balance/')) return Response.json({ success: true });
      if (url.pathname.startsWith('/api/channel/test/')) return Response.json({ success: true });
      if (url.pathname.endsWith('/status')) return Response.json({ success: true });
      return Response.json({ success: true });
    }) as typeof fetch;
    try {
      await migrate(db);
      await bootstrap(db, { ADMIN_EMAIL: 'key-owner@example.com', ADMIN_PASSWORD: 'key-owner-password' });
      const [owner] = await db.query('SELECT * FROM users WHERE role=\'owner\'');
      const agentId = id();
      await db.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$4,$5)', [agentId, owner.id, 'key-agent@example.com', 'Key Agent', await hashPassword('key-agent-password')]);
      const unpricedId = id();
      await db.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$4,$5)', [unpricedId, owner.id, 'key-unpriced@example.com', 'Unpriced Agent', await hashPassword('key-unpriced-password')]);
      const { app } = await createApp(db, { encryptionKey: 'ab'.repeat(32), appUrl: 'http://localhost:3000' });
      const request = (method: string, url: string, payload: unknown, cookie: string): Promise<any> => app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, 'x-ccmax-request': '1' } }) as any;
      const login = async (email: string, password: string) => {
        const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: { 'x-ccmax-request': '1' } });
        expect(response.statusCode).toBe(200);
        return String(response.headers['set-cookie']).split(';')[0];
      };
      const ownerCookie = await login('key-owner@example.com', 'key-owner-password');
      const agentCookie = await login('key-agent@example.com', 'key-agent-password');
      const unpricedCookie = await login('key-unpriced@example.com', 'key-unpriced-password');
      const connectionResponse = await request('POST', '/api/new-api-connections', { name: 'fixture', baseUrl: 'https://new-api.example.com', authType: 'password', username: 'admin', password: 'secret' }, ownerCookie);
      expect(connectionResponse.statusCode).toBe(200);
      const connectionId = connectionResponse.json().connection.id;
      const taskResponse = await request('POST', '/api/key-tasks', { connectionId, name: 'Claude fixture task', resourceType: 'Anthropic', provider: 'Anthropic', models: ['claude-opus-5'], rootRate: 1 }, ownerCookie);
      expect(taskResponse.statusCode).toBe(200);
      const taskId = taskResponse.json().task.id;
      expect((await request('PATCH', `/api/key-tasks/${taskId}`, { state: 'published' }, ownerCookie)).statusCode).toBe(200);
      const rateResponse = await request('POST', `/api/key-tasks/${taskId}/rates`, { userId: agentId, rate: 0.8 }, ownerCookie);
      expect(rateResponse.statusCode).toBe(200);
      expect(rateResponse.json().effectiveDate).toBe(today());
      const unpricedTasks = await request('GET', '/api/key-tasks', undefined, unpricedCookie);
      expect(unpricedTasks.statusCode).toBe(200);
      expect(unpricedTasks.json().tasks[0].rate).toBeNull();
      expect((await request('POST', `/api/key-tasks/${taskId}/channels`, { secret: 'sk-unpriced-secret', idempotencyKey: id() }, unpricedCookie)).statusCode).toBe(403);
      const submissionKey = id();
      const submitted = await request('POST', `/api/key-tasks/${taskId}/channels`, { secret: 'sk-fixture-secret', name: 'Agent key', idempotencyKey: submissionKey }, agentCookie);
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json().channel.token_masked).toContain('****');
      expect(submitted.json().channel.token_masked).not.toContain('sk-fixture-secret');
      const retried = await request('POST', `/api/key-tasks/${taskId}/channels`, { secret: 'sk-fixture-secret', name: 'Agent key', idempotencyKey: submissionKey }, agentCookie);
      expect(retried.statusCode).toBe(200);
      expect(await db.query('SELECT id FROM task_channels')).toHaveLength(1);
      expect((await request('POST', `/api/key-tasks/${taskId}/sync`, {}, ownerCookie)).statusCode).toBe(200);
      expect((await db.query('SELECT kind,amount_usd FROM ledger WHERE kind=\'task_settlement\'')).map(row => [row.kind, row.amount_usd]).sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([
        ['task_settlement', '0.20000000'], ['task_settlement', '0.80000000'],
      ]);
      await request('POST', `/api/key-tasks/${taskId}/sync`, {}, ownerCookie);
      expect(await db.query('SELECT * FROM task_settlement_entries')).toHaveLength(2);
      const ownerTasks = await request('GET', '/api/key-tasks', undefined, ownerCookie);
      expect(ownerTasks.json().tasks[0].profit_usd).toBe('0.20000000');
      const agentTasks = await request('GET', '/api/key-tasks', undefined, agentCookie);
      expect(agentTasks.json().tasks[0].profit_usd).toBe('0.80000000');
      const keyFinance = await request('GET', '/api/finance?source=key', undefined, agentCookie);
      expect(keyFinance.statusCode).toBe(200);
      expect(keyFinance.json().ledger).toHaveLength(1);
      usedQuota = 250000;
      await request('POST', `/api/key-tasks/${taskId}/sync`, {}, ownerCookie);
      expect(await db.query("SELECT kind FROM task_settlement_entries WHERE kind='task_adjustment'" )).toHaveLength(2);
      expect((await app.inject({ url: '/api/finance/check', headers: { cookie: agentCookie } })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/key-settlements', headers: { cookie: agentCookie } })).json().rows[0].kind).toBe('task_adjustment');
      expect((await app.inject({ url: '/api/workspaces', headers: { cookie: agentCookie } })).json().workspaces).toHaveLength(2);
      await app.close();
    } finally {
      globalThis.fetch = originalFetch;
      await db.close();
    }
  });
});
