import { expect, it } from 'vitest';
import { bootstrap, id } from './core.js';
import { migrate } from './db.js';
import { openTestDB } from './test-db.js';
import { balance, createInvoiceInTransaction, ingestUsage, settlementFunds } from './billing.js';
import { assertWalletAccounting } from './financial-integrity.js';

const JADEN='1cf8308f-6e34-4aa8-acd7-b45a9c9cf6f5';
const THANA='5f4dc270-335a-450f-a74f-8a33b1ad1f24';
const TARGETS=[
  ['72761ba0-b790-42cc-a7fd-21a8fb1dc44e','dev3@sartel.ai','maxchat','2026-10-29','204.63112100'],
  ['94cbbdea-38d1-46f2-8060-0f7a78348843','dev3@sartel.ai','gatelink','2026-10-29','115.39451800'],
  ['084662bf-95ff-47ce-a237-a55b33dad310','dev4@sartel.ai','gatelink','2026-10-29','130.55072400'],
  ['75d101df-832b-4f34-940b-112bd8c1739a','dev4@sartel.ai','maxchat','2026-10-29','60.16712520'],
  ['66d3eb3e-54b7-4719-a726-967f82f3c147','junior3@sartel.ai','maxchat','2026-10-29','5.51848000'],
  ['dcd5dfed-8cf2-4493-aacc-8534fa570509','rhinasofi@hotmail.com','gatelink','2026-10-31','115.54776200'],
] as const;

