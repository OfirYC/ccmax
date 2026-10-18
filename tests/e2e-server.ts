import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { openDB,migrate } from '../server/db.js';
import { bootstrap,hashPassword,id,secretBox,today } from '../server/core.js';
import { createApp } from '../server/app.js';
import { saveBinding } from '../server/worker.js';
import { ingestUsage } from '../server/billing.js';
import { createDailyInvoices } from '../server/daily-billing.js';
import { normalizeTelemetry,saveTelemetry } from '../server/telemetry.js';
const db=await openDB();await migrate(db);
await bootstrap(db,{ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'e2e-owner-password'});
const [owner]=await db.query("SELECT * FROM users WHERE role='owner'"),agent=id(),leaf=id(),acct=id(),box=secretBox('ab'.repeat(32));
const password=await hashPassword('e2e-agent-password');
await db.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$4,$5)',[agent,owner.id,'agent@example.com','测试代理',password]);
await db.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$4,$5)',[leaf,agent,'leaf@example.com','测试下级',password]);
const day=new Date(Date.parse(today()+'T00:00:00Z')-86400000).toISOString().slice(0,10);
await db.query("INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,'claude-fixture@example.com',true)",[acct,leaf]);
for(const [provider,rate] of [['gatelink','0.5'],['ai008','0.6']]) {
 const [c]=await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate,status) VALUES($1,$2,$5,$3,$4,'connected') RETURNING *",[id(),provider,box.encrypt({username:'fixture',password:'fixture'}),rate,`private-upstream-${provider}@example.com`]);
 await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,$3,'1970-01-01')",[id(),c.id,rate]);
 for(const [user,rate] of [[agent,'0.3'],[leaf,'0.1']])await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,'1970-01-01',$5)",[id(),user,provider,rate,owner.id]);
 const b=await db.transaction(tx=>saveBinding(tx,c,{id:'fixture-'+provider,email:'claude-fixture@example.com',name:'fixture',status:'active',dailyUsd:'100',cost7d:null,cost30d:null,utilization:null}));
 const snapshot=normalizeTelemetry('ai008',{stats:{daily_cost:100,daily_req:120,daily_tok:42000,rpm:4,tpm:1200,concurrent:1},max_rpm:50,max_tpm:50000,
   req_24h:150,ok_24h:144,limited_24h:3,usage_windows:{req_7d:720,tokens_7d:252000,cost_7d:600}});
 snapshot.modelsAt=new Date().toISOString();snapshot.periods.today.models=[{model:'opus',usageUsd:'80'},{model:'fable',usageUsd:'20'}];
 await saveTelemetry(db,b.id,snapshot);
 await db.query(`INSERT INTO telemetry_samples(binding_id,bucket_at,source_at,rpm,tpm,concurrent)
   VALUES($1,date_trunc('hour',now())-interval '1 hour',now()-interval '1 hour',2,600,0)`,[b.id]);
 await db.transaction(tx=>ingestUsage(tx,{bindingId:b.id,day,rawUsd:'100',final:true,source:'e2e-fixture'}));
}
await createDailyInvoices(db,owner,day);
const mini=id();
await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate,status) VALUES($1,'minicc','Mini CC Test',$2,0.7,'connected')",[mini,box.encrypt({username:'fixture',password:'fixture'})]);
await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,0.7,'1970-01-01')",[id(),mini]);
for(const [user,rate] of [[agent,'0.3'],[leaf,'0.1']])await db.query("INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'minicc',$3,'1970-01-01',$4)",[id(),user,rate,owner.id]);
const host=process.env.E2E_HOST||'127.0.0.1',port=Number(process.env.E2E_PORT)||4319;
const {app}=await createApp(db,{encryptionKey:'ab'.repeat(32),appUrl:`http://${host.includes(':')?`[${host}]`:host}:${port}`,production:true});
await app.register(fastifyStatic,{root:path.resolve('dist/client'),wildcard:false});
app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'接口不存在'}):reply.sendFile('index.html'));
await app.listen({host,port});
async function stop(){await app.close();await db.close();process.exit(0);}process.on('SIGTERM',stop);process.on('SIGINT',stop);
