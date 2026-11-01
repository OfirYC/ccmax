import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { migrate, type DB, type Row } from './db.js';
import { bootstrap, id, MAX_USD, secretBox, today } from './core.js';
import { balance, confirmInvoice, createInvoice, ingestUsage, requestWithdrawal, reviewWithdrawal, settlementFunds } from './billing.js';
import { assertWalletAccounting } from './financial-integrity.js';
import { auditFinance } from './finance-audit.js';
import { previewInvoice } from './invoice-preview.js';
import { createApp } from './app.js';
import { openTestDB, seedSettlement } from './test-db.js';

const scale = 100000000n;
const atoms = (value: string) => { const [integer, fraction = ''] = value.split('.'); return BigInt(integer) * scale + BigInt(fraction.padEnd(8, '0')); };
const dollars = (value: bigint) => `${value / scale}.${(value % scale).toString().padStart(8, '0')}`;
// Independent integer arithmetic, rather than the production Decimal helpers.
const receivable = (raw: string, basisPoints: number) => (atoms(raw) * BigInt(basisPoints) + 5000n) / 10000n;
const prior = (n = 1) => new Date(Date.parse(today() + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);

describe('financial source reconciliation and complete agent cash flow', () => {
  let db: DB, app: FastifyInstance, owner: Row, a: Row, b: Row, c: Row, sibling: Row;
  let connections: Record<string, string>;
  const box = secretBox('ab'.repeat(32)), password = 'finance-test-password';
  async function user(parent: Row, name: string, rate: number) {
    const [user] = await db.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING *', [id(), parent.id, `${name}@finance.example`, name, parent.password_hash]);
    for (const provider of ['ai008', 'gatelink', 'minicc', 'maxchat']) await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,'1970-01-01',$5)", [id(), user.id, provider, rate, parent.id]);
    return user;
  }
  async function binding(user = c, provider = 'ai008') {
    const accountId = id(), bindingId = id();
    await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,true)', [accountId, user.id, `${accountId}@finance.example`]);
    await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)', [bindingId, accountId, connections[provider]]);
    return bindingId;
  }
  const observe = (bindingId: string, rawUsd = '100', day = prior()) => db.transaction(tx => ingestUsage(tx, { bindingId, day, rawUsd, final: true, source: 'verified-finance-fixture' }));
  const withdraw = (user: Row, amount: string, key = id()) => requestWithdrawal(db, user, amount, 'Binance ID', 'test destination', key, box);
  const audit = () => db.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');return auditFinance(tx);});
  async function legacyLedger(userId: string, amount: string) {
    // Simulate a pre-v7 record in an isolated disposable test schema.
    await db.transaction(async tx => {
      await tx.query('ALTER TABLE ledger DISABLE TRIGGER ledger_source');
      await tx.query("INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'settlement',$3,$4)", [id(), userId, amount, id()]);
      await tx.query('ALTER TABLE ledger ENABLE TRIGGER ledger_source');
    });
  }
  beforeEach(async () => {
    db = await openTestDB(); await migrate(db);
    await bootstrap(db, { ADMIN_EMAIL: 'owner@finance.example', ADMIN_PASSWORD: password });
    [owner] = await db.query("SELECT * FROM users WHERE role='owner'");
    a = await user(owner, 'a', 0.3); b = await user(a, 'b', 0.2); c = await user(b, 'c', 0.1); sibling = await user(owner, 'sibling', 0.15);
    connections = {};
    for (const [provider, rate] of [['ai008', 0.7], ['gatelink', 0.6], ['minicc', 0.8], ['maxchat', 0.65]] as const) {
      const connectionId = id(); connections[provider] = connectionId;
      await db.query('INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,$2,$2,$3,$4)', [connectionId, provider, box.encrypt({ username: 'fixture', password: 'fixture' }), rate]);
      await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,$3,'1970-01-01')", [id(), connectionId, rate]);
    }
    ({ app } = await createApp(db, { encryptionKey: 'ab'.repeat(32), appUrl: 'http://localhost:3000' }));
  });
  afterEach(async () => { await app?.close(); await db?.close(); });

  it('previews only the selected layer and separates ready, unassigned, unverified and already invoiced days', async () => {
    const ready = await binding(a), invoiced = await binding(c, 'gatelink'), unassigned = id(), unassignedAccount = id();
    await db.query("INSERT INTO accounts(id,email) VALUES($1,'unassigned@finance.example')", [unassignedAccount]);
    await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)', [unassigned, unassignedAccount, connections.ai008]);
    await observe(ready, '100'); await observe(invoiced, '200', prior(2));
    await createInvoice(db, owner, owner.id, prior(2), prior(2));
    for (const [bindingId, rawUsd, day] of [[ready, '50', prior(2)], [unassigned, '30', prior(2)], [ready, '1000', today()]]) {
      await db.transaction(tx => ingestUsage(tx, { bindingId, rawUsd, day, final: false, source: 'preview-fixture' }));
    }
    await db.query('UPDATE connections SET name=$1 WHERE id=$2', ['private-finance-master@example.com', connections.ai008]);
    const preview = await db.transaction(tx => previewInvoice(tx, owner, owner.id, prior(2), prior()));
    expect(preview.ready).toEqual({ count: 1, raw_usd: '100.00000000', gross_usd: '70.00000000', downstream_usd: '30.00000000', profit_usd: '40.00000000' });
    expect(preview.unassigned).toEqual({ count: 1, raw_usd: '30.00000000' });
    expect(preview.provisional).toEqual({ count: 1, raw_usd: '50.00000000' });
    expect(preview.invoiced).toEqual({ count: 1, gross_usd: '120.00000000' });
    expect(preview.platforms).toHaveLength(2);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-ccmax-request': '1' }, payload: { email: a.email, password } });
    const cookie = String(login.headers['set-cookie']).split(';')[0], url = `/api/invoices/preview?from=${prior(2)}&to=${prior()}`;
    const response = await app.inject({ url, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ userId: a.id, ready: { count: 2, raw_usd: '300.00000000', gross_usd: '90.00000000', downstream_usd: '40.00000000', profit_usd: '50.00000000' }, unassigned: { count: 0 }, invoiced: { count: 0 } });
    expect(response.body).not.toContain('private-finance-master');
    for (const userId of [owner.id, sibling.id, c.id]) expect((await app.inject({ url: `${url}&userId=${userId}`, headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/invoices/preview?from=${today()}&to=${today()}`, headers: { cookie } })).statusCode).toBe(400);
    expect(await db.query('SELECT * FROM ledger')).toHaveLength(0);
    expect(await db.query('SELECT * FROM invoices')).toHaveLength(1);
  });

  it('refuses to confirm an invoice containing a repeated nonzero daily snapshot', async () => {
    const target=await binding(a,'gatelink'), previous=prior(2), current=prior();
    await db.transaction(tx=>ingestUsage(tx,{bindingId:target,day:previous,rawUsd:'706.249458',final:true,source:'daily_snapshot'}));
    await db.transaction(tx=>ingestUsage(tx,{bindingId:target,day:current,rawUsd:'706.249458',final:true,source:'daily_snapshot'}));
    const invoice=await createInvoice(db,owner,a.id,current,current);

    await expect(confirmInvoice(db,owner,invoice.id,'should remain blocked')).rejects.toThrow('前一日完全相同');
    expect((await db.query('SELECT state FROM invoices WHERE id=$1',[invoice.id]))[0].state).toBe('pending');
    expect(await db.query('SELECT * FROM ledger WHERE reference_id=$1',[invoice.id])).toHaveLength(0);
  });

  it('reports confirmed gross funding and separates direct team payment obligations', async () => {
    const bindingId = await binding(a);
    await observe(bindingId, '100');
    const upstream = await createInvoice(db, owner, owner.id, prior(), prior());
    await confirmInvoice(db, owner, upstream.id, 'upstream receipt');
    const child = await createInvoice(db, a, a.id, prior(), prior());

    expect(await settlementFunds(db, owner.id)).toEqual({
      confirmedGrossUsd: '70.00000000',
      grossFundingAvailableUsd: '70.00000000',
      downstreamPayableUsd: '30.00000000',
      downstreamPaidUsd: '0.00000000',
      fundedDownstreamUsd: '30.00000000',
      unfundedDownstreamUsd: '0.00000000',
    });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-ccmax-request': '1' }, payload: { email: owner.email, password } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const finance = await app.inject({ url: '/api/finance', headers: { cookie } });
    expect(finance.statusCode).toBe(200);
    expect(finance.json().funds).toEqual({
      confirmedGrossUsd: '70.00000000',
      grossFundingAvailableUsd: '70.00000000',
      downstreamPayableUsd: '30.00000000',
      downstreamPaidUsd: '0.00000000',
      fundedDownstreamUsd: '30.00000000',
      unfundedDownstreamUsd: '0.00000000',
    });

    await confirmInvoice(db, owner, child.id, 'downstream payment');
    expect((await settlementFunds(db, owner.id)).downstreamPayableUsd).toBe('0.00000000');
    expect((await settlementFunds(db, owner.id)).downstreamPaidUsd).toBe('30.00000000');
    expect((await settlementFunds(db, owner.id)).grossFundingAvailableUsd).toBe('40.00000000');
    expect((await balance(db, owner.id)).available).toBe('70.00000000');
    await withdraw(owner,'10');
    expect((await settlementFunds(db, owner.id)).confirmedGrossUsd).toBe('70.00000000');
    expect((await settlementFunds(db, owner.id)).grossFundingAvailableUsd).toBe('30.00000000');
  });

  it('withdraws confirmed team funding through the same balance and restores a mixed rejection once', async () => {
    await observe(await binding(a), '100');
    const invoice = await createInvoice(db, owner, owner.id, prior(), prior());
    await confirmInvoice(db, owner, invoice.id, 'upstream receipt');

    expect(await balance(db, owner.id)).toEqual({ available: '70.00000000', pending: '0.00000000' });
    const withdrawal = await withdraw(owner, '65');
    expect(withdrawal.team_amount_usd).toBe('25.00000000');
    expect(await balance(db, owner.id)).toEqual({ available: '5.00000000', pending: '65.00000000' });

    await reviewWithdrawal(db, owner, withdrawal.id, 'rejected', 'team payment not sent');
    await reviewWithdrawal(db, owner, withdrawal.id, 'rejected', 'team payment not sent');
    expect(await balance(db, owner.id)).toEqual({ available: '70.00000000', pending: '0.00000000' });
    expect(await db.query("SELECT kind,amount_usd FROM team_fund_ledger ORDER BY kind")).toEqual([
      { kind: 'funding', amount_usd: '30.00000000' },
      { kind: 'withdrawal_hold', amount_usd: '-25.00000000' },
      { kind: 'withdrawal_release', amount_usd: '25.00000000' },
    ]);
    await assertWalletAccounting(db, owner.id);
  });

  it('lets an owner attest an ended live snapshot and creates the settlement chain', async () => {
    const bindingId = await binding(c), sourceAt = new Date(prior()+'T23:00:00+08:00').toISOString();
    await db.transaction(tx => ingestUsage(tx, { bindingId, day: prior(), rawUsd: '100', final: false, source: 'live_snapshot', sourceAt }));
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-ccmax-request': '1' }, payload: { email: owner.email, password } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const response = await app.inject({
      method: 'POST', url: '/api/billing/finalize-snapshot', headers: { cookie, 'x-ccmax-request': '1' },
      payload: { connectionId: connections.ai008, day: prior(), evidence: 'verified end-of-day upstream snapshot', confirmUpstream: true, upstreamReference: 'platform receipt A-1028' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ basis: 'snapshot', state: 'succeeded', finalized: 1, invoices: 4, reviewed: true, upstreamConfirmed: 1, upstreamProfitUsd: '40.00000000' });
    expect((await db.query('SELECT state,source FROM usage_days'))[0]).toEqual({ state: 'final', source: 'reviewed_statement' });
    expect((await db.query('SELECT estimated FROM invoices')).every(row => !row.estimated)).toBe(true);
    expect((await balance(db, owner.id)).available).toBe('70.00000000');
    const days = await app.inject({ url: `/api/billing/days?from=${prior()}&to=${prior()}`, headers: { cookie } });
    expect(days.json().rows[0]).toMatchObject({ reviewed: true });
  });

  it('shows every frozen rate for the selected settlement member without substituting current or administrator prices',async()=>{
    const accountBinding=await binding(a);
    await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'ai008',0.25,$3,$4)",[id(),a.id,prior(),owner.id]);
    await observe(accountBinding,'100',prior(2));await observe(accountBinding,'100',prior());
    const frozen=await db.query('SELECT * FROM earnings ORDER BY id');
    await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'ai008',0.15,$3,$4)",[id(),a.id,today(),owner.id]);
    const preview=await db.transaction(tx=>previewInvoice(tx,owner,a.id,prior(2),prior()));
    expect(preview.platforms).toHaveLength(1);
    expect(preview.platforms[0].ready_rates.map(Number)).toEqual([0.25,0.3]);
    expect(preview.ready).toMatchObject({gross_usd:'55.00000000'});
    expect(await db.query('SELECT * FROM earnings ORDER BY id')).toEqual(frozen);
    expect(await db.query('SELECT * FROM ledger')).toHaveLength(0);
    expect(await db.query('SELECT * FROM invoices')).toHaveLength(0);
  });

  it('rejects a changed preview before inserting any invoice, and refreshes without changing wallet funds', async () => {
    await observe(await binding(a), '100');
    const preview = await db.transaction(tx => previewInvoice(tx, owner, owner.id, prior(), prior()));
    await observe(await binding(sibling), '7');
    await expect(createInvoice(db, owner, owner.id, prior(), prior(), preview.previewToken)).rejects.toThrow('明细已变化');
    expect(await db.query('SELECT * FROM invoices')).toHaveLength(0);
    const fresh = await db.transaction(tx => previewInvoice(tx, owner, owner.id, prior(), prior()));
    expect(fresh.ready.count).toBe(2);
    const invoice = await createInvoice(db, owner, owner.id, prior(), prior(), fresh.previewToken);
    expect(invoice.gross_usd).toBe('74.90000000');
    const after = await db.transaction(tx => previewInvoice(tx, owner, owner.id, prior(), prior()));
    expect(after.ready.count).toBe(0); expect(after.invoiced.count).toBe(2);
    expect((await balance(db, owner.id)).available).toBe('0.00000000');
  });

  it('conserves every 8-decimal dollar through branches, four levels, all four platforms, invoices and payouts', async () => {
    const expected = new Map([owner, a, b, c, sibling].map(user => [user.id, 0n]));
    const withdrawable = new Map([owner, a, b, c, sibling].map(user => [user.id, 0n]));
    const samples = ['0.00000001', '0.00000007', '0.12345678', '100.12345678', '9876543210.12345678'];
    let upstream = 0n;
    for (const [provider, rootRate] of [['ai008', 7000], ['gatelink', 6000], ['minicc', 8000], ['maxchat', 6500]] as const) {
      for (const [target, members, rates] of [[c, [owner, a, b, c], [rootRate, 3000, 2000, 1000]], [sibling, [owner, sibling], [rootRate, 1500]]] as [Row, Row[], number[]][]) {
        const bindingId = await binding(target, provider);
        for (let index = 0; index < samples.length; index++) {
          const raw = samples[index], usageId = await observe(bindingId, raw, prior(index + 1));
          const earned = await db.query('SELECT * FROM earnings WHERE usage_id=$1', [usageId]);
          upstream += receivable(raw, rootRate);
          for (let level = 0; level < members.length; level++) {
            const gross = receivable(raw, rates[level]), payable = receivable(raw, rates[level + 1] || 0), profit = gross - payable;
            const item = earned.find(item => item.user_id === members[level].id)!;
            expect([item.gross_usd, item.downstream_usd, item.profit_usd]).toEqual([dollars(gross), dollars(payable), dollars(profit)]);
            expected.set(item.user_id, expected.get(item.user_id)! + profit);
            withdrawable.set(item.user_id, withdrawable.get(item.user_id)! + gross);
          }
        }
      }
    }
    const members = [owner, a, b, c, sibling], payers = [owner, owner, a, b, owner];
    for (let index = 0; index < members.length; index++) {
      const member = members[index], invoice = await createInvoice(db, member, member.id, prior(5), prior());
      await confirmInvoice(db, payers[index], invoice.id, 'verified upstream receipt');
      expect((await balance(db, member.id)).available).toBe(dollars(withdrawable.get(member.id)!));
      await assertWalletAccounting(db, member.id);
    }
    expect([...expected.values()].reduce((total, profit) => total + profit, 0n)).toBe(upstream);
    const funded=await audit();expect(funded.ok).toBe(true);expect(funded.checked).toMatchObject({wallets:5,finalizedUsageDays:40,provisionalUsageDays:0});
    expect(atoms(funded.totals.available_profit_usd)).toBe(upstream);
    expect(funded.platforms.every(p=>p.usage_days===10&&p.finalized_days===10&&Number(p.uninvoiced_receivable_usd)===0)).toBe(true);
    for (let index = 0; index < members.length; index++) {
      const member = members[index], amount = withdrawable.get(member.id)!, half = amount / 2n;
      const paid = await withdraw(member, dollars(half));
      await reviewWithdrawal(db, payers[index], paid.id, 'paid', 'external payment reference');
      await reviewWithdrawal(db, payers[index], paid.id, 'paid', 'external payment reference');
      const rejected = await withdraw(member, dollars(amount - half));
      await reviewWithdrawal(db, payers[index], rejected.id, 'rejected', 'destination review');
      await reviewWithdrawal(db, payers[index], rejected.id, 'rejected', 'destination review');
      expect(await balance(db, member.id)).toEqual({ available: dollars(amount - half), pending: '0.00000000' });
      await assertWalletAccounting(db, member.id);
      await expect(withdraw(member, dollars(amount - half + 1n))).rejects.toThrow('余额不足');
    }
    const paid=await audit();expect(paid.ok).toBe(true);
    expect(atoms(paid.totals.available_profit_usd)+paid.wallets.reduce((n,w)=>n+atoms(w.paid_profit_withdrawal_usd),0n)).toBe(upstream);
  });

  it('requires confirmed parent coverage for every day, even when invoices cover different periods', async () => {
    const bindingId = await binding(a);
    await observe(bindingId, '100', prior(2)); await observe(bindingId, '100', prior());
    const first = await createInvoice(db, owner, owner.id, prior(2), prior(2));
    await confirmInvoice(db, owner, first.id, 'first day received');
    const child = await createInvoice(db, a, a.id, prior(2), prior());
    await expect(confirmInvoice(db, owner, child.id, 'too early')).rejects.toThrow('尚未确认');
    expect((await balance(db, a.id)).available).toBe('0.00000000');
    const second = await createInvoice(db, owner, owner.id, prior(), prior());
    await confirmInvoice(db, owner, second.id, 'second day received');
    await confirmInvoice(db, owner, child.id, 'complete period');
    expect((await balance(db, a.id)).available).toBe('60.00000000');
  });

  it('serializes competing invoices and duplicate confirmations without duplicate credit', async () => {
    await observe(await binding(owner));
    const created = await Promise.allSettled([createInvoice(db, owner, owner.id, prior(), prior()), createInvoice(db, owner, owner.id, prior(), prior())]);
    expect(created.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const [invoice] = await db.query('SELECT * FROM invoices');
    await Promise.all([confirmInvoice(db, owner, invoice.id, 'same receipt'), confirmInvoice(db, owner, invoice.id, 'same receipt')]);
    expect(await db.query("SELECT * FROM ledger WHERE kind='settlement'")).toHaveLength(1);
    expect(await balance(db, owner.id)).toEqual({ available: '70.00000000', pending: '0.00000000' });
  });

  it('serializes simultaneous withdrawal decisions and restores a rejected hold only once', async () => {
    await seedSettlement(db, a.id, '100');
    const requested = await Promise.allSettled([withdraw(a, '80'), withdraw(a, '80')]);
    expect(requested.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const [withdrawal] = await db.query('SELECT * FROM withdrawals');
    const decisions = await Promise.allSettled([reviewWithdrawal(db, owner, withdrawal.id, 'paid', 'external payment'), reviewWithdrawal(db, owner, withdrawal.id, 'rejected', 'review failed')]);
    expect(decisions.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const [processed] = await db.query('SELECT * FROM withdrawals');
    expect(await balance(db, a.id)).toEqual({ available: processed.state === 'paid' ? '20.00000000' : '100.00000000', pending: '0.00000000' });
    expect(await db.query("SELECT * FROM ledger WHERE kind='withdrawal_release'")).toHaveLength(processed.state === 'paid' ? 0 : 1);
    await assertWalletAccounting(db, a.id);
  });

  it('rejects empty or mismatched invoice totals before any profit credit', async () => {
    const invoiceId = id();
    const [invoice] = await db.query("INSERT INTO invoices(id,number,user_id,date_from,date_to,gross_usd,downstream_usd,profit_usd,created_by) VALUES($1,$1,$2,$3,$3,999,0,999,$2) RETURNING *", [invoiceId, owner.id, prior()]);
    await expect(confirmInvoice(db, owner, invoice.id, 'empty legacy invoice')).rejects.toMatchObject({ code: 'INVOICE_INTEGRITY_CONFLICT' });
    const usageId = await observe(await binding(owner));
    const [earning] = await db.query('SELECT id FROM earnings WHERE usage_id=$1', [usageId]);
    await db.query('INSERT INTO invoice_items(earning_id,invoice_id) VALUES($1,$2)', [earning.id, invoice.id]);
    await expect(confirmInvoice(db, owner, invoice.id, 'mismatched totals')).rejects.toMatchObject({ code: 'INVOICE_INTEGRITY_CONFLICT' });
    expect(await db.query('SELECT * FROM ledger')).toHaveLength(0);
    expect((await db.query('SELECT state FROM invoices'))[0].state).toBe('pending');
  });

  it.each(['missing-level', 'wrong-formula', 'wrong-payer'])('blocks legacy %s earnings without rewriting sealed history', async problem => {
    const bindingId = await binding(), savedId = id();
    await db.query("INSERT INTO usage_days(id,binding_id,day,raw_usd,state,source,root_rate) VALUES($1,$2,$3,100,'provisional','legacy',0.7)", [savedId, bindingId, prior()]);
    const members = [owner, a, b, c], rates = [0.7, 0.3, 0.2, 0.1];
    for (let index = 0; index < members.length; index++) {
      if (problem === 'missing-level' && index === 1) continue;
      const gross = problem === 'wrong-formula' && index === 3 ? 15 : rates[index] * 100, downstream = (rates[index + 1] || 0) * 100;
      await db.query('INSERT INTO earnings(id,usage_id,user_id,payer_id,next_user_id,rate,downstream_rate,gross_usd,downstream_usd,profit_usd) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id(), savedId, members[index].id, problem === 'wrong-payer' && index === 3 ? owner.id : members[index].parent_id, members[index + 1]?.id ?? null, rates[index], rates[index + 1] || 0, gross, downstream, gross - downstream]);
    }
    await db.query("UPDATE usage_days SET state='final' WHERE id=$1", [savedId]);
    const before = await db.query('SELECT * FROM earnings ORDER BY id');
    await expect(createInvoice(db, owner, owner.id, prior(), prior())).rejects.toMatchObject({ code: 'USAGE_ACCOUNTING_CONFLICT' });
    expect(await db.query('SELECT * FROM earnings ORDER BY id')).toEqual(before);
    expect(await db.query('SELECT * FROM ledger')).toHaveLength(0);
  });

  it('blocks phantom legacy credits and isolates reconciliation to the calling wallet', async () => {
    await seedSettlement(db, a.id, '100'); await legacyLedger(b.id, '10');
    await assertWalletAccounting(db, a.id);
    await expect(withdraw(b, '1')).rejects.toMatchObject({ code: 'WALLET_INTEGRITY_CONFLICT' });
    expect(await db.query('SELECT * FROM withdrawals')).toHaveLength(0);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-ccmax-request': '1' }, payload: { email: a.email, password } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const check = await app.inject({ url: `/api/finance/check?userId=${b.id}`, headers: { cookie } });
    expect(check.statusCode).toBe(200); expect(check.json()).toMatchObject({ ok: true, balance: { available: '100.00000000' } });
    expect(check.body).not.toContain(b.id);
    expect((await app.inject({url:'/api/finance/audit',headers:{cookie}})).statusCode).toBe(403);
    const rootLogin=await app.inject({method:'POST',url:'/api/auth/login',headers:{'x-ccmax-request':'1'},payload:{email:owner.email,password}});
    const response=await app.inject({url:'/api/finance/audit',headers:{cookie:String(rootLogin.headers['set-cookie']).split(';')[0]}});
    expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({ok:false,checked:{wallets:5}});
    expect(response.json().findings).toContainEqual(expect.objectContaining({entity:'wallet',ids:[b.id],code:'WALLET_INTEGRITY_CONFLICT'}));
    expect(response.body).not.toMatch(/password|credentials|destination|finance.example/);
  });

  it('does not mint a release or approve payment for a legacy withdrawal missing its original hold', async () => {
    const withdrawalId = id();
    await db.query("INSERT INTO withdrawals(id,user_id,payer_id,amount_usd,method,destination) VALUES($1,$2,$3,10,'test','legacy destination')", [withdrawalId, a.id, owner.id]);
    for (const action of ['rejected', 'paid'] as const) await expect(reviewWithdrawal(db, owner, withdrawalId, action, 'manual review')).rejects.toMatchObject({ code: 'WALLET_INTEGRITY_CONFLICT' });
    expect(await balance(db, a.id)).toEqual({ available: '0.00000000', pending: '10.00000000' });
    expect(await db.query('SELECT * FROM ledger')).toHaveLength(0);
  });

  it('blocks a legacy confirmed child credit when the same usage has no confirmed upstream funding', async () => {
    await observe(await binding(a));
    const invoice = await createInvoice(db, a, a.id, prior(), prior());
    // An older/manual status transition may have skipped the parent check.
    await db.query("UPDATE invoices SET state='confirmed' WHERE id=$1", [invoice.id]);
    await db.query("INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'settlement',$3,$4)", [id(), a.id, invoice.profit_usd, invoice.id]);
    await expect(withdraw(a, '1')).rejects.toMatchObject({ code: 'UPSTREAM_SETTLEMENT_REQUIRED' });
    expect(await db.query('SELECT * FROM withdrawals')).toHaveLength(0);
    const parent = await createInvoice(db, owner, owner.id, prior(), prior());
    await confirmInvoice(db, owner, parent.id, 'verified root funding');
    expect((await withdraw(a, '1')).amount_usd).toBe('1.00000000');
  });

  it('enforces ledger and invoice sources in the database and prevents appending to sealed earnings', async () => {
    await expect(db.query("INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'settlement',10,$3)", [id(), a.id, id()])).rejects.toThrow('source mismatch');
    await expect(db.query("INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'withdrawal_release',10,$3)", [id(), a.id, id()])).rejects.toThrow('source mismatch');
    const usageId = await observe(await binding(a)), invoice = await createInvoice(db, a, a.id, prior(), prior());
    const [rootEarning] = await db.query('SELECT * FROM earnings WHERE usage_id=$1 AND user_id=$2', [usageId, owner.id]);
    await expect(db.query('INSERT INTO invoice_items(earning_id,invoice_id) VALUES($1,$2)', [rootEarning.id, invoice.id])).rejects.toThrow('source mismatch');
    await expect(db.query('INSERT INTO earnings(id,usage_id,user_id,rate,downstream_rate,gross_usd,downstream_usd,profit_usd) VALUES($1,$2,$3,0,0,0,0,0)', [id(), usageId, sibling.id])).rejects.toThrow('immutable');
  });

  it('preserves the full supported 24-digit amount through usage, invoice, wallet, hold and release', async () => {
    await db.query('UPDATE connection_rates SET rate=1 WHERE connection_id=$1', [connections.ai008]);
    await observe(await binding(owner), MAX_USD);
    const invoice = await createInvoice(db, owner, owner.id, prior(), prior());
    expect(invoice.gross_usd).toBe(MAX_USD);
    await confirmInvoice(db, owner, invoice.id, 'verified maximum fixture');
    const withdrawal = await withdraw(owner, MAX_USD);
    expect(await balance(db, owner.id)).toEqual({ available: '0.00000000', pending: MAX_USD });
    await reviewWithdrawal(db, owner, withdrawal.id, 'rejected', 'maximum fixture release');
    expect(await balance(db, owner.id)).toEqual({ available: MAX_USD, pending: '0.00000000' });
  });

  it('rejects oversized invoice aggregates with a clear error and no partial invoice', async () => {
    await db.query('UPDATE connection_rates SET rate=1 WHERE connection_id=$1', [connections.ai008]);
    const bindingId = await binding(owner);
    await observe(bindingId, MAX_USD, prior(2)); await observe(bindingId, MAX_USD);
    await expect(createInvoice(db, owner, owner.id, prior(2), prior())).rejects.toMatchObject({ code: 'AMOUNT_OUT_OF_RANGE' });
    expect(await db.query('SELECT * FROM invoices')).toHaveLength(0);
    expect(await db.query('SELECT * FROM invoice_items')).toHaveLength(0);
    expect((await createInvoice(db, owner, owner.id, prior(), prior())).gross_usd).toBe(MAX_USD);
  });

  it('audits provisional chains and separates ended estimates, unassigned usage and uninvoiced receivables',async()=>{
    const ended=await binding(),current=await binding(a),sealed=await binding(owner,'gatelink');
    const usageId=await db.transaction(tx=>ingestUsage(tx,{bindingId:ended,day:prior(),rawUsd:'17.12345678',final:false,source:'live_snapshot'}));
    await db.transaction(tx=>ingestUsage(tx,{bindingId:current,day:today(),rawUsd:'100',final:false,source:'live_snapshot'}));
    await observe(sealed,'12.5');
    const accountId=id(),bindingId=id();
    await db.query('INSERT INTO accounts(id,email) VALUES($1,$2)',[accountId,`${accountId}@unassigned.example`]);
    await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)',[bindingId,accountId,connections.ai008]);
    await db.transaction(tx=>ingestUsage(tx,{bindingId,day:prior(),rawUsd:'2',final:false,source:'live_snapshot'}));
    const before=await db.query('SELECT * FROM usage_days ORDER BY id'),report=await audit();
    expect(report.ok).toBe(true);expect(report.inventory).toMatchObject({assigned:3,awaiting_attribution:1});expect(report.unassignedUsageDays).toBe(1);
    expect(report.platforms.find(p=>p.provider==='ai008')).toMatchObject({accounts:3,assigned:2,unassigned:1,awaiting_finalization_days:2,awaiting_finalization_raw_usd:'19.12345678',unassigned_raw_usd:'2.00000000',finalized_raw_usd:'0'});
    expect(report.platforms.find(p=>p.provider==='gatelink')).toMatchObject({finalized_raw_usd:'12.50000000',uninvoiced_receivable_usd:'7.50000000'});
    expect(await db.query('SELECT * FROM usage_days ORDER BY id')).toEqual(before);expect(await db.query('SELECT * FROM ledger')).toHaveLength(0);
    await db.query('UPDATE earnings SET gross_usd=99,downstream_usd=0,profit_usd=99 WHERE usage_id=$1 AND user_id=$2',[usageId,c.id]);
    const broken=await audit();expect(broken.ok).toBe(false);expect(broken.findings).toContainEqual(expect.objectContaining({entity:'usage_batch',ids:expect.arrayContaining([usageId]),code:'USAGE_ACCOUNTING_CONFLICT'}));
  });
});
