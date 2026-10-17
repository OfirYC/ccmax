import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { createHash, randomBytes } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { DB, Row } from './db.js';
import { AppError, assert, audit, dayString, hashPassword, id, nextDay, requireDirect, requireOwner, secretBox, subtree, today, verifyPassword } from './core.js';
import { balance, confirmInvoice, createInvoice, csv, ingestUsage, requestWithdrawal, reviewWithdrawal } from './billing.js';
import { enqueue } from './worker.js';
import { PROVIDERS, ProviderClient } from './providers.js';

declare module 'fastify' { interface FastifyRequest { user: Row; } }
const identifier=z.string().uuid();
const provider=z.enum(['gatelink','ai008']);
const money=z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/,'请输入最多 8 位小数的美元金额');
const rate=z.coerce.number().min(0).max(1).multipleOf(0.0001);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v)) && new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v,'日期无效');
const email=z.email().max(200).transform(v=>v.toLowerCase());
const password=z.string().min(12,'密码至少 12 位').max(200);
const key=z.string().min(8).max(100);
const publicUser=(u:Row)=>({id:u.id,name:u.name,email:u.email,role:u.role,parent_id:u.parent_id,active:u.active,created_at:u.created_at});
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const optionSchema=z.object({proxy:z.string().max(2000).optional(),accountType:z.enum(['speed','stable','team','max','pro']).optional(),policyTemplateId:z.string().max(100).optional(),groupIds:z.array(z.string().max(100)).max(30).optional(),ccTemplateId:z.string().max(100).optional()});

