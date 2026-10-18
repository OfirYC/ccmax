import 'dotenv/config';
import path from 'node:path';
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import { bootstrap, assert, id } from './core.js';
import { openDB, migrate } from './db.js';
import { createApp } from './app.js';
import { createWorker, enqueue } from './worker.js';

const prod=process.env.NODE_ENV==='production';
const appUrl=process.env.APP_URL||(process.env.RAILWAY_PUBLIC_DOMAIN?`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`:undefined);
assert(!prod||(appUrl && new URL(appUrl).protocol==='https:'),'生产环境必须配置 HTTPS 的 APP_URL 或 Railway 公网域名',500);
assert(process.env.DATABASE_URL||(!prod&&process.env.ALLOW_LOCAL_DB==='true'),'生产环境必须设置 DATABASE_URL；本地开发需明确开启 ALLOW_LOCAL_DB',500);
const db=await openDB(process.env.DATABASE_URL,process.env.LOCAL_DB_PATH||'.local/database');
await migrate(db);await bootstrap(db,process.env);
assert(process.env.ENCRYPTION_KEY,'生产或本地启动都必须设置 ENCRYPTION_KEY',500);
const {app,box}=await createApp(db,{encryptionKey:process.env.ENCRYPTION_KEY,appUrl:appUrl||'http://localhost:3000',production:prod,logger:true});
const worker=createWorker(db,box);
await worker.recover();
let vite:any;
if(!prod) {
  const {createServer}=await import('vite');
  vite=await createServer({server:{middlewareMode:true},appType:'spa'});
  app.setNotFoundHandler(async(req,reply)=>{
    if(req.url.startsWith('/api/')) return reply.code(404).send({error:'接口不存在'});
    reply.hijack();vite.middlewares(req.raw,reply.raw);
  });
} else {
  const root=path.resolve('dist/client');assert(existsSync(root),'前端构建产物不存在',500);
  await app.register(fastifyStatic,{root,wildcard:false});
  app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'接口不存在'}):reply.sendFile('index.html'));
}
const workTimer=setInterval(()=>{worker.tick().catch(e=>app.log.error(e));},1000);
let scheduling=false;
async function scheduleSync() {
  if(scheduling)return;scheduling=true;
  try {
    await worker.recover();
    const [owner]=await db.query(`SELECT id FROM users WHERE role='owner'`);
    const connections=await db.query('SELECT id FROM connections WHERE enabled=true');
    for(const c of connections) await enqueue(db,box,owner.id,c.id,'sync',{},id());
  } finally{scheduling=false;}
}
const syncTimer=setInterval(()=>{scheduleSync().catch(e=>app.log.error(e));},Math.max(60,Number(process.env.SYNC_INTERVAL_SECONDS)||300)*1000);
await app.listen({host:process.env.HOST||'0.0.0.0',port:Number(process.env.PORT)||3000});
await scheduleSync();
let shuttingDown=false;
async function shutdown() {
  if(shuttingDown)return;shuttingDown=true;
  clearInterval(workTimer);clearInterval(syncTimer);worker.stop();
  await app.close();
  // Give an in-flight external mutation time to finish and commit its result.
  const deadline=Date.now()+28000;
  while(worker.isBusy()&&Date.now()<deadline) await new Promise(r=>setTimeout(r,250));
  if(vite) await vite.close();await db.close();process.exit(0);
}
process.on('SIGTERM',()=>{shutdown().catch(()=>process.exit(1));});process.on('SIGINT',()=>{shutdown().catch(()=>process.exit(1));});