it('credits only the six independently supported stranded production rows once when the deployment migrates',async()=>{
  const db=await openTestDB();
  try {
    await migrate(db);
    await bootstrap(db,{ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'migration-password'});
    const [owner]=await db.query("SELECT * FROM users WHERE role='owner'");
    await db.query("INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,'jaden@example.com','Jaden','x')",[JADEN,owner.id]);
    await db.query("INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,'thana@example.com','ThanaGold','x')",[THANA,JADEN]);
    const connections:Record<string,string>={};
    for(const provider of ['gatelink','maxchat']) {
      const connection=id();connections[provider]=connection;
      await db.query('INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,$2,$2,$3,0.5)',[connection,provider,'encrypted']);
      await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,0.5,'1970-01-01',$3)",[id(),connection,owner.id]);
    }
    for(const [provider,rate] of [['gatelink','0.29'],['maxchat','0.2']] as const)
      await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,'2026-10-01',$5)",[id(),JADEN,provider,rate,owner.id]);
    await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'gatelink',0.18,'2026-10-01',$3)",[id(),THANA,owner.id]);
    const accounts=new Map<string,string>();
    for(const email of new Set(TARGETS.map(target=>target[1]))) {
      const account=id();accounts.set(email,account);
      await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,true)',[account,JADEN,email]);
    }
    const bindings=new Map<string,string>();
    for(const [usageId,email,provider,day,raw] of TARGETS) {
      const key=`${email}:${provider}`;
      let binding=bindings.get(key);
      if(!binding) {
        binding=id();bindings.set(key,binding);
        await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)',[binding,accounts.get(email),connections[provider]]);
      }
      await db.query(`INSERT INTO usage_days(id,binding_id,day,raw_usd,state,source,root_rate)
        VALUES($1,$2,$3,$4,'provisional','live_snapshot',0.5)`,[usageId,binding,day,raw]);
    }

    const thanaAccount=async(email:string,provider:'gatelink'|'ai008')=>{
      let connection=connections[provider];
      if(!connection) {
        connection=id();connections[provider]=connection;
        const rootRate=provider==='gatelink'?'0.5':'0.27';
        await db.query('INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,$2,$2,$3,$4)',[connection,provider,'encrypted',rootRate]);
        await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,$3,'1970-01-01',$4)",[id(),connection,rootRate,owner.id]);
        await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,'2026-10-01',$5)",[id(),JADEN,provider,rootRate,owner.id]);
        await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,0.18,'2026-10-01',$4)",[id(),THANA,provider,owner.id]);
      }
      const account=id(),binding=id();
      await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,true)',[account,THANA,email]);
      await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)',[binding,account,connection]);
      return binding;
    };
    const talia=await thanaAccount('talia0205lyt@gmail.com','gatelink');
    const tongwu=await thanaAccount('tongwu.de@gmail.com','gatelink');
    const yitong=await thanaAccount('yitongl.de@gmail.com','ai008');
    const ownAccount=id(),ownBinding=id();
    await db.query("INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,'legit@example.com',true)",[ownAccount,JADEN]);
    await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)',[ownBinding,ownAccount,connections.gatelink]);
    const record=async(bindingId:string,usageId:string,day:string,rawUsd:string)=>{
      const result=await db.transaction(tx=>ingestUsage(tx,{bindingId,day,rawUsd,final:true,source:'daily_snapshot'}));
      expect(result).toBe(usageId);
    };
    // Production IDs and exact amounts: Talia repeats after Oct 28; Tongwu
    // repeats after the legitimate Oct 29 value.
    await db.query(`INSERT INTO usage_days(id,binding_id,day,raw_usd,state,source,root_rate)
      VALUES($1,$2,'2026-10-28',706.249458,'provisional','daily_snapshot',0.5)`,[id(),talia]);
    await db.transaction(tx=>ingestUsage(tx,{bindingId:talia,day:'2026-10-28',rawUsd:'706.249458',final:true,source:'daily_snapshot'}));
    await db.transaction(tx=>ingestUsage(tx,{bindingId:tongwu,day:'2026-10-28',rawUsd:'1125.471664',final:true,source:'daily_snapshot'}));
    for(const [bindingId,usageId,day,rawUsd] of [
      [talia,'3391fced-4c58-4966-8eea-b1bc3bdf8f31','2026-10-29','706.249458'],
      [tongwu,'ecdfc1ec-d77d-4777-a91d-802463dcab2c','2026-10-29','22.157046'],
      [talia,'bf65cd68-1994-4fe0-8d43-ffa1ef8bbbde','2026-10-30','706.249458'],
      [tongwu,'c74cf186-7e43-4759-a4a5-69095d28efdb','2026-10-30','22.157046'],
      [talia,'9ef08a4c-a9be-43bb-abb9-2cedff3ce12f','2026-10-31','706.249458'],
      [tongwu,'2f7a01c3-03f5-41df-af73-7b1ce45d0239','2026-10-31','22.157046'],
    ] as const) {
      await db.query(`INSERT INTO usage_days(id,binding_id,day,raw_usd,state,source,root_rate)
        VALUES($1,$2,$3,$4,'provisional','daily_snapshot',0.5)`,[usageId,bindingId,day,rawUsd]);
      await record(bindingId,usageId,day,rawUsd);
    }
    const legacyConfirm=async(invoice:any)=>{
      await db.query("UPDATE invoices SET state='confirmed',reference='legacy fixture',confirmed_by=$2,confirmed_at=now() WHERE id=$1",[invoice.id,owner.id]);
      await db.query("INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'settlement',$3,$4)",[id(),invoice.user_id,invoice.profit_usd,invoice.id]);
      if(Number(invoice.downstream_usd)>0)await db.query("INSERT INTO team_fund_ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'funding',$3,$4)",[id(),invoice.user_id,invoice.downstream_usd,invoice.id]);
    };
    const settleUpstream=async(day:string,confirm=true)=>{
      const rootInvoice=await db.transaction(tx=>createInvoiceInTransaction(tx,owner,owner.id,day,day,undefined,true));
      if(confirm)await legacyConfirm(rootInvoice);
      const jadenInvoice=await db.transaction(tx=>createInvoiceInTransaction(tx,owner,JADEN,day,day,undefined,true));
      if(confirm)await legacyConfirm(jadenInvoice);
      return db.transaction(tx=>createInvoiceInTransaction(tx,owner,THANA,day,day,undefined,true));
    };
    await db.transaction(tx=>ingestUsage(tx,{bindingId:ownBinding,day:'2026-10-29',rawUsd:'282.736636',final:true,source:'upstream_daily'}));
    await settleUpstream('2026-10-29');
    await db.transaction(tx=>ingestUsage(tx,{bindingId:ownBinding,day:'2026-10-30',rawUsd:'1133.861086',final:true,source:'upstream_daily'}));
    await settleUpstream('2026-10-30');
    await db.transaction(tx=>ingestUsage(tx,{bindingId:yitong,day:'2026-10-30',rawUsd:'70.718875',final:true,source:'upstream_daily'}));
    await settleUpstream('2026-10-30');
    await db.transaction(tx=>ingestUsage(tx,{bindingId:ownBinding,day:'2026-10-31',rawUsd:'4107.441104',final:true,source:'upstream_daily'}));
    await settleUpstream('2026-10-31',false);

    const beforeFunds=await settlementFunds(db,JADEN);
    expect(beforeFunds.downstreamPayableUsd).toBe('406.06890966');
    const before=await balance(db,JADEN);

    // Migration 26 is deliberately left applied: production has already
    // consumed it. A bad fingerprint must roll migration 27 back atomically.
    await db.query('DELETE FROM migrations WHERE version=27');
    const [oct31Thana]=await db.query("SELECT id FROM invoices WHERE user_id=$1 AND date_from='2026-10-31' AND state='pending'",[THANA]);
    await db.query('UPDATE invoices SET estimated=false WHERE id=$1',[oct31Thana.id]);
    await expect(migrate(db)).rejects.toThrow('fingerprint mismatch');
    expect((await db.query('SELECT count(*)::int AS count FROM migrations WHERE version=27'))[0].count).toBe(0);
    expect((await db.query('SELECT count(*)::int AS count FROM settlement_adjustments'))[0].count).toBe(0);
    await db.query('UPDATE invoices SET estimated=true WHERE id=$1',[oct31Thana.id]);
    await migrate(db);
    await migrate(db);

    const [credit]=await db.query(`SELECT COALESCE(sum(l.amount_usd),0) AS amount,count(*)::int AS count FROM ledger l
      JOIN invoices i ON i.id=l.reference_id WHERE l.user_id=$1 AND l.kind='settlement'
      AND i.reference='automatic settlement reconciliation 2026-10-31'`,[JADEN]);
    expect(credit).toEqual({amount:'158.89631640',count:1});
    expect((await db.query("SELECT count(*)::int AS count FROM usage_days WHERE id=ANY($1::text[]) AND state='final'",[TARGETS.map(target=>target[0])]))[0].count).toBe(6);
    expect((await db.query('SELECT count(*)::int AS count FROM migrations WHERE version=27'))[0].count).toBe(1);
    const afterFunds=await settlementFunds(db,JADEN);
    expect(afterFunds.downstreamPayableUsd).toBe('16.71766578');
    expect(afterFunds.confirmedGrossUsd).toBe(new (await import('decimal.js')).default(beforeFunds.confirmedGrossUsd).minus('257.15391258').toFixed(8));
    expect((await db.query("SELECT COALESCE(sum(profit_usd),0) AS amount FROM invoices WHERE user_id=$1 AND state='pending'",[JADEN]))[0].amount).toBe('1191.15792016');
    expect((await db.query(`SELECT count(*)::int AS count FROM earnings e LEFT JOIN invoice_items x ON x.earning_id=e.id
      WHERE e.usage_id=ANY($1::text[]) AND x.earning_id IS NULL`,[[
        '3391fced-4c58-4966-8eea-b1bc3bdf8f31','bf65cd68-1994-4fe0-8d43-ffa1ef8bbbde',
        'c74cf186-7e43-4759-a4a5-69095d28efdb','9ef08a4c-a9be-43bb-abb9-2cedff3ce12f',
        '2f7a01c3-03f5-41df-af73-7b1ce45d0239',
      ]]))[0].count).toBe(0);
    expect((await balance(db,JADEN)).available).toBe(new (await import('decimal.js')).default(before.available).minus('257.15391258').toFixed(8));
    await expect(assertWalletAccounting(db,JADEN)).resolves.toBeUndefined();
  } finally {await db.close();}
});
