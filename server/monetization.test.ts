import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bestQuote, calculateQuotedEarnings } from '../shared/monetization.js';
import { accountEarnings } from './monetization.js';
import { bootstrap, hashPassword, id, today } from './core.js';
import { migrate, type DB } from './db.js';
import { openTestDB } from './test-db.js';
import { confirmInvoice, createInvoice, ingestUsage } from './billing.js';
import { createApp } from './app.js';
import { historicalWeeklyRecord, weeklyRecordReader } from './weekly-record.js';

const input = { weeklyBillableUsd: '1000', monthlyBillableUsd: '1234.56', rate: '0.1234', subscriptionUsd: '200', monthlyProxyUsd: '15' };
describe('quote conversion without assumed quotas', () => {
  it('calculates independent measured periods with decimal arithmetic and explicit costs', () => {
    expect(calculateQuotedEarnings(input)).toEqual({ week: '123.40', month: '152.34', monthAfterCosts: '-62.66' });
    expect(calculateQuotedEarnings({ ...input, weeklyBillableUsd: '0' })).toMatchObject({ week: '0.00', month: '152.34' });
    expect(calculateQuotedEarnings({ ...input, monthlyBillableUsd: '' })).toMatchObject({ week: '123.40', month: null, monthAfterCosts: null });
    expect(calculateQuotedEarnings({ ...input, subscriptionUsd: '' })).toMatchObject({ month: '152.34', monthAfterCosts: null });
    expect(calculateQuotedEarnings({ ...input, rate: '0' })).toEqual({ week: '0.00', month: '0.00', monthAfterCosts: '-215.00' });
  });
  it('keeps unavailable and zero quotes distinct and refuses invalid numbers', () => {
    expect(bestQuote({ ai008: '0.2', minicc: '0.1', gatelink: null })).toEqual({ provider: 'ai008', rate: '0.2' });
    expect(bestQuote({ minicc: 0, ai008: null })).toEqual({ provider: 'minicc', rate: '0' });
    expect(bestQuote({ ai008: null, minicc: '', other: -1, x: Infinity })).toBeNull();
    for (const value of ['', '-1', 'NaN', 'Infinity', '1e10', '10000000000000000']) {
      expect(calculateQuotedEarnings({ ...input, weeklyBillableUsd: value })?.week).toBeNull();
      expect(calculateQuotedEarnings({ ...input, monthlyProxyUsd: value })?.monthAfterCosts).toBeNull();
    }
    expect(calculateQuotedEarnings({ ...input, rate: '1.1' })).toBeNull();
  });
});

