import { expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { bootstrap, id } from './core.js';
import { migrate } from './db.js';
import { ingestUsage } from './billing.js';
import { openTestDB } from './test-db.js';

const JADEN = '1cf8308f-6e34-4aa8-acd7-b45a9c9cf6f5';
const targets = [
  ['a7f06884-629f-4e0c-90ff-0b8c6c45515e','dev2@sartel.ai','gatelink','2026-10-28','353.92761200'],
  ['1a6d2bda-701d-4c6c-870c-ec40af1b12ba','dev3@sartel.ai','gatelink','2026-10-28','151.24591100'],
  ['652e804b-36b6-449a-a6a1-acbc23df8b17','dev3@sartel.ai','maxchat','2026-10-26','328.85530500'],
  ['9e4dcc77-263c-4fce-b5ad-cc39d0cc0380','dev4@sartel.ai','maxchat','2026-10-26','106.45597000'],
] as const;

async function productionFixture(rawOverride?: string) {
  const db=await openTestDB();
  await migrate(db);
  await bootstrap(db,{ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'migration-password'});
  const [owner]=await db.query("SELECT * FROM users WHERE role='owner'");
  await db.query("INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,'jaden@example.com','Jaden','x')",[JADEN,owner.id]);
  const connections:Record<string,string>={};
  for(const provider of ['gatelink','maxchat']) {
    const connection=id();connections[provider]=connection;
    await db.query('INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,$2,$2,$3,0.5)',[connection,provider,'encrypted']);
    await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,0.5,'1970-01-01',$3)",[id(),connection,owner.id]);
  }
  await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'gatelink',0.29,'2026-10-24',$3)",[id(),JADEN,owner.id]);
  const accounts=new Map<string,string>();
  for(const email of new Set(targets.map(row=>row[1]))) {
    const account=id();accounts.set(email,account);
    await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,true)',[account,JADEN,email]);
  }
  for(const [index,[usageId,email,provider,day,raw]] of targets.entries()) {
    const binding=id();
    await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)',[binding,accounts.get(email),connections[provider]]);
    await db.query(`INSERT INTO usage_days(id,binding_id,day,raw_usd,state,source,root_rate)
      VALUES($1,$2,$3,$4,'provisional','live_snapshot',0.5)`,[usageId,binding,day,index===0&&rawOverride?rawOverride:raw]);
    if(provider==='gatelink') await db.transaction(tx=>ingestUsage(tx,{bindingId:binding,day,rawUsd:index===0&&rawOverride?rawOverride:raw,final:false,source:'live_snapshot'}));
  }
  await db.query('DELETE FROM migrations WHERE version=23');
  return {db,owner};
}

it('repairs the four production usage records into one exact, idempotent Jaden settlement',async()=>{
  const {db}=await productionFixture();
  try {
    await migrate(db);
    await migrate(db);
    expect(await db.query('SELECT id,state,source FROM usage_days WHERE id=ANY($1::text[]) ORDER BY id',[targets.map(row=>row[0])]))
      .toHaveLength(4);
    expect((await db.query('SELECT count(*)::int AS count FROM usage_days WHERE id=ANY($1::text[]) AND state=\'final\'',[targets.map(row=>row[0])]))[0].count).toBe(4);
    const [credit]=await db.query("SELECT COALESCE(sum(amount_usd),0) AS amount,count(*)::int AS count FROM ledger WHERE user_id=$1 AND kind='settlement'",[JADEN]);
    expect(credit).toEqual({amount:'233.56257667',count:1});
    const [rate]=await db.query("SELECT rate FROM rates WHERE user_id=$1 AND provider='maxchat' AND effective_date='2026-10-26'",[JADEN]);
    expect(rate.rate).toBe('0.2000');
    const [invoice]=await db.query("SELECT gross_usd,profit_usd,state FROM invoices WHERE user_id=$1",[JADEN]);
    expect(invoice).toEqual({gross_usd:'233.56257667',profit_usd:'233.56257667',state:'confirmed'});
    expect((await db.query('SELECT count(*)::int AS count FROM migrations WHERE version=23'))[0].count).toBe(1);
  } finally {await db.close();}
});

it('rolls back the repair when any production fingerprint differs',async()=>{
  const {db}=await productionFixture('353.92761201');
  try {
    await expect(migrate(db)).rejects.toThrow('repair fingerprint mismatch');
    expect((await db.query("SELECT count(*)::int AS count FROM usage_days WHERE id=ANY($1::text[]) AND state='final'",[targets.map(row=>row[0])]))[0].count).toBe(0);
    expect(await db.query('SELECT * FROM ledger WHERE user_id=$1',[JADEN])).toEqual([]);
    expect(await db.query('SELECT * FROM migrations WHERE version=23')).toEqual([]);
  } finally {await db.close();}
});
