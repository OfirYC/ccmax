import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDB, migrate, type DB } from './db.js';
import { bootstrap, id, today } from './core.js';
import { createApp } from './app.js';
import { ingestUsage, requestWithdrawal, balance } from './billing.js';
import type { FastifyInstance } from 'fastify';

const key = '11'.repeat(32);

describe('CCMAX authorization and ledger safeguards', () => {
  let db: DB;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = await openDB();
    await migrate(db);
    await bootstrap(db, { ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'correct horse battery staple' });
    ({ app } = await createApp(db, { encryptionKey: key, appUrl: 'http://localhost:3000' }));
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function login(email: string, password: string) {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'x-ccmax-request': '1' },
      payload: { email, password },
    });
    expect(response.statusCode).toBe(200);
    const cookie = response.headers['set-cookie'];
    return Array.isArray(cookie) ? cookie[0].split(';')[0] : String(cookie).split(';')[0];
  }

  async function api(cookie: string, method: string, url: string, payload?: any): Promise<any> {
    return app.inject({
      method, url,
      headers: { cookie, 'x-ccmax-request': '1' },
      payload,
    });
  }

  it('keeps sibling teams isolated while allowing the owner to see the full tree', async () => {
    const ownerCookie = await login('owner@example.com', 'correct horse battery staple');
    const a = await api(ownerCookie, 'POST', '/api/team', {
      name: 'Team A', email: 'a@example.com', password: 'team-a-password-123', rates: { gatelink: 0.4, ai008: 0.4 },
    });
    const b = await api(ownerCookie, 'POST', '/api/team', {
      name: 'Team B', email: 'b@example.com', password: 'team-b-password-123', rates: { gatelink: 0.4, ai008: 0.4 },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const aId = a.json().user.id;
    const bId = b.json().user.id;
    const bCookie = await login('b@example.com', 'team-b-password-123');
    const bAccount = await api(bCookie, 'POST', '/api/accounts', { email: 'b-claude@example.com', label: 'B' });
    expect(bAccount.statusCode).toBe(200);

    const aCookie = await login('a@example.com', 'team-a-password-123');
    const accounts = await api(aCookie, 'GET', '/api/accounts');
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json().accounts).toHaveLength(0);
    expect((await api(aCookie, 'PATCH', `/api/team/${bId}`, { active: false })).statusCode).toBe(403);
    expect((await api(aCookie, 'PUT', `/api/team/${bId}/rates`, { provider: 'ai008', rate: 0.1 })).statusCode).toBe(403);

    const ownerAccounts = await api(ownerCookie, 'GET', '/api/accounts');
    expect(ownerAccounts.json().accounts.map((account: any) => account.email)).toContain('b-claude@example.com');
    expect(aId).toMatch(/[0-9a-f-]{36}/);
  });

  it('serializes concurrent withdrawals so available balance cannot be overspent', async () => {
    const [owner] = await db.query('SELECT * FROM users WHERE role=\'owner\'');
    const agentId = id();
    await db.query(`INSERT INTO users(id,parent_id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5,'agent')`, [agentId, owner.id, 'ledger@example.com', 'Ledger', 'x']);
    await db.query(`INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'settlement','100.00000000','invoice-ledger-test')`, [id(), agentId]);
    const [agent] = await db.query('SELECT * FROM users WHERE id=$1', [agentId]);

    const results = await Promise.allSettled([
      requestWithdrawal(db, agent, '80', 'test', 'destination-one'),
      requestWithdrawal(db, agent, '80', 'test', 'destination-two'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const current = await balance(db, agentId);
    expect(current.available).toBe('20.00000000');
    expect(current.pending).toBe('80.00000000');
  });

  it('uses the payout rate effective on the usage date for historical imports', async () => {
    const [owner] = await db.query('SELECT * FROM users WHERE role=\'owner\'');
    const connectionId = id(), accountId = id(), bindingId = id();
    await db.query(`INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','AI008','encrypted',0.4)`, [connectionId]);
    await db.query(`INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,0.4,'1970-01-01',$3),($4,$2,0.2,$5,$3)`, [id(), connectionId, owner.id, id(), today()]);
    await db.query(`INSERT INTO accounts(id,owner_id,email) VALUES($1,$2,'historical@example.com')`, [accountId, owner.id]);
    await db.query(`INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,'historical-remote')`, [bindingId, accountId, connectionId]);
    const previousDay = new Date(Date.parse(`${today()}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    await ingestUsage(db, { bindingId, day: previousDay, rawUsd: '100', final: true, source: 'test' });
    const [usage] = await db.query('SELECT root_rate FROM usage_days WHERE binding_id=$1', [bindingId]);
    expect(usage.root_rate).toBe('0.4000');
  });
});
