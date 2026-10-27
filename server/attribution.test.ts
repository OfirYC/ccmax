import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openTestDB } from './test-db.js';
import { migrate,type DB,type Row } from './db.js';
import { bootstrap,hashPassword,id,secretBox,today } from './core.js';
import { createApp } from './app.js';
import { normalizeTelemetry,saveTelemetry } from './telemetry.js';
import { ingestUsage } from './billing.js';
import { assertUsageAccounting } from './financial-integrity.js';
import { createWorker,enqueue,saveBinding } from './worker.js';
import { auditAttribution } from './attribution-audit.js';

const password='attribution-test-password',encryptionKey='46'.repeat(32);
const previousDay=()=>new Date(Date.parse(today()+'T00:00:00Z')-86400000).toISOString().slice(0,10);
describe('independent account, platform and recursive team reconciliation',()=>{
  let db:DB,app:FastifyInstance,root:Row,a:string,c:string,g:string,b:string,ai:string,ai2:string,gate:string,mini:string,disabled:string,cookie:string;
  async function login(email:string) {
    const r=await app.inject({method:'POST',url:'/api/auth/login',headers:{'x-ccmax-request':'1'},payload:{email,password}});
    expect(r.statusCode,r.body).toBe(200);cookie=String(r.headers['set-cookie']).split(';')[0];
  }
  const get=async(url:string)=>(await app.inject({url,headers:{cookie}})).json();
  async function connection(provider:string,enabled=true) {
    const cid=id();await db.query('INSERT INTO connections(id,provider,name,credentials,payout_rate,enabled) VALUES($1,$2,$3,$4,0.8,$5)',[cid,provider,'private-master-'+cid,secretBox(encryptionKey).encrypt({username:'fixture',password:'fixture'}),enabled]);
    await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,0.8,'1970-01-01')",[id(),cid]);return cid;
  }
  async function account(owner:string|null,conn:string,value:number,opts:{verified?:boolean;aid?:string;stale?:boolean;missing?:boolean}={}) {
    const aid=opts.aid??id(),bid=id();
    if(!opts.aid)await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,$4)',[aid,owner,aid+'@example.com',opts.verified??true]);
    // A deliberately unrelated legacy daily_usd catches accidental use of the
    // inventory cache instead of the correctly dated operational snapshot.
    await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id,daily_usd,status) VALUES($1,$2,$3,$1,9999,$4)',[bid,aid,conn,opts.missing?'missing':'active']);
    const t=normalizeTelemetry('ai008',{stats:{rpm:value,tpm:value*100,daily_req:value*10,daily_tok:value*1000,daily_cost:`${value}.125`},usage_windows:{req_7d:value*70,cost_7d:`${value}.875`}});
    if(opts.stale){t.sourceAt=new Date(Date.now()-3600000).toISOString();t.collectedAt=t.sourceAt;}
    await saveTelemetry(db,bid,t);return {aid,bid};
  }
  beforeEach(async()=>{
    db=await openTestDB();await migrate(db);await bootstrap(db,{ADMIN_EMAIL:'root@example.com',ADMIN_PASSWORD:password});[root]=await db.query("SELECT * FROM users WHERE role='owner'");
    a=id();c=id();g=id();b=id();const hash=await hashPassword(password);
    for(const [uid,parent,email] of [[a,root.id,'a@example.com'],[c,a,'c@example.com'],[g,c,'g@example.com'],[b,root.id,'b@example.com']]) {
      await db.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$3,$4)',[uid,parent,email,hash]);
      for(const provider of ['ai008','gatelink','minicc'])await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,'1970-01-01',$5)",[id(),uid,provider,uid===a?0.6:uid===c?0.4:uid===g?0.2:0.3,parent]);
    }
    ai=await connection('ai008');ai2=await connection('ai008');gate=await connection('gatelink');mini=await connection('minicc');disabled=await connection('ai008',false);
    ({app}=await createApp(db,{encryptionKey,appUrl:'http://localhost:3000'}));await login('a@example.com');
  });
  afterEach(async()=>{vi.useRealTimers();await app.close();await db.close();});

  it('reconciles every scope with distinct values, shared emails across platforms, excluded snapshots and exact-owner member groups',async()=>{
    await account(root.id,ai,2);const shared=await account(a,ai,3);await account(a,ai2,5,{aid:shared.aid});await account(a,gate,7,{aid:shared.aid});
    await account(c,mini,11);await account(g,ai,13);await account(b,ai,17);await account(null,ai,19,{verified:false});await account(a,ai,23,{verified:false});
    await account(a,gate,29,{stale:true});await account(c,mini,31,{missing:true});await account(g,disabled,37);
    const all=await get('/api/telemetry');expect(all.total).toBe(8);expect(all.totals).toMatchObject({bindings:8,fresh:5,rpm:{value:'39',covered:5,total:8},requests:{value:'390'},tokens:{value:'39000'},billedUsd:{value:'39.625'}});
    expect(all.attribution).toEqual({assigned:8,unassigned:0});
    expect((await get('/api/telemetry?scope=self')).totals.rpm.value).toBe('15');expect((await get('/api/telemetry?scope=descendants')).totals.rpm.value).toBe('24');
    expect((await get(`/api/telemetry?ownerId=${c}`)).totals.rpm.value).toBe('11');expect((await get(`/api/telemetry?accountId=${shared.aid}`)).totals.rpm.value).toBe('15');
    expect((await get('/api/telemetry?provider=ai008')).totals.rpm.value).toBe('21');expect((await get(`/api/telemetry?connectionId=${ai2}`)).totals.rpm.value).toBe('5');
    expect(all.members.map((m:any)=>[m.id,m.rpm.value]).sort()).toEqual([[a,'15'],[c,'11'],[g,'13']].sort());
    expect(all.platforms.find((p:any)=>p.id===ai).rpm.value).toBe('16');expect(all.platforms.find((p:any)=>p.id===ai2).rpm.value).toBe('5');
    const seven=await get('/api/telemetry?period=7d');expect(seven.totals.requests.value).toBe('2730');expect(seven.totals.billedUsd.value).toBe('43.375');
    const dashboard=await get('/api/dashboard');expect(dashboard.accounts).toBe(6);expect(dashboard.team).toBe(2);
    expect(dashboard.platforms.find((p:any)=>p.id===ai)).toMatchObject({account_count:2,daily_usd:'16.25',daily_covered:2});
    expect(dashboard.platforms.find((p:any)=>p.id===gate)).toMatchObject({account_count:2,daily_usd:'7.125',daily_covered:1});
    expect(dashboard.platforms).toHaveLength(4);
    const accounts=await get('/api/accounts');expect(accounts.accounts).toHaveLength(7);const bound=accounts.accounts.flatMap((v:any)=>v.bindings);expect(bound).toHaveLength(8);
    expect(accounts.day).toBe(today());
    for(const b of bound){const row=all.rows.find((r:any)=>r.id===b.id);expect(b.telemetry).toEqual(row.telemetry);expect(b.data_fresh).toBe(row.fresh);expect(typeof b.connection_enabled).toBe('boolean');expect(b).not.toHaveProperty('data');}
    expect(bound.find((v:any)=>v.account_id===shared.aid&&v.connection_id===ai).today_usd).toBe('3.125');expect(bound.filter((v:any)=>v.today_usd===null)).toHaveLength(3);
    // Trend includes genuine historical observations from bindings now missing
    // or disabled; the current aggregate deliberately excludes these snapshots.
    const trend=await get('/api/telemetry/trend');expect(trend.samples.reduce((n:number,s:any)=>n+Number(s.rpm),0)).toBe(107);
    await login('root@example.com');const platform=await get('/api/telemetry');expect(platform.totals.rpm.value).toBe('100');expect(platform.total).toBe(12);
    expect(platform.attribution).toEqual({assigned:10,unassigned:2});expect(platform.members.find((m:any)=>m.id===null).rpm.value).toBe('42');
    expect(platform.members.find((m:any)=>m.id===a).rpm.value).toBe('15');
    expect((await get(`/api/telemetry?ownerId=${a}`)).attribution.unassigned).toBe(0);
    expect((await get('/api/telemetry?scope=descendants')).totals.rpm.value).toBe('56');
    const rootDashboard=await get('/api/dashboard');expect(rootDashboard.platforms.find((p:any)=>p.id===ai)).toMatchObject({seven_day_usd:'82.25',attribution:{assigned:4,unassigned:2}});
    await login('g@example.com');expect((await get('/api/telemetry')).totals.rpm.value).toBe('13');expect((await get('/api/telemetry?scope=descendants')).total).toBe(0);
    expect((await app.inject({url:`/api/telemetry?ownerId=${b}`,headers:{cookie}})).statusCode).toBe(403);
  });

  it('shows all enabled platforms even when the only bindings belong to a different team',async()=>{
    await account(b,ai,17);const d=await get('/api/dashboard');expect(d.platforms).toHaveLength(4);
    expect(d.platforms.find((p:any)=>p.id===ai)).toMatchObject({account_count:0,daily_usd:null,daily_covered:0});
  });

  it('platform cards share analytics totals, all periods and ownership boundaries without returning account identities',async()=>{
    await account(a,ai,3);await account(g,ai,13);await account(b,ai,17);await account(null,ai,19,{verified:false});
    await account(a,gate,29,{stale:true});await account(g,disabled,37);
    const activity=await get('/api/telemetry/platforms');
    for(const period of ['today','5h','7d','30d']){
      const analytics=await get(`/api/telemetry?period=${period}`);
      expect(activity.totals.periods[period]).toEqual(analytics.totals);
      for(const p of activity.platforms){const other=analytics.platforms.find((v:any)=>v.id===p.id);expect(p.periods[period].billedUsd).toEqual(other.billedUsd);expect(p.attribution).toEqual(other.attribution);}
    }
    expect(activity.totals.periods.today.billedUsd).toEqual({value:'16.25',covered:2,total:4});
    expect(activity.platforms.find((p:any)=>p.id===gate).periods.today.billedUsd.value).toBeNull();
    expect(activity.platforms.find((p:any)=>p.id===disabled).periods.today.fresh).toBe(0);
    expect(activity.totals.periods['30d'].billedUsd.value).toBeNull();
    expect(JSON.stringify(activity)).not.toMatch(/private-master|@example\.com|credentials|owner_id|account_id/);
    expect((await get('/api/telemetry/platforms?scope=self')).totals.periods.today.rpm.value).toBe('3');
    expect((await get('/api/telemetry/platforms?scope=descendants')).totals.periods.today.rpm.value).toBe('13');
    expect((await get('/api/telemetry/platforms?provider=gatelink')).platforms).toHaveLength(1);
    expect((await app.inject({url:`/api/telemetry/platforms?ownerId=${b}`,headers:{cookie}})).statusCode).toBe(403);
    await login('root@example.com');expect((await get('/api/telemetry/platforms')).totals.attribution.unassigned).toBe(1);
    await login('b@example.com');expect((await get('/api/telemetry/platforms')).totals.periods.today.rpm.value).toBe('17');
  });

  it('allocates historical open observations when ownership is verified, preserving frozen prices and each financial layer',async()=>{
    const {aid,bid}=await account(null,ai,3,{verified:false});
    for(const day of [previousDay(),today()])await db.transaction(tx=>ingestUsage(tx,{bindingId:bid,day,rawUsd:'101.125',final:false,source:'live_snapshot'}));
    expect(await db.query('SELECT * FROM earnings')).toHaveLength(0);
    await login('root@example.com');const assigned=await app.inject({url:`/api/accounts/${aid}/assign`,method:'POST',headers:{cookie,'x-ccmax-request':'1'},payload:{userId:g}});expect(assigned.statusCode,assigned.body).toBe(200);
    const [old]=await db.query('SELECT * FROM usage_days WHERE day=$1',[previousDay()]);
    await db.transaction(tx=>ingestUsage(tx,{bindingId:bid,day:previousDay(),rawUsd:'101.125',final:true,source:'reviewed_statement',evidence:'independent account statement'}));await assertUsageAccounting(db,[old.id]);
    const chain=await db.query('SELECT user_id,gross_usd,downstream_usd,profit_usd FROM earnings WHERE usage_id=$1',[old.id]);
    expect(chain.find(r=>r.user_id===root.id)).toMatchObject({gross_usd:'80.90000000',downstream_usd:'60.67500000',profit_usd:'20.22500000'});
    expect(chain.find(r=>r.user_id===a)).toMatchObject({gross_usd:'60.67500000',downstream_usd:'40.45000000',profit_usd:'20.22500000'});
    expect(chain.find(r=>r.user_id===c)).toMatchObject({gross_usd:'40.45000000',downstream_usd:'20.22500000',profit_usd:'20.22500000'});
    expect(chain.find(r=>r.user_id===g)).toMatchObject({gross_usd:'20.22500000',downstream_usd:'0.00000000',profit_usd:'20.22500000'});
    const team=await get('/api/team?from=1970-01-01');for(const uid of [root.id,a,c,g])expect(team.users.find((u:any)=>u.id===uid).raw_usd).toBe('202.25000000');
    expect(team.users.find((u:any)=>u.id===b).raw_usd).toBe('0');
    await login('a@example.com');const usage=await get('/api/usage'),dash=await get('/api/dashboard');expect(usage.totals.raw_usd).toBe('202.25000000');expect(dash.totals).toEqual(expect.objectContaining({raw_usd:usage.totals.raw_usd,profit_usd:usage.totals.profit_usd}));
    expect((await db.query('SELECT count(*)::int AS n FROM ledger'))[0].n).toBe(0);
  });

  it('rolls back ownership and allocation together if the historical contract chain is incomplete',async()=>{
    const {aid,bid}=await account(null,ai,3,{verified:false});await db.transaction(tx=>ingestUsage(tx,{bindingId:bid,day:previousDay(),rawUsd:'101',final:false,source:'live_snapshot'}));
    await db.query('DELETE FROM rates WHERE user_id=$1',[c]);await login('root@example.com');
    const assigned=await app.inject({url:`/api/accounts/${aid}/assign`,method:'POST',headers:{cookie,'x-ccmax-request':'1'},payload:{userId:g}});expect(assigned.statusCode).toBe(400);
    expect((await db.query('SELECT owner_id,ownership_verified FROM accounts WHERE id=$1',[aid]))[0]).toEqual({owner_id:null,ownership_verified:false});expect(await db.query('SELECT * FROM earnings')).toHaveLength(0);
  });

  it('audits both open and frozen financial chains without changing any records or exposing identities',async()=>{
    const {bid}=await account(g,ai,3),input={bindingId:bid,day:previousDay(),rawUsd:'101.125',final:false,source:'live_snapshot'};
    await db.transaction(tx=>ingestUsage(tx,input));let report=await auditAttribution(db);expect(report.ok).toBe(true);expect(report.checked.attributedUsageDays).toBe(1);
    expect(JSON.stringify(report)).not.toMatch(/private-master|@example.com|credentials|password/);
    // Simulate an old open observation whose attribution was never populated.
    await db.query('DELETE FROM earnings WHERE user_id=$1',[c]);report=await auditAttribution(db);expect(report.ok).toBe(false);expect(report.findings[0].code).toBe('USAGE_ACCOUNTING_CONFLICT');
    expect((await db.query('SELECT count(*)::int AS n FROM earnings'))[0].n).toBe(3);expect(await db.query('SELECT * FROM ledger')).toHaveLength(0);
  });

  it('never books a cached prior-day daily amount into today during a successful inventory sync',async()=>{
    // Freeze Date only; database and network scheduling retain real timers.
    // Keep the fixture near the database clock so login sessions remain valid
    // on PostgreSQL, whose clock is independent of JavaScript's fake Date.
    const midnight=new Date(today()+'T00:02:00+08:00');
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(midnight);
    const t=normalizeTelemetry('gatelink',{upstreamSyncedAt:new Date(midnight.getTime()-3*60000).toISOString(),upstreamDailyCost:'987',upstreamSnapshot:{stats:{daily_req:321}}});
    const box=secretBox(encryptionKey),client={login:async()=>{},listAccounts:async()=>[{id:'cached',email:'cached@example.com',name:'cached',status:'active',dailyUsd:'987',cost7d:null,cost30d:null,utilization:null,telemetry:t}]};
    await enqueue(db,box,root.id,gate,'sync',{},'cached-midnight');await createWorker(db,box,()=>client as any).runOne();
    const [job]=await db.query('SELECT state,result,error FROM jobs');expect(job.state,job.error).toBe('succeeded');expect(job.result.skippedDaily).toBe(1);expect(await db.query('SELECT * FROM usage_days')).toHaveLength(0);
    await login('root@example.com');const d=await get('/api/dashboard');expect(d.platforms.find((p:any)=>p.id===gate).daily_usd).toBeNull();
    expect((await get('/api/telemetry')).totals.requests.value).toBeNull();expect((await get('/api/accounts')).accounts[0].bindings[0].today_usd).toBeNull();
  });

  it('syncs Gatelink inventory with missing counters, preserves existing usage and resumes without duplicate charges',async()=>{
    const box=secretBox(encryptionKey),[connection]=await db.query('SELECT * FROM connections WHERE id=$1',[gate]);
    const remote=(id:string,dailyUsd:string|null)=>({id,email:`${id}@example.com`,name:id,status:'active',dailyUsd,cost7d:null,cost30d:null,utilization:null,
      telemetry:normalizeTelemetry('gatelink',{upstreamDailyCost:dailyUsd,upstreamSyncedAt:new Date().toISOString()})});
    const old=await saveBinding(db,connection,remote('existing','10'));
    await db.transaction(tx=>ingestUsage(tx,{bindingId:old.id,day:today(),rawUsd:'10',final:false,source:'live_snapshot'}));
    let rows=[remote('existing',null),remote('new',null),remote('valid','1.25')];
    const client={login:async()=>{},listAccounts:async()=>rows};
    const worker=createWorker(db,box,()=>client as any);
    await enqueue(db,box,root.id,gate,'sync',{},'missing-daily-1');await worker.runOne();
    const [job]=await db.query('SELECT state,result,error FROM jobs');expect(job.state,job.error).toBe('succeeded');expect(job.result).toMatchObject({accounts:3,skippedDaily:2});
    expect((await db.query('SELECT daily_usd FROM bindings WHERE daily_usd IS NULL'))).toHaveLength(2);
    expect(await db.query('SELECT * FROM usage_days')).toHaveLength(2);
    expect((await db.query('SELECT raw_usd FROM usage_days WHERE binding_id=$1',[old.id]))[0].raw_usd).toBe('10.00000000');
    await login('root@example.com');let accounts=(await get('/api/accounts')).accounts;
    expect(accounts.find((a:any)=>a.email==='new@example.com').bindings[0].today_usd).toBeNull();
    expect(accounts.find((a:any)=>a.email==='existing@example.com').bindings[0].today_usd).toBeNull();
    rows=[remote('existing','12'),remote('new',null),remote('valid','1.25')];
    await enqueue(db,box,root.id,gate,'sync',{},'missing-daily-2');await worker.runOne();
    expect(await db.query('SELECT * FROM usage_days')).toHaveLength(2);
    expect((await db.query('SELECT raw_usd FROM usage_days WHERE binding_id=$1',[old.id]))[0].raw_usd).toBe('12.00000000');
    accounts=(await get('/api/accounts')).accounts;expect(accounts.find((a:any)=>a.email==='existing@example.com').bindings[0].today_usd).toBe('12');
    expect(await db.query('SELECT * FROM ledger')).toHaveLength(0);
  });
});
