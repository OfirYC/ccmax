import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createApp } from './app.js';
import { migrate, type DB } from './db.js';
import { bootstrap, id, nextDay, today, secretBox } from './core.js';
import { createInvoice, confirmInvoice, ingestUsage } from './billing.js';
import { openTestDB } from './test-db.js';

describe('hard ceilings for hierarchical settlement rates', () => {
  let db: DB, app: FastifyInstance, owner: any, a: any, b: any, connectionId: string;
  let ownerCookie: string, aCookie: string, bCookie: string;
  const password = 'pricing-test-password';
  const prior = (n = 1) => new Date(Date.parse(today() + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
  async function request(cookie: string, method: string, url: string, payload?: any) {
    return app.inject({ method, url, headers: { cookie, 'x-ccmax-request': '1' }, payload } as InjectOptions);
  }
  async function login(email: string) {
    const response = await request('', 'POST', '/api/auth/login', { email, password });
    expect(response.statusCode).toBe(200); return String(response.headers['set-cookie']).split(';')[0];
  }
  const child = (email: string, rates: any, effectiveFrom = '1970-01-01') => ({ name: email, email, password, rates, effectiveFrom });
  async function change(cookie: string, user: any, rate: number, provider = 'ai008') {
    return request(cookie, 'PUT', `/api/team/${user.id}/rates`, { provider, rate });
  }
  async function price(userId: string, rate: number, date: string, provider = 'ai008') {
    await db.query(`INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(user_id,provider,effective_date) DO UPDATE SET rate=EXCLUDED.rate`, [id(), userId, provider, rate, date, owner.id]);
  }
  beforeEach(async () => {
    db = await openTestDB(); await migrate(db);
    await bootstrap(db, { ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: password });
    [owner] = await db.query("SELECT * FROM users WHERE role='owner'");
    [a] = await db.query("INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,'a@example.com','A',$3) RETURNING *", [id(), owner.id, owner.password_hash]);
    [b] = await db.query("INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,'b@example.com','B',$3) RETURNING *", [id(), a.id, owner.password_hash]);
    await price(a.id, 0.2, '1970-01-01'); await price(b.id, 0.1, '1970-01-01');
    await price(a.id, 0.4, '1970-01-01', 'gatelink'); await price(b.id, 0.3, '1970-01-01', 'gatelink');
    connectionId = id();
    await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','Fixture',$2,0.5)", [connectionId, secretBox('ab'.repeat(32)).encrypt({ username: 'fixture', password: 'fixture' })]);
    await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,0.5,'1970-01-01')", [id(), connectionId]);
    ({ app } = await createApp(db, { encryptionKey: 'ab'.repeat(32), appUrl: 'http://localhost:3000' }));
    ownerCookie = await login(owner.email); aCookie = await login(a.email); bCookie = await login(b.email);
  });
  afterEach(async () => { await app.close(); await db.close(); });

  it('reproduces 0.2 → 0.1 and rejects a higher grandchild quote, while allowing equal and lower rates', async () => {
    const denied = await request(bCookie, 'POST', '/api/team', child('too-high@example.com', { ai008: 0.1001 }));
    expect(denied.statusCode).toBe(400); expect(denied.json().code).toBe('RATE_CAP_EXCEEDED');
    expect(await db.query("SELECT id FROM users WHERE email='too-high@example.com'")).toHaveLength(0);
    for (const rate of [0.1, 0.05]) expect((await request(bCookie, 'POST', '/api/team', child(`allowed-${rate}@example.com`, { ai008: rate }))).statusCode).toBe(200);
    const team = (await request(bCookie, 'GET', '/api/team')).json();
    expect(team.pricing.limits.ai008).toEqual({ create: '0.1000', change: '0.1000' });
    expect(team.pricing.issues).toEqual([]);
  });

  it('enforces the same ceiling for API-key requests and subsequent price updates', async () => {
    const created = await request(bCookie, 'POST', '/api/team', child('priced@example.com', { ai008: 0.05 }));
    const user = created.json().user;
    expect((await change(bCookie, user, 0.1001)).json().code).toBe('RATE_CAP_EXCEEDED');
    expect((await change(bCookie, user, 0.1)).statusCode).toBe(200);
    const issued = await request(bCookie, 'POST', '/api/settings/api-keys', { name: 'Pricing API', scopes: ['read', 'team:write'], currentPassword: password, expiresInDays: 30 });
    const token = issued.json().token;
    const api = await app.inject({ method: 'POST', url: '/api/team', headers: { authorization: `Bearer ${token}` }, payload: child('api-high@example.com', { ai008: 0.2 }) });
    expect(api.statusCode).toBe(400); expect(api.json().code).toBe('RATE_CAP_EXCEEDED');
    expect((await db.query('SELECT rate FROM rates WHERE user_id=$1 AND effective_date=$2', [user.id, nextDay()]))[0].rate).toBe('0.1000');
  });

  it('handles zero, missing platform prices and per-platform limits without partial user creation', async () => {
    await price(b.id, 0, '1970-01-01', 'gatelink');
    expect((await request(bCookie, 'POST', '/api/team', child('zero@example.com', { gatelink: 0 }))).statusCode).toBe(200);
    expect((await request(bCookie, 'POST', '/api/team', child('nonzero@example.com', { gatelink: 0.0001 }))).json().code).toBe('RATE_CAP_EXCEEDED');
    expect((await request(bCookie, 'POST', '/api/team', child('unpriced@example.com', { minicc: 0 }))).json().code).toBe('UPSTREAM_RATE_MISSING');
    const mixed = await request(bCookie, 'POST', '/api/team', child('mixed@example.com', { ai008: 0.05, minicc: 0.1 }));
    expect(mixed.statusCode).toBe(400);
    expect(await db.query("SELECT id FROM users WHERE email='mixed@example.com'")).toHaveLength(0);
    await price(b.id, 0.3, '1970-01-01', 'gatelink');
    expect((await request(bCookie, 'POST', '/api/team', child('separate@example.com', { gatelink: 0.25 }))).statusCode).toBe(200);
    expect((await request(bCookie, 'POST', '/api/team', child('wrong-platform@example.com', { ai008: 0.25 }))).statusCode).toBe(400);
  });

  it('blocks upstream reductions below downstream commitments and permits a valid coordinated next-day reduction', async () => {
    const failed = await change(ownerCookie, a, 0.08);
    expect(failed.statusCode).toBe(400); expect(failed.json().code).toBe('RATE_FLOOR_VIOLATION');
    expect(await db.query('SELECT id FROM rates WHERE user_id=$1 AND effective_date=$2', [a.id, nextDay()])).toHaveLength(0);
    expect((await change(aCookie, b, 0.07)).statusCode).toBe(200);
    expect((await change(ownerCookie, a, 0.08)).statusCode).toBe(200);
    expect((await request(bCookie, 'POST', '/api/team', child('future-high@example.com', { ai008: 0.075 }))).json().code).toBe('RATE_CAP_EXCEEDED');
    expect((await request(bCookie, 'POST', '/api/team', child('future-equal@example.com', { ai008: 0.07 }))).statusCode).toBe(200);
    const pricing = (await request(bCookie, 'GET', '/api/team')).json().pricing;
    expect(pricing.limits.ai008).toEqual({ create: '0.0700', change: '0.0700' });
    expect((await db.query("SELECT rate FROM rates WHERE user_id=$1 AND effective_date='1970-01-01'", [a.id]))[0].rate).toBe('0.2000');
  });

  it('checks historical start dates and every future boundary across the effective quote interval', async () => {
    await price(b.id, 0.05, '1970-01-01'); await price(b.id, 0.1, today());
    expect((await request(bCookie, 'POST', '/api/team', child('backdated@example.com', { ai008: 0.08 }, prior(2)))).json().code).toBe('RATE_CAP_EXCEEDED');
    const day3 = nextDay(nextDay(nextDay())), day2 = nextDay(nextDay());
    const created = await request(bCookie, 'POST', '/api/team', child('interval@example.com', { ai008: 0.05 }, today()));
    const user = created.json().user;
    await price(b.id, 0.04, day3); await price(user.id, 0.04, day2);
    // This quote ends on day 2, before its parent drops to 0.04 on day 3.
    expect((await change(bCookie, user, 0.06)).statusCode).toBe(200);
    expect((await request(bCookie, 'POST', '/api/team', child('open-ended@example.com', { ai008: 0.06 }, today()))).statusCode).toBe(400);
  });

  it('uses the price on the change date, allowing an increase already scheduled for tomorrow', async () => {
    const created = await request(bCookie, 'POST', '/api/team', child('increasing@example.com', { ai008: 0.05 }));
    expect((await change(aCookie, b, 0.15)).statusCode).toBe(200);
    expect((await change(bCookie, created.json().user, 0.15)).statusCode).toBe(200);
    expect((await request(bCookie, 'POST', '/api/team', child('too-early@example.com', { ai008: 0.15 }, today()))).statusCode).toBe(400);
    expect((await request(bCookie, 'GET', '/api/team')).json().pricing.limits.ai008).toEqual({ create: '0.1000', change: '0.1500' });
  });

  it('applies root ceilings to all connections of a platform and rejects invalid upstream changes', async () => {
    const lower = await request(ownerCookie, 'PATCH', `/api/connections/${connectionId}`, { payoutRate: 0.15 });
    expect(lower.statusCode).toBe(400); expect(lower.json().code).toBe('RATE_FLOOR_VIOLATION');
    const config = { provider: 'ai008', name: 'Second fixture', username: 'fixture', password: 'fixture', effectiveFrom: '1970-01-01' };
    expect((await request(ownerCookie, 'POST', '/api/connections', { ...config, payoutRate: 0.15 })).statusCode).toBe(400);
    expect((await request(ownerCookie, 'POST', '/api/connections', { ...config, payoutRate: 0.3 })).statusCode).toBe(200);
    expect((await request(ownerCookie, 'POST', '/api/team', child('root-high@example.com', { ai008: 0.35 }))).json().code).toBe('RATE_CAP_EXCEEDED');
    expect((await request(ownerCookie, 'POST', '/api/team', child('root-equal@example.com', { ai008: 0.3 }))).statusCode).toBe(200);
  });

  it('serializes concurrent child creation and parent reductions so they cannot both violate the cap', async () => {
    await price(b.id, 0.05, '1970-01-01');
    const results = await Promise.all([
      change(ownerCookie, a, 0.1),
      request(aCookie, 'POST', '/api/team', child('concurrent@example.com', { ai008: 0.15 }, today())),
    ]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 400]);
    expect((await request(ownerCookie, 'GET', '/api/team')).json().pricing.issues).toEqual([]);
  });

  it('detects legacy inversions and prevents them from entering usage, invoices or a new ledger credit', async () => {
    await price(b.id, 0.3, '1970-01-01');
    const accountId = id(), bindingId = id();
    await db.query("INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,'legacy@example.com',true)", [accountId, b.id]);
    await db.query("INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,'legacy')", [bindingId, accountId, connectionId]);
    await expect(db.transaction(tx => ingestUsage(tx, { bindingId, day: prior(), rawUsd: '100', final: true, source: 'test' }))).rejects.toMatchObject({ code: 'RATE_HIERARCHY_CONFLICT' });
    expect(await db.query('SELECT id FROM usage_days')).toHaveLength(0);
    const issues = (await request(ownerCookie, 'GET', '/api/team')).json().pricing.issues;
    expect(issues).toContainEqual({ userId: b.id, provider: 'ai008', effectiveDate: today() });

    // A legacy sealed bill must be reviewed, even when this user's own margin
    // is positive and the inverted edge belongs to a lower level.
    const usageId = id(), earningId = id();
    await db.query("INSERT INTO usage_days(id,binding_id,day,raw_usd,state,source,root_rate) VALUES($1,$2,$3,100,'final','legacy',0.5)", [usageId, bindingId, prior()]);
    for (const [userId, rate, downstream, profit, eid] of [[owner.id, 0.5, 0.2, 30, earningId], [a.id, 0.2, 0.3, -10, id()], [b.id, 0.3, 0, 30, id()]]) {
      await db.query('INSERT INTO earnings(id,usage_id,user_id,rate,downstream_rate,gross_usd,downstream_usd,profit_usd) VALUES($1,$2,$3,$4,$5,$4::numeric*100,$5::numeric*100,$6)', [eid, usageId, userId, rate, downstream, profit]);
    }
    await expect(createInvoice(db, owner, owner.id, prior(), prior())).rejects.toMatchObject({ code: 'RATE_HIERARCHY_CONFLICT' });
    const invoiceId = id();
    await db.query("INSERT INTO invoices(id,number,user_id,date_from,date_to,gross_usd,downstream_usd,profit_usd,created_by) VALUES($1,'legacy-pending',$2,$3,$3,50,20,30,$2)", [invoiceId, owner.id, prior()]);
    await db.query('INSERT INTO invoice_items(earning_id,invoice_id) VALUES($1,$2)', [earningId, invoiceId]);
    await expect(confirmInvoice(db, owner, invoiceId, 'must-review')).rejects.toMatchObject({ code: 'RATE_HIERARCHY_CONFLICT' });
    expect(await db.query('SELECT id FROM ledger')).toHaveLength(0);
    expect((await db.query('SELECT profit_usd FROM earnings WHERE user_id=$1', [a.id]))[0].profit_usd).toBe('-10.00000000');
  });
});