export async function createApp(db:DB,config:{encryptionKey:string;appUrl:string;production?:boolean;logger?:boolean}) {
  const box=secretBox(config.encryptionKey);
  const app=Fastify({logger:config.logger??false,trustProxy:true,bodyLimit:1024*1024});
  await app.register(cookie);
  await app.register(rateLimit,{max:240,timeWindow:'1 minute'});
  app.decorateRequest('user');
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof ZodError) return reply.code(400).send({error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；')});
    if(error instanceof AppError) return reply.code(error.statusCode).send({error:error.message});
    const status=(error as any).statusCode;
    if(status===429) return reply.code(429).send({error:'请求过于频繁，请稍后再试'});
    if(status===400||status===413) return reply.code(status).send({error:'请求格式错误或内容过大'});
    const code=(error as any).code;
    if(['23505','23503'].includes(code)) return reply.code(409).send({error:'记录已存在、归属冲突或依赖状态发生变化，请刷新后重试'});
    request.log.error({err:error},'Request failed');
    reply.code(500).send({error:'服务器处理失败，请联系管理员核对记录',requestId:request.id});
  });
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('X-Frame-Options','DENY');
    if(config.production) reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const path=request.url.split('?')[0];
    if(!path.startsWith('/api/')) return;
    reply.header('Cache-Control','no-store');
    if(!['GET','HEAD','OPTIONS'].includes(request.method)) {
      assert(request.headers['x-ccmax-request']==='1','请求缺少 CSRF 防护标记',403);
      if(request.headers.origin) assert(request.headers.origin===new URL(config.appUrl).origin,'请求来源不允许',403);
    }
    if(path==='/api/auth/login') return;
    const sid=request.cookies.ccmax_session;
    assert(sid,'请先登录',401);
    const [session]=await db.query('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now()',[digest(sid)]);
    assert(session?.active,'登录已过期或账号已停用',401);
    const [disabled]=await db.query(`WITH RECURSIVE chain AS (SELECT id,parent_id,active FROM users WHERE id=$1 UNION ALL SELECT u.id,u.parent_id,u.active FROM users u JOIN chain c ON c.parent_id=u.id) SELECT id FROM chain WHERE active=false LIMIT 1`,[session.id]);
    assert(!disabled,'所属团队已停用',403);
    request.user=session;
  });
  app.get('/health',async()=>{await db.query('SELECT 1');return {status:'ok',service:'ccmax'};});
  app.post('/api/auth/login',{config:{rateLimit:{max:8,timeWindow:'1 minute'}}},async(req,reply)=>{
    const data=z.object({email,password:z.string().min(1).max(200)}).parse(req.body);
    const [user]=await db.query('SELECT * FROM users WHERE email=$1',[data.email]);
    const hash=user?.password_hash??'c892c3b24dbb419f829bb1e0ad47f258:'+ '0'.repeat(128);
    const valid=await verifyPassword(data.password,hash);
    assert(user && valid && user.active,'邮箱或密码错误，或账号已停用',401);
    const session=randomBytes(32).toString('base64url');
    await db.query('INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,$3)',[digest(session),user.id,new Date(Date.now()+7*86400000)]);
    reply.setCookie('ccmax_session',session,{path:'/',httpOnly:true,sameSite:'strict',secure:!!config.production,maxAge:7*86400});
    await audit(db,user.id,'auth.login',user.id);
    return {user:publicUser(user)};
  });
  app.get('/api/auth/me',async req=>({user:publicUser(req.user),today:today()}));
  app.post('/api/auth/logout',async(req,reply)=>{await db.query('DELETE FROM sessions WHERE id=$1',[digest(req.cookies.ccmax_session!)]);reply.clearCookie('ccmax_session',{path:'/'});return {ok:true};});
  app.post('/api/auth/password',async req=>{
    const d=z.object({currentPassword:z.string().max(200),newPassword:password}).parse(req.body);
    assert(await verifyPassword(d.currentPassword,req.user.password_hash),'当前密码错误');
    const hash=await hashPassword(d.newPassword);
    await db.transaction(async tx=>{await tx.query('UPDATE users SET password_hash=$2 WHERE id=$1',[req.user.id,hash]);await tx.query('DELETE FROM sessions WHERE user_id=$1 AND id<>$2',[req.user.id,digest(req.cookies.ccmax_session!)]);await audit(tx,req.user.id,'auth.password',req.user.id);});
    return {ok:true};
  });

  app.get('/api/team',async req=>{
    const ids=await subtree(db,req.user.id);
    const users=await db.query(`SELECT u.id,u.parent_id,u.name,u.email,u.role,u.active,u.created_at,p.name AS parent_name,
      (SELECT count(*) FROM accounts a WHERE a.owner_id=u.id) AS account_count FROM users u LEFT JOIN users p ON p.id=u.parent_id WHERE u.id=ANY($1::text[]) ORDER BY u.created_at`,[ids]);
    const rates=await db.query(`SELECT DISTINCT ON(user_id,provider) user_id,provider,rate,effective_date FROM rates WHERE user_id=ANY($1::text[]) AND effective_date<=$2 ORDER BY user_id,provider,effective_date DESC`,[ids,today()]);
    const upcoming=await db.query(`SELECT user_id,provider,rate,effective_date FROM rates WHERE user_id=ANY($1::text[]) AND effective_date>$2`,[ids,today()]);
    return {users,rates,upcoming};
  });
  app.post('/api/team',async req=>{
    const d=z.object({name:z.string().trim().min(1).max(80),email,password,rates:z.object({gatelink:rate,ai008:rate})}).parse(req.body);
    const hash=await hashPassword(d.password),userId=id();
    return db.transaction(async tx=>{
      const [u]=await tx.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING *',[userId,req.user.id,d.email,d.name,hash]);
      for(const p of ['gatelink','ai008'] as const) await tx.query('INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id(),userId,p,d.rates[p],today(),req.user.id]);
      await audit(tx,req.user.id,'team.create',userId,{name:d.name});return {user:publicUser(u)};
    });
  });
  app.patch('/api/team/:id',async req=>{
    const target=identifier.parse((req.params as Row).id);
    const d=z.object({active:z.boolean().optional(),newPassword:password.optional()}).refine(d=>d.active!==undefined||!!d.newPassword).parse(req.body);
    const hash=d.newPassword?await hashPassword(d.newPassword):undefined;
    await db.transaction(async tx=>{
      await requireDirect(tx,req.user,target);
      if(d.active!==undefined) await tx.query('UPDATE users SET active=$2 WHERE id=$1',[target,d.active]);
      if(hash) {await tx.query('UPDATE users SET password_hash=$2 WHERE id=$1',[target,hash]);await tx.query('DELETE FROM sessions WHERE user_id=$1',[target]);}
      await audit(tx,req.user.id,hash?'team.password':'team.status',target,{active:d.active});
    });return {ok:true};
  });
  app.put('/api/team/:id/rates',async req=>{
    const target=identifier.parse((req.params as Row).id);
    const d=z.object({provider,rate}).parse(req.body);
    return db.transaction(async tx=>{
      await requireDirect(tx,req.user,target);
      await tx.query(`INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(user_id,provider,effective_date) DO UPDATE SET rate=EXCLUDED.rate,created_by=EXCLUDED.created_by,created_at=now()`,[id(),target,d.provider,d.rate,nextDay(),req.user.id]);
      await audit(tx,req.user.id,'rate.update',target,{...d,effectiveDate:nextDay()});return {effectiveDate:nextDay()};
    });
  });

  app.get('/api/connections',async req=>{
    const current=today();
    const rows=await db.query(`SELECT c.id,c.provider,c.name,c.enabled,c.status,c.last_error,c.last_sync_at,
      COALESCE((SELECT r.rate FROM connection_rates r WHERE r.connection_id=c.id AND r.effective_date<=$1 ORDER BY r.effective_date DESC LIMIT 1),c.payout_rate) AS payout_rate,
      (SELECT r.rate FROM connection_rates r WHERE r.connection_id=c.id AND r.effective_date>$1 ORDER BY r.effective_date LIMIT 1) AS upcoming_payout_rate,
      (SELECT r.effective_date FROM connection_rates r WHERE r.connection_id=c.id AND r.effective_date>$1 ORDER BY r.effective_date LIMIT 1) AS upcoming_payout_date
      FROM connections c ORDER BY c.created_at`,[current]);
    return {connections:rows.map(({payout_rate,last_error,upcoming_payout_rate,upcoming_payout_date,...c})=>({...c,...(req.user.role==='owner'?{payout_rate,last_error,upcoming_payout_rate,upcoming_payout_date}:{}),capabilities:PROVIDERS[c.provider as keyof typeof PROVIDERS]})),providers:PROVIDERS};
  });
  app.post('/api/connections',async req=>{
    await requireOwner(req.user);
    const d=z.object({provider,name:z.string().trim().min(1).max(80),username:z.string().min(1).max(200),password:z.string().min(1).max(500),payoutRate:rate}).parse(req.body);
    const connectionId=id();
    await db.transaction(async tx=>{
      await tx.query('INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,$2,$3,$4,$5)',[connectionId,d.provider,d.name,box.encrypt({username:d.username,password:d.password}),d.payoutRate]);
      await tx.query('INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5)',[id(),connectionId,d.payoutRate,today(),req.user.id]);
      await audit(tx,req.user.id,'connection.create',connectionId,{provider:d.provider});
    });
    const job=await enqueue(db,box,req.user.id,connectionId,'sync',{},id());
    return {id:connectionId,job};
  });
  app.patch('/api/connections/:id',async req=>{
    await requireOwner(req.user);const target=identifier.parse((req.params as Row).id);
    const d=z.object({enabled:z.boolean().optional(),payoutRate:rate.optional(),username:z.string().max(200).optional(),password:z.string().min(1).max(500).optional(),name:z.string().trim().min(1).max(80).optional()}).parse(req.body);
    await db.transaction(async tx=>{
      const [c]=await tx.query('SELECT * FROM connections WHERE id=$1 FOR UPDATE',[target]);assert(c,'平台连接不存在',404);
      const credentials=box.decrypt(c.credentials);
      await tx.query('UPDATE connections SET enabled=$2,credentials=$3,name=$4 WHERE id=$1',[target,d.enabled??c.enabled,box.encrypt({username:d.username??credentials.username,password:d.password??credentials.password}),d.name??c.name]);
      if(d.payoutRate!==undefined) {
        await tx.query(`INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(connection_id,effective_date) DO UPDATE SET rate=EXCLUDED.rate,created_by=EXCLUDED.created_by,created_at=now()`,[id(),target,d.payoutRate,nextDay(),req.user.id]);
      }
      await audit(tx,req.user.id,'connection.update',target,{enabled:d.enabled,payoutRate:d.payoutRate});
    });return {ok:true};
  });
  app.get('/api/connections/:id/options',async req=>{
    const target=identifier.parse((req.params as Row).id),[c]=await db.query('SELECT * FROM connections WHERE id=$1 AND enabled=true',[target]);assert(c,'平台连接不存在或已停用',404);
    const client=new ProviderClient(c.provider,box.decrypt(c.credentials));await client.login();return client.options();
  });
  app.post('/api/connections/sync',async req=>{
    await requireOwner(req.user);const d=z.object({connectionIds:z.array(identifier).min(1).max(20),key}).parse(req.body);
    const jobs=[];
    for(const c of [...new Set(d.connectionIds)]) {const [row]=await db.query('SELECT id FROM connections WHERE id=$1 AND enabled=true',[c]);assert(row,'连接不存在或已停用');jobs.push(await enqueue(db,box,req.user.id,c,'sync',{},d.key));}
    return {jobs};
  });
  app.post('/api/connections/:id/reconcile',async req=>{
    await requireOwner(req.user);const target=identifier.parse((req.params as Row).id),d=z.object({day:date,key}).parse(req.body);assert(d.day<today(),'只能对账已结束日期');
    const [c]=await db.query('SELECT provider FROM connections WHERE id=$1 AND enabled=true',[target]);assert(c?.provider==='ai008','仅 AI008 提供已核验的历史查询接口');
    return enqueue(db,box,req.user.id,target,'reconcile',{day:d.day},d.key);
  });

  app.get('/api/accounts',async req=>{
    const ids=await subtree(db,req.user.id),root=req.user.role==='owner';
    const accounts=await db.query(`SELECT a.*,u.name AS owner_name FROM accounts a LEFT JOIN users u ON u.id=a.owner_id
      WHERE a.owner_id=ANY($1::text[]) OR ($2::boolean AND a.owner_id IS NULL) ORDER BY a.created_at DESC`,[ids,root]);
    const bindings=await db.query(`SELECT b.*,c.provider,c.name AS connection_name FROM bindings b JOIN connections c ON c.id=b.connection_id JOIN accounts a ON a.id=b.account_id
      WHERE a.owner_id=ANY($1::text[]) OR ($2::boolean AND a.owner_id IS NULL)`,[ids,root]);
    return {accounts:accounts.map(a=>({...a,bindings:bindings.filter(b=>b.account_id===a.id)}))};
  });
  app.post('/api/accounts',async req=>{
    const d=z.object({email,label:z.string().max(100).default('')}).parse(req.body);
    const [existing]=await db.query('SELECT * FROM accounts WHERE email=$1',[d.email]);
    if(existing) {assert(existing.owner_id===req.user.id,'该账号已存在，请联系管理员核对归属',409);return {account:existing};}
    const [account]=await db.query('INSERT INTO accounts(id,owner_id,submitted_by,email,label) VALUES($1,$2,$2,$3,$4) RETURNING *',[id(),req.user.id,d.email,d.label]);
    await audit(db,req.user.id,'account.create',account.id);return {account};
  });
  app.post('/api/accounts/:id/assign',async req=>{
    await requireOwner(req.user);const target=identifier.parse((req.params as Row).id),d=z.object({userId:identifier}).parse(req.body);
    await db.transaction(async tx=>{
      const [a]=await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[target]);assert(a && !a.owner_id,'只有待归属账号可分配；已归属账号不可随意改挂团队',409);
      const [u]=await tx.query('SELECT id FROM users WHERE id=$1 AND active=true',[d.userId]);assert(u,'用户不存在或已停用');
      await tx.query('UPDATE accounts SET owner_id=$2 WHERE id=$1',[target,d.userId]);await audit(tx,req.user.id,'account.assign',target,{userId:d.userId});
    });return {ok:true};
  });
  app.post('/api/accounts/:id/authorize',async req=>{
    const accountId=identifier.parse((req.params as Row).id);
    const d=z.object({targets:z.array(z.object({connectionId:identifier,options:optionSchema})).min(1).max(10),key}).parse(req.body);
    const [a]=await db.query('SELECT * FROM accounts WHERE id=$1 AND owner_id=$2',[accountId,req.user.id]);assert(a,'只能为自己名下的账号上号',403);
    const jobs=[];
    for(const t of d.targets) {
      const [c]=await db.query('SELECT id FROM connections WHERE id=$1 AND enabled=true',[t.connectionId]);assert(c,'连接不存在或已停用');
      const [b]=await db.query('SELECT id FROM bindings WHERE account_id=$1 AND connection_id=$2',[accountId,c.id]);assert(!b,'此账号已在所选平台上号，不能重复提交',409);
      jobs.push(await enqueue(db,box,req.user.id,c.id,'oauth_start',{accountId,options:t.options},d.key));
    }return {jobs};
  });
  app.get('/api/accounts/:id/attempts',async req=>{
    const accountId=identifier.parse((req.params as Row).id);
    const [a]=await db.query('SELECT id FROM accounts WHERE id=$1 AND owner_id=$2',[accountId,req.user.id]);assert(a,'账号不存在',404);
    return {attempts:await db.query(`SELECT o.id,o.connection_id,o.authorization_url,o.state,o.expires_at,c.name AS connection_name
      FROM oauth_attempts o JOIN connections c ON c.id=o.connection_id WHERE o.account_id=$1 AND o.user_id=$2 ORDER BY o.created_at DESC LIMIT 30`,[accountId,req.user.id])};
  });
  app.post('/api/oauth/:id/exchange',async req=>{
    const attemptId=identifier.parse((req.params as Row).id),d=z.object({callback:z.string().trim().min(1).max(8000),key}).parse(req.body);
    return db.transaction(async tx=>{
      const [a]=await tx.query('SELECT * FROM oauth_attempts WHERE id=$1 AND user_id=$2 FOR UPDATE',[attemptId,req.user.id]);assert(a,'授权流程不存在',404);
      const [previous]=await tx.query(`SELECT id,state FROM jobs WHERE requested_by=$1 AND kind='oauth_exchange' AND connection_id=$2 AND idempotency_key=$3`,[req.user.id,a.connection_id,d.key]);if(previous)return previous;
      assert(a.state==='pending' && new Date(a.expires_at)>new Date(),'授权已过期或已经提交，请核对任务状态',409);
      await tx.query(`UPDATE oauth_attempts SET state='exchanging' WHERE id=$1`,[a.id]);
      return enqueue(tx,box,req.user.id,a.connection_id,'oauth_exchange',{attemptId,callback:d.callback},d.key);
    });
  });
  app.post('/api/accounts/:id/import-token',async req=>{
    const accountId=identifier.parse((req.params as Row).id),d=z.object({connectionId:identifier,refreshToken:z.string().trim().min(10).max(10000),options:optionSchema,key}).parse(req.body);
    const [a]=await db.query('SELECT id FROM accounts WHERE id=$1 AND owner_id=$2',[accountId,req.user.id]);assert(a,'只能为自己名下账号上号',403);
    const [c]=await db.query(`SELECT * FROM connections WHERE id=$1 AND enabled=true AND provider='ai008'`,[d.connectionId]);assert(c,'此平台不支持 RT 导入');
    const [bound]=await db.query('SELECT id FROM bindings WHERE account_id=$1 AND connection_id=$2',[accountId,c.id]);assert(!bound,'账号已绑定到此平台',409);
    return enqueue(db,box,req.user.id,c.id,'import_rt',{accountId,options:d.options,refreshToken:d.refreshToken},d.key);
  });
  app.post('/api/bindings/:id/status',async req=>{
    const bindingId=identifier.parse((req.params as Row).id),d=z.object({enabled:z.boolean(),key}).parse(req.body);
    const [b]=await db.query('SELECT b.*,a.owner_id FROM bindings b JOIN accounts a ON a.id=b.account_id WHERE b.id=$1',[bindingId]);
    assert(b && (b.owner_id===req.user.id||req.user.role==='owner'),'不能操作该账号',403);
    return enqueue(db,box,req.user.id,b.connection_id,'set_enabled',{bindingId,enabled:d.enabled},d.key);
  });

  app.get('/api/jobs',async req=>{
    const q=z.object({id:identifier.optional()}).parse(req.query);
    const jobs=await db.query(`SELECT j.id,j.connection_id,j.requested_by,j.kind,j.state,j.result,j.error,j.created_at,j.completed_at,c.name AS connection_name
      FROM jobs j JOIN connections c ON c.id=j.connection_id WHERE (j.requested_by=$1 OR $2::boolean) AND ($3::text IS NULL OR j.id=$3) ORDER BY j.created_at DESC LIMIT 100`,[req.user.id,req.user.role==='owner',q.id??null]);
    // OAuth URLs belong only to the submitting user, including in admin views.
    return {jobs:jobs.map(j=>j.kind==='oauth_start' && j.requested_by!==req.user.id?{...j,result:null}:j)};
  });
  async function usageRows(user:Row,query:any) {
    const q=z.object({from:date.optional(),to:date.optional(),provider:provider.optional()}).parse(query);
    const ids=await subtree(db,user.id);
    return db.query(`SELECT u.id,u.day,u.raw_usd,u.state,u.source,u.evidence,u.updated_at,b.id AS binding_id,c.provider,c.name AS connection_name,
      a.email,a.owner_id,o.name AS owner_name,e.rate,e.gross_usd,e.downstream_usd,e.profit_usd
      FROM usage_days u JOIN bindings b ON b.id=u.binding_id JOIN connections c ON c.id=b.connection_id
      JOIN accounts a ON a.id=b.account_id LEFT JOIN users o ON o.id=a.owner_id
      LEFT JOIN earnings e ON e.usage_id=u.id AND e.user_id=$1
      WHERE (a.owner_id=ANY($2::text[]) OR ($3::boolean AND a.owner_id IS NULL)) AND ($4::date IS NULL OR u.day>=$4) AND ($5::date IS NULL OR u.day<=$5)
      AND ($6::text IS NULL OR c.provider=$6) ORDER BY u.day DESC,a.email LIMIT 10000`,[user.id,ids,user.role==='owner',q.from??null,q.to??null,q.provider??null]);
  }
  app.get('/api/usage',async req=>({rows:await usageRows(req.user,req.query)}));
  app.get('/api/usage/export',async(req,reply)=>{const rows=await usageRows(req.user,req.query);return reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="ccmax-usage.csv"').send(csv(rows,[['day','日期（北京时间）'],['email','账号'],['connection_name','平台'],['raw_usd','平台账单 USD'],['rate','结算折扣'],['gross_usd','我的应收 USD'],['downstream_usd','下级应付 USD'],['profit_usd','我的利润 USD'],['state','核实状态']]));});
  app.post('/api/usage/import',async req=>{
    await requireOwner(req.user);
    const d=z.object({evidence:z.string().trim().min(5).max(2000),rows:z.array(z.object({bindingId:identifier,day:date,rawUsd:money})).min(1).max(1000)}).parse(req.body);
    return db.transaction(async tx=>{
      for(const row of d.rows) await ingestUsage(tx,{...row,final:true,source:'reviewed_statement',evidence:d.evidence});
      await audit(tx,req.user.id,'usage.finalize',undefined,{count:d.rows.length,evidence:d.evidence});return {count:d.rows.length};
    });
  });
  app.get('/api/dashboard',async req=>{
    const ids=await subtree(db,req.user.id);
    const [accounts]=await db.query('SELECT count(*) AS total FROM accounts WHERE owner_id=ANY($1::text[])',[ids]);
    const [team]=await db.query('SELECT count(*) AS total FROM users WHERE id=ANY($1::text[]) AND id<>$2',[ids,req.user.id]);
    const [totals]=await db.query(`SELECT COALESCE(sum(u.raw_usd),0) AS raw_usd,COALESCE(sum(e.gross_usd),0) AS gross_usd,COALESCE(sum(e.downstream_usd),0) AS downstream_usd,COALESCE(sum(e.profit_usd),0) AS profit_usd,
      COALESCE(sum(CASE WHEN u.state='final' THEN e.profit_usd ELSE 0 END),0) AS final_profit FROM earnings e JOIN usage_days u ON u.id=e.usage_id WHERE e.user_id=$1`,[req.user.id]);
    const daily=await db.query(`SELECT u.day,sum(u.raw_usd) AS raw_usd,sum(e.gross_usd) AS gross_usd,sum(e.profit_usd) AS profit_usd
      FROM earnings e JOIN usage_days u ON u.id=e.usage_id WHERE e.user_id=$1 GROUP BY u.day ORDER BY u.day DESC LIMIT 14`,[req.user.id]);
    const platforms=await db.query(`SELECT c.provider,c.name,c.status,c.last_sync_at,count(b.id) AS account_count,COALESCE(sum(b.daily_usd),0) AS daily_usd
      FROM connections c LEFT JOIN bindings b ON b.connection_id=c.id LEFT JOIN accounts a ON a.id=b.account_id
      WHERE c.enabled=true AND (a.owner_id=ANY($1::text[]) OR b.id IS NULL OR $2::boolean) GROUP BY c.id ORDER BY c.created_at`,[ids,req.user.role==='owner']);
    const [pending]=await db.query(`SELECT count(*) AS total FROM withdrawals WHERE payer_id=$1 AND state='pending'`,[req.user.id]);
    const [unassigned]=req.user.role==='owner'?await db.query('SELECT count(*) AS total FROM accounts WHERE owner_id IS NULL'):[{total:0}];
    return {totals,accounts:Number(accounts.total),team:Number(team.total),balance:await balance(db,req.user.id),daily:daily.reverse(),platforms,pendingWithdrawals:Number(pending.total),unassigned:Number(unassigned.total)};
  });
  app.get('/api/finance',async req=>{
    const invoices=await db.query(`SELECT i.*,u.name AS user_name,p.name AS payer_name FROM invoices i JOIN users u ON u.id=i.user_id LEFT JOIN users p ON p.id=i.payer_id
      WHERE i.user_id=$1 OR i.payer_id=$1 ORDER BY i.created_at DESC LIMIT 500`,[req.user.id]);
    const withdrawals=await db.query(`SELECT w.*,u.name AS user_name FROM withdrawals w JOIN users u ON u.id=w.user_id
      WHERE w.user_id=$1 OR w.payer_id=$1 ORDER BY w.created_at DESC LIMIT 500`,[req.user.id]);
    const ledger=await db.query('SELECT * FROM ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500',[req.user.id]);
    return {balance:await balance(db,req.user.id),invoices,withdrawals,ledger};
  });
  app.post('/api/invoices',async req=>{
    const d=z.object({userId:identifier,from:date,to:date}).parse(req.body);return createInvoice(db,req.user,d.userId,d.from,d.to);
  });
  app.post('/api/invoices/:id/confirm',async req=>{
    const d=z.object({reference:z.string().trim().min(3).max(500)}).parse(req.body);return confirmInvoice(db,req.user,identifier.parse((req.params as Row).id),d.reference);
  });
  app.get('/api/invoices/:id/export',async(req,reply)=>{
    const invoiceId=identifier.parse((req.params as Row).id),[inv]=await db.query('SELECT * FROM invoices WHERE id=$1',[invoiceId]);assert(inv&&(inv.user_id===req.user.id||inv.payer_id===req.user.id),'无权查看账单',403);
    const items=await db.query(`SELECT u.day,a.email,c.name AS platform,u.raw_usd,e.rate,e.gross_usd,e.downstream_usd,e.profit_usd FROM invoice_items i JOIN earnings e ON e.id=i.earning_id
      JOIN usage_days u ON u.id=e.usage_id JOIN bindings b ON b.id=u.binding_id JOIN connections c ON c.id=b.connection_id JOIN accounts a ON a.id=b.account_id WHERE i.invoice_id=$1 ORDER BY u.day,a.email`,[invoiceId]);
    return reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition',`attachment; filename="${inv.number}.csv"`).send(csv(items,[['day','日期'],['email','账号'],['platform','平台'],['raw_usd','账单 USD'],['rate','折扣'],['gross_usd','应收 USD'],['downstream_usd','下级应付 USD'],['profit_usd','利润 USD']]));
  });
  app.post('/api/withdrawals',async req=>{
    const d=z.object({amount:money,method:z.string().trim().min(1).max(80),destination:z.string().trim().min(3).max(500)}).parse(req.body);return requestWithdrawal(db,req.user,d.amount,d.method,d.destination);
  });
  app.post('/api/withdrawals/:id/review',async req=>{
    const d=z.object({action:z.enum(['paid','rejected']),reference:z.string().trim().min(3).max(500)}).parse(req.body);return reviewWithdrawal(db,req.user,identifier.parse((req.params as Row).id),d.action,d.reference);
  });
  app.get('/api/audits',async req=>({rows:await db.query(`SELECT a.*,u.name AS actor_name FROM audits a LEFT JOIN users u ON u.id=a.actor_id WHERE a.actor_id=$1 OR $2::boolean ORDER BY a.created_at DESC LIMIT 300`,[req.user.id,req.user.role==='owner'])}));
  return {app,box};
}
