import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { normalizeTelemetry,aggregateTelemetry,saveTelemetry } from './telemetry.js';
import { ProviderClient } from './providers.js';
import { openTestDB } from './test-db.js';
import { migrate,type DB,type Row } from './db.js';
import { bootstrap,hashPassword,id,secretBox,today } from './core.js';
import { createApp } from './app.js';
import { createWorker,enqueue } from './worker.js';
import type { FastifyInstance } from 'fastify';

const upstream=(suffix='one')=>({id:suffix,email:`${suffix}@example.com`,status:'active',max_rpm:50,max_tpm:50000,max_concurrent:10,
  req_24h:100,ok_24h:90,limited_24h:4,stats:{daily_cost:'0.125',daily_req:42,daily_tok:12000,rpm:3,tpm:900,concurrent:1,active_sessions:2,
    claude_utilization:{five_hour:{utilization:15,resets_at:new Date().toISOString()},seven_day:{utilization:6}}},
  usage_windows:{req_5h:20,tokens_5h:8000,cost_5h:'0.075',req_7d:300,tokens_7d:110000,cost_7d:'1.25',cost_30d:'5'},
  refresh_token:'never-persist-this',outbound_proxy_url:'http://user:secret@private:8080'});

describe('upstream operational telemetry',()=>{
  it('normalizes only allowlisted metrics and preserves missing versus genuine zero',()=>{
    const a=upstream(),d=normalizeTelemetry('ai008',a);
    expect(d.activity).toEqual({rpm:3,tpm:900,concurrent:1,sessions:2});expect(d.periods.today.requests).toBe(42);
    expect(d.periods['7d'].billedUsd).toBe('1.25');expect(d.cacheTokens).toBeNull();
    expect(JSON.stringify(d)).not.toMatch(/never-persist|private|secret|refresh_token/);
    const missing=normalizeTelemetry('ai008',{stats:{daily_cost:0,rpm:0,tpm:'NaN',daily_req:-1,daily_tok:'Infinity'}});
    expect(missing.activity.rpm).toBe(0);expect(missing.activity.tpm).toBeNull();expect(missing.periods.today.requests).toBeNull();
    expect(missing.periods.today.tokens).toBeNull();expect(missing.periods.today.billedUsd).toBe('0');
  });
  it('retains Gatelink upstream age and account model amounts; never uses global summary',()=>{
    const sourceAt=new Date(Date.now()-3600000).toISOString(),a=upstream();
    const d=normalizeTelemetry('gatelink',{upstreamSyncedAt:sourceAt,upstreamDailyCost:'1.2',upstreamSnapshot:{...a,model_usage:{today:{opus:1,fable:0}}},stats:{rpm:999999}});
    expect(d.sourceAt).toBe(sourceAt);expect(d.activity.rpm).toBe(3);expect(d.periods.today.models).toEqual([{model:'opus',usageUsd:'1'},{model:'fable',usageUsd:'0'}]);
    const totals=aggregateTelemetry([{telemetry:d,fresh:false}],'today');expect(totals.rpm.value).toBeNull();expect(totals.rpm.covered).toBe(0);
  });
  it('handles Mini CC list runtime and detail cost windows without mistaking cache credit USD for tokens',()=>{
    const list=normalizeTelemetry('minicc',{daily_cost:0,live_rpm:4,live_concurrent:2,slots_used:3,req_24h:10,ok_24h:9,cost_7d:'1.1'});
    expect(list.activity).toEqual({rpm:4,tpm:null,concurrent:2,sessions:3});expect(list.periods['7d'].billedUsd).toBe('1.1');
    const d=normalizeTelemetry('minicc',{}, {account:upstream(),stats:upstream().stats,cost_windows:{req_7d:5,tokens_7d:123,cost_7d:1,cost_official_7d:2,cache_credit_loss_7d:'0.4'},modelUsage:{today:{opus:2}},modelUsageAt:new Date().toISOString()});
    expect(d.periods['7d']).toMatchObject({requests:5,tokens:123,billedUsd:'1',officialUsd:'2',cacheCreditUsd:'0.4'});expect(d.cacheTokens).toBeNull();expect(d.periods.today.models[0].usageUsd).toBe('2');
  });
  it('isolates failed or mismatched detail reads and only uses requested account model keys',async()=>{
    const c=new ProviderClient('ai008',{username:'fixture',password:'fixture'},async url=>{
      const p=new URL(String(url));
      if(p.pathname.endsWith('/model-usage'))return Response.json({generated_at:new Date().toISOString(),accounts:{one:{today:{opus:2,fable:0}},other:{today:{opus:9000}}},summary:{today:{opus:9002}}});
      if(p.pathname.endsWith('/two'))return new Response('private upstream token',{status:403});
      return Response.json({account:{...upstream('wrong')},stats:{daily_req:9999}});
    });
    const accounts=[c.normalize(upstream('one')),c.normalize(upstream('two'))];await c.enrichTelemetry(accounts);
    expect(accounts.map(a=>a.telemetry?.periods.today.requests)).toEqual([42,42]);
    expect(accounts[0].telemetry?.periods.today.models).toEqual([{model:'opus',usageUsd:'2'},{model:'fable',usageUsd:'0'}]);
    expect(accounts[1].telemetry?.periods.today.models).toEqual([]);expect(accounts[0].telemetry?.detail).toBe('unavailable');
  });
  it('enriches verified account details and retains delayed model data only as a dated reference',async()=>{
    const c=new ProviderClient('ai008',{username:'fixture',password:'fixture'},async url=>Response.json(String(url).includes('model-usage')?
      {generated_at:new Date(Date.now()-3600000).toISOString(),accounts:{one:{today:{opus:999},seven_day:{opus:999}}}}:
      {account:upstream(),stats:{rpm:9},cost_windows:{req_7d:7,tokens_7d:70,cost_7d:0.7}}));
    const accounts=[c.normalize(upstream())];await c.enrichTelemetry(accounts);
    expect(accounts[0].telemetry?.detail).toBe('available');expect(accounts[0].telemetry?.periods['7d'].requests).toBe(7);expect(accounts[0].telemetry?.periods.today.models).toEqual([{model:'opus',usageUsd:'999'}]);
    const models=aggregateTelemetry([{fresh:true,telemetry:accounts[0].telemetry}],'7d').models;
    expect(models[0]).toMatchObject({value:null,covered:0,reference:{value:'999',covered:1}});expect(models[0].reference.oldestAt).toBe(accounts[0].telemetry?.modelsAt);
    expect(accounts[0].telemetry?.periods.today.requests).toBe(42);expect(accounts[0].telemetry?.activity.rpm).toBe(9);
  });
  it('keeps current model totals separate from mixed fresh and delayed source caches',()=>{
    const fresh=normalizeTelemetry('ai008',upstream()),delayed=structuredClone(fresh);
    fresh.modelsAt=new Date().toISOString();fresh.periods['7d'].models=[{model:'opus',usageUsd:'15'}];
    delayed.modelsAt=new Date(Date.now()-3600000).toISOString();delayed.periods['7d'].models=[{model:'opus',usageUsd:'25'}];
    const result=aggregateTelemetry([{fresh:true,telemetry:fresh},{fresh:true,telemetry:delayed}],'7d');
    expect(result.models[0]).toMatchObject({value:'15',covered:1,total:2,reference:{value:'40',covered:2,total:2,oldestAt:delayed.modelsAt,newestAt:fresh.modelsAt}});
    expect(result.models[1].reference.value).toBeNull();
  });
  it('aggregates partial coverage exactly and excludes previous-day daily counters',()=>{
    const d=normalizeTelemetry('ai008',upstream()),missing=normalizeTelemetry('ai008',{stats:{rpm:0}}),old={...d,day:'2000-01-01'};
    const result=aggregateTelemetry([{telemetry:d,fresh:true},{telemetry:missing,fresh:true},{telemetry:old,fresh:true},{telemetry:d,fresh:false}],'today');
    expect(result.rpm).toEqual({value:'6',covered:3,total:4});expect(result.billedUsd).toEqual({value:'0.125',covered:1,total:4});
    expect(result.requests.value).toBe('42');expect(result.tokens.value).toBe('12000');
  });
  it('excludes a prior-day model cache immediately after Beijing midnight even inside the freshness window',()=>{
    vi.useFakeTimers({toFake:['Date']});
    try {
      vi.setSystemTime(new Date('2026-10-18T16:02:00Z'));const d=normalizeTelemetry('ai008',upstream());
      d.modelsAt='2026-10-18T15:59:00Z';d.periods.today.models=[{model:'opus',usageUsd:'777'}];
      const result=aggregateTelemetry([{telemetry:d,fresh:true}],'today');expect(result.requests.value).toBe('42');expect(result.models[0].value).toBeNull();
      expect(result.models[0].reference.value).toBeNull();
    }finally{vi.useRealTimers();}
  });
});