describe('actual personal account earnings', () => {
  let db: DB, app: FastifyInstance, owner: any, agent: string, leaf: string, sibling: string, connection: string, account: string, binding: string;
  const password = 'earnings-test-password', headers = { 'x-ccmax-request': '1' };
  const day = (days: number) => new Date(Date.parse(today() + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
  async function addAccount(user: string, verified = true) {
    const aid = id(), bid = id();
    await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,$4)', [aid, user, aid + '@example.com', verified]);
    await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)', [bid, aid, connection]);
    return { aid, bid };
  }
  const bill = (bid: string, days: number, rawUsd: string, source = 'verified-test', final = true) => db.transaction(tx => ingestUsage(tx, { bindingId: bid, day: day(days), rawUsd, source, final }));
  beforeEach(async () => {
    db = await openTestDB(); await migrate(db); await bootstrap(db, { ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: password });
    [owner] = await db.query("SELECT * FROM users WHERE role='owner'"); agent = id(); leaf = id(); sibling = id();
    const hash = await hashPassword(password);
    for (const [uid, parent] of [[agent, owner.id], [leaf, agent], [sibling, owner.id]]) {
      await db.query('INSERT INTO users(id,parent_id,name,email,password_hash) VALUES($1,$2,$1,$3,$4)', [uid, parent, uid + '@example.com', hash]);
      await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'ai008',0.2,'1970-01-01',$3)", [id(), uid, parent]);
    }
    connection = id(); await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','private-master','private',0.5)", [connection]);
    await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,0.5,'1970-01-01')", [id(), connection]);
    ({ aid: account, bid: binding } = await addAccount(agent));
    ({ app } = await createApp(db, { encryptionKey: 'ab'.repeat(32), appUrl: 'http://localhost:3000' }));
  });
  afterEach(async () => { await app.close(); await db.close(); });
  it('uses frozen daily prices, excludes snapshots and provisional rows, and does not invent a full month', async () => {
    for (let n = 1; n <= 7; n++) await bill(binding, n, '10');
    await bill(binding, 8, '999', 'daily_snapshot'); await bill(binding, 9, '500', 'live_snapshot', false); await bill(binding, 10, '0');
    await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'ai008',0.1,$3,$4)", [id(), agent, today(), owner.id]);
    const result = await accountEarnings(db, agent), row = result.accounts.find(a => a.id === account);
    expect(row.periods['7d']).toMatchObject({ from: day(7), to: day(1), expectedBindingDays: 7, verifiedBindingDays: 7, complete: true, rawUsd: '70.00000000', grossUsd: '14.00000000', confirmedProfitUsd: '0.00000000' });
    expect(row.periods['30d']).toMatchObject({ expectedBindingDays: 30, verifiedBindingDays: 8, complete: false, snapshotBindingDays: 1, provisionalBindingDays: 1, grossUsd: '14.00000000' });
    const rootInvoice = await createInvoice(db, owner, owner.id, day(30), day(1)); await confirmInvoice(db, owner, rootInvoice.id, 'verified receipt');
    const invoice = await createInvoice(db, owner, agent, day(30), day(1)); await confirmInvoice(db, owner, invoice.id, 'verified receipt');
    expect((await accountEarnings(db, agent)).accounts[0].periods['30d'].confirmedProfitUsd).toBe('14.00000000');
  });
  it('distinguishes genuine zero from missing data and counts coverage of every account channel', async () => {
    for (let n = 1; n <= 7; n++) await bill(binding, n, '0');
    expect((await accountEarnings(db, agent)).accounts[0].periods['7d']).toMatchObject({ complete: true, grossUsd: '0.00000000' });
    const extra = id(); await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','second','private',0.5)", [extra]);
    await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)', [id(), account, extra]);
    const missing = await addAccount(agent);
    const result = await accountEarnings(db, agent);
    expect(result.accounts.find(a => a.id === account).periods['7d']).toMatchObject({ expectedBindingDays: 14, verifiedBindingDays: 7, complete: false });
    expect(result.accounts.find(a => a.id === missing.aid).periods['7d']).toMatchObject({ complete: false, grossUsd: null, confirmedProfitUsd: null });
  });
  it('requires login and isolates personal records from children, siblings and unverified accounts', async () => {
    await bill(binding, 1, '1');
    for (const uid of [leaf, sibling]) { const a = await addAccount(uid); await bill(a.bid, 1, '99999'); }
    await addAccount(agent, false);
    expect((await app.inject({ url: '/api/monetization' })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { email: agent + '@example.com', password } });
    const response = await app.inject({ url: '/api/monetization', headers: { cookie: String(login.headers['set-cookie']).split(';')[0] } });
    expect(response.statusCode).toBe(200); expect(response.json().accounts.map((a: any) => a.id)).toEqual([account]);
    expect(response.body).not.toMatch(/private-master|private|99999/);
    expect((await accountEarnings(db, owner.id)).accounts).toEqual([]);
  });
  it('finds the historical best consecutive week for one account at its recorded prices, without adding accounts or projecting partial weeks', async () => {
    const other = await addAccount(sibling), child = await addAccount(leaf);
    for (let n = 10; n <= 16; n++) {
      await bill(binding, n, '10'); await bill(other.bid, n, '20'); await bill(child.bid, n, '15');
    }
    for (let n = 1; n <= 6; n++) await bill(binding, n, '10000');
    await bill(binding, 0, '99999', 'live_snapshot', false);
    await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'ai008',0.01,$3,$4)", [id(), sibling, today(), owner.id]);
    expect(await historicalWeeklyRecord(db)).toEqual({ asOf: today(), days: 7, record: { from: day(16), to: day(10), receivableUsd: '28.00000000' } });
  });
  it('excludes estimated, provisional and unverified account records from a complete historical week', async () => {
    const provisional = await addAccount(sibling), unverified = await addAccount(leaf, false);
    for (let n = 1; n <= 7; n++) {
      await bill(binding, n, '1000', n === 4 ? 'daily_snapshot' : 'verified-test');
      await bill(provisional.bid, n, '2000', 'verified-test', n !== 3);
      await bill(unverified.bid, n, '9999', 'live_snapshot', false);
    }
    expect((await historicalWeeklyRecord(db)).record).toBeNull();
  });
  it('retains a real zero week and requires verified daily bills for every channel of the account', async () => {
    for (let n = 1; n <= 7; n++) await bill(binding, n, '0');
    expect((await historicalWeeklyRecord(db)).record).toEqual({ from: day(7), to: day(1), receivableUsd: '0.00000000' });
    const extra = id(); await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','second','private',0.5)", [extra]);
    const secondBinding = id();
    await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,0.5,'1970-01-01')", [id(), extra]);
    await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)', [secondBinding, account, extra]);
    expect((await historicalWeeklyRecord(db)).record).toBeNull();
    for (let n = 1; n <= 7; n++) await bill(secondBinding, n, '10');
    expect((await historicalWeeklyRecord(db)).record?.receivableUsd).toBe('14.00000000');
  });
  it('publishes only an anonymous aggregate on the exact read-only marketing route and shares its cached query', async () => {
    for (let n = 1; n <= 7; n++) await bill(binding, n, '10');
    const response = await app.inject({ url: '/api/marketing/weekly-record' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ asOf: today(), days: 7, record: { from: day(7), to: day(1), receivableUsd: '14.00000000' } });
    expect(response.body).not.toMatch(/email|account_id|owner_id|user_id|private|rate/);
    expect((await app.inject({ method: 'HEAD', url: '/api/marketing/weekly-record' })).statusCode).toBe(200);
    for (const url of ['/api/marketing/weekly-record/other', '/api/marketing', '/api/monetization']) {
      expect((await app.inject({ url })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/api/marketing/weekly-record', headers, payload: {} })).statusCode).toBe(401);
    let queries = 0;
    const read = weeklyRecordReader({ ...db, async query(sql, params) { queries++; return db.query(sql, params); } });
    await Promise.all([read(), read(), read()]); await read();
    expect(queries).toBe(1);
  });
});
