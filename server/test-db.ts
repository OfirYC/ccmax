import { openDB, type DB } from './db.js';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { ancestry, id, usd } from './core.js';
import { confirmInvoice, createInvoice, ingestUsage } from './billing.js';

// Each PostgreSQL test gets its own schema. Never migrate or truncate the
// caller's existing tables. Without TEST_DATABASE_URL use disposable PGlite.
export async function openTestDB():Promise<DB> {
  if(!process.env.TEST_DATABASE_URL)return openDB();
  const admin=await openDB(process.env.TEST_DATABASE_URL),schema='ccmax_test_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options',`-c search_path=${schema}`);
  const db=await openDB(url.toString());
  return {...db,async close(){await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();}};
}

// Finance fixtures use the real frozen-usage → invoice → ledger path. Never
// inject an unexplained balance that production source checks would reject.
export async function seedSettlement(db: DB, userId: string, amount: string) {
  const chain = await ancestry(db, userId), connectionId = id(), accountId = id(), bindingId = id(), day = '2000-01-01';
  for (const user of chain.filter(user => user.role !== 'owner')) {
    await db.query(`INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'ai008',1,'1970-01-01',$3)
      ON CONFLICT(user_id,provider,effective_date) DO NOTHING`, [id(), user.id, user.parent_id]);
  }
  const [price] = await db.query("SELECT rate FROM rates WHERE user_id=$1 AND provider='ai008' AND effective_date<=$2 ORDER BY effective_date DESC LIMIT 1", [userId, day]);
  const rate = chain.at(-1)?.role === 'owner' ? '1' : price.rate;
  await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','Settlement fixture','fixture',1)", [connectionId]);
  await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,1,'1970-01-01')", [id(), connectionId]);
  await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,true)', [accountId, userId, `${accountId}@fixture.example`]);
  await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)', [bindingId, accountId, connectionId]);
  await db.transaction(tx => ingestUsage(tx, { bindingId, day, rawUsd: usd(new Decimal(amount).div(rate)), final: true, source: 'settlement-fixture' }));
  for (let index = 0; index < chain.length; index++) {
    const user = chain[index], invoice = await createInvoice(db, user, user.id, day, day);
    await confirmInvoice(db, chain[Math.max(index - 1, 0)], invoice.id, 'fixture verified receipt');
  }
}