describe('telemetry ownership, retention and accounting separation',()=>{
  let db:DB,app:FastifyInstance,owner:Row,agent:string,leaf:string,sibling:string,connection:string,cookie:string;
  const password='telemetry-test-password',encryptionKey='45'.repeat(32);
  async function request(url:string,method='GET',payload?:any,authorization?:string){return app.inject({url,method,headers:authorization?{authorization}:{cookie,'x-ccmax-request':'1'},payload});}
  async function account(userId:string|null,email:string,verified=true,providerConnection=connection){
    const aid=id(),bid=id();await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,$4)',[aid,userId,email,verified]);
    await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)',[bid,aid,providerConnection]);
    await saveTelemetry(db,bid,normalizeTelemetry('ai008',upstream()));return {aid,bid};
  }
  beforeEach(async()=>{
    db=await openTestDB();await migrate(db);await bootstrap(db,{ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:password});
    [owner]=await db.query("SELECT * FROM users WHERE role='owner'");agent=id();leaf=id();sibling=id();const hash=await hashPassword(password);
    for(const [uid,parent,email] of [[agent,owner.id,'agent@example.com'],[leaf,agent,'leaf@example.com'],[sibling,owner.id,'sibling@example.com']])await db.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$3,$4)',[uid,parent,email,hash]);
    connection=id();await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','secret-master@example.com',$2,0.5)",[connection,secretBox(encryptionKey).encrypt({username:'secret-master@example.com',password:'secret-upstream'})]);
    await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,0.5,'1970-01-01')",[id(),connection]);
    ({app}=await createApp(db,{encryptionKey,appUrl:'http://localhost:3000'}));
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{'x-ccmax-request':'1'},payload:{email:'agent@example.com',password}});
    cookie=String(login.headers['set-cookie']).split(';')[0];
  });
  afterEach(async()=>{await app.close();await db.close();});
  it('shows self and every downstream level, excluding sibling, unverified and unassigned data from both APIs',async()=>{
    await account(agent,'self@example.com');await account(leaf,'downstream@example.com');await account(sibling,'sibling-secret@example.com');await account(agent,'unverified@example.com',false);await account(null,'unassigned@example.com');
    const response=await request('/api/telemetry'),data=response.json();expect(response.statusCode).toBe(200);expect(data.total).toBe(2);expect(data.totals.rpm.value).toBe('6');expect(data.members).toHaveLength(2);
    expect(response.body).not.toMatch(/secret-master|secret-upstream|sibling-secret|unverified@example|unassigned@example|credentials|external_id/);
    expect((await request('/api/telemetry?scope=self')).json().rows.map((r:any)=>r.email)).toEqual(['self@example.com']);
    expect((await request('/api/telemetry?scope=descendants')).json().rows.map((r:any)=>r.email)).toEqual(['downstream@example.com']);
    const trend=await request('/api/telemetry/trend');expect(trend.json().samples[0].rpm).toBe(6);expect(trend.json().samples[0].rpm_covered).toBe(2);
    expect((await request(`/api/telemetry?ownerId=${sibling}`)).statusCode).toBe(403);expect((await request(`/api/telemetry/trend?ownerId=${sibling}`)).statusCode).toBe(403);
  });
  it('filters and paginates while keeping totals for the complete visible result',async()=>{
    for(let i=0;i<14;i++)await account(leaf,`pool-${String(i).padStart(2,'0')}@example.com`);
    const data=(await request('/api/telemetry?page=2&period=7d')).json();expect(data.rows).toHaveLength(2);expect(data.total).toBe(14);expect(data.totals.requests.value).toBe('4200');expect(data.totals.billedUsd.value).toBe('17.5');
    expect((await request('/api/telemetry?search=pool-03')).json().total).toBe(1);expect((await request('/api/telemetry?provider=gatelink')).json().total).toBe(0);
    expect((await request('/api/telemetry?search=%')).json().total).toBe(0);expect((await request('/api/telemetry?scope=all')).statusCode).toBe(400);
  });
  it('excludes stale and missing accounts from current totals and preserves their last data',async()=>{
    const one=await account(leaf,'stale@example.com'),two=await account(leaf,'missing@example.com');
    const old=normalizeTelemetry('ai008',upstream());old.collectedAt=new Date(Date.now()-3600000).toISOString();old.sourceAt=old.collectedAt;
    // Seed the last successful snapshot as one hour old. A newly received older
    // source is intentionally rejected by saveTelemetry's monotonic guard.
    await db.query('UPDATE binding_telemetry SET collected_at=$2,source_at=$2,data=$3 WHERE binding_id=$1',[one.bid,old.collectedAt,JSON.stringify(old)]);
    await db.query("UPDATE bindings SET status='missing' WHERE id=$1",[two.bid]);
    const data=(await request('/api/telemetry')).json();expect(data.total).toBe(2);expect(data.totals.fresh).toBe(0);expect(data.totals.rpm.value).toBeNull();expect(data.rows[0].telemetry.activity.rpm).toBe(3);
    expect((await db.query('SELECT count(*)::int AS count FROM usage_days'))[0].count).toBe(0);expect((await db.query('SELECT count(*)::int AS count FROM ledger'))[0].count).toBe(0);
  });
  it('deduplicates rate samples and prevents an older response replacing a newer one',async()=>{
    const {bid}=await account(leaf,'samples@example.com'),newer=normalizeTelemetry('ai008',upstream()),older=structuredClone(newer);
    newer.collectedAt=new Date(Date.now()+1000).toISOString();newer.sourceAt=newer.collectedAt;newer.activity.rpm=7;
    older.activity.rpm=2;await saveTelemetry(db,bid,newer);await saveTelemetry(db,bid,older);
    const staleSource=structuredClone(older);staleSource.collectedAt=new Date(Date.now()+2000).toISOString();await saveTelemetry(db,bid,staleSource);
    expect((await db.query('SELECT data FROM binding_telemetry WHERE binding_id=$1',[bid]))[0].data.activity.rpm).toBe(7);
    const rows=await db.query('SELECT rpm FROM telemetry_samples WHERE binding_id=$1 ORDER BY bucket_at DESC',[bid]);expect(rows[0].rpm).toBe(7);
  });
  it('allows read-scoped integration keys with the same account boundaries and never fetches upstream on reads',async()=>{
    await account(leaf,'key-owned@example.com');await account(sibling,'key-hidden@example.com');
    const issued=await request('/api/settings/api-keys','POST',{name:'telemetry test',scopes:['read'],expiresInDays:30,currentPassword:password});
    expect(issued.statusCode).toBe(200);const authorization=`Bearer ${issued.json().token}`;
    for(const path of ['/api/telemetry','/api/telemetry/trend']){const r=await request(path,'GET',undefined,authorization);expect(r.statusCode,r.body).toBe(200);expect(r.json().total).toBe(1);}
    expect((await db.query('SELECT count(*)::int AS count FROM jobs'))[0].count).toBe(0);
  });
  it('persists telemetry during the real sync path without creating financial finalizations',async()=>{
    const box=secretBox(encryptionKey),real=await account(owner.id,'one@example.com');await db.query("UPDATE bindings SET external_id='one' WHERE id=$1",[real.bid]);
    const c=new ProviderClient('ai008',{username:'fixture',password:'fixture'},async url=>{
      if(String(url).includes('admin-login'))return Response.json({accessToken:'fixture',user:{role:'admin'}});
      if(String(url).includes('model-usage'))return Response.json({accounts:{},generated_at:new Date().toISOString()});
      if(String(url).includes('oauth-accounts?'))return Response.json({accounts:[upstream()],pagination:{total_pages:1}});
      return new Response('unavailable',{status:403});
    });
    await enqueue(db,box,owner.id,connection,'sync',{},'telemetry-sync-test');const worker=createWorker(db,box,()=>c);await worker.runOne();
    const [job]=await db.query('SELECT state,error FROM jobs');expect(job.state,job.error).toBe('succeeded');
    expect((await db.query('SELECT data FROM binding_telemetry WHERE binding_id=$1',[real.bid]))[0].data.periods.today.requests).toBe(42);
    const [usage]=await db.query('SELECT raw_usd,state,day FROM usage_days');expect(usage).toMatchObject({raw_usd:'0.12500000',state:'provisional',day:today()});
    expect((await db.query('SELECT count(*)::int AS count FROM ledger'))[0].count).toBe(0);
  });
});
