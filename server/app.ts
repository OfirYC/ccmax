import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { createHash, randomBytes } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { DB, Row } from './db.js';
import { AppError, assert, audit, dayString, hashPassword, id, nextDay, requireDirect, requireOwner, secretBox, subtree, today, verifyPassword } from './core.js';
import { balance, confirmInvoice, createInvoice, csv, ingestUsage, requestWithdrawal, reviewWithdrawal, withdrawalDestination } from './billing.js';
import { enqueue } from './worker.js';
import { PROVIDERS, PROVIDER_KEYS, ProviderClient, type ProviderKey } from './providers.js';
import { accountProxy, parseProxy, proxyFingerprint, requireConsistentBindings } from './proxies.js';

declare module 'fastify' { interface FastifyRequest { user: Row; } }
const identifier=z.string().uuid();
const provider=z.enum(PROVIDER_KEYS);
const money=z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/,'请输入最多 8 位小数的美元金额');
const rate=z.coerce.number().min(0).max(1).multipleOf(0.0001);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v)) && new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v,'日期无效');
const email=z.email().max(200).transform(v=>v.toLowerCase());
const password=z.string().min(12,'密码至少 12 位').max(200);
const key=z.string().min(8).max(100);
const publicUser=(u:Row)=>({id:u.id,name:u.name,email:u.email,role:u.role,parent_id:u.parent_id,active:u.active,created_at:u.created_at});
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const optionSchema=z.object({accountType:z.enum(['speed','stable','team','max','pro']).optional(),policyTemplateId:z.string().max(100).optional(),groupIds:z.array(z.string().max(100)).max(30).optional(),ccTemplateId:z.string().max(100).optional()}).strict();

export async function createApp(db:DB,config:{encryptionKey:string;appUrl:string;production?:boolean;logger?:boolean}) {
  const box=secretBox(config.encryptionKey);
  const app=Fastify({logger:config.logger??false,trustProxy:(_address,hop)=>hop===0,bodyLimit:1024*1024});
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
    if(['23505','23503','23514'].includes(code)) return reply.code(409).send({error:'记录已存在、归属冲突或依赖状态发生变化，请刷新后重试'});
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
    const current=today(),q=z.object({from:date.default(current.slice(0,8)+'01'),to:date.default(current)}).parse(req.query);
    assert(q.from<=q.to,'开始日期不能晚于结束日期');
    const ids=await subtree(db,req.user.id);
    const users=await db.query(`WITH RECURSIVE branches AS (
      SELECT id AS root,id FROM users WHERE id=ANY($1::text[])
      UNION ALL SELECT b.root,u.id FROM branches b JOIN users u ON u.parent_id=b.id)
      SELECT u.id,u.parent_id,u.name,u.email,u.role,u.active,u.created_at,p.name AS parent_name,
      (SELECT count(*) FROM accounts a WHERE a.owner_id=u.id AND a.ownership_verified) AS account_count,
      (SELECT count(*) FROM accounts a JOIN branches b ON b.id=a.owner_id WHERE b.root=u.id AND a.ownership_verified) AS team_account_count,
      COALESCE(m.raw_usd,0) AS raw_usd,COALESCE(m.gross_usd,0) AS gross_usd,
      COALESCE(m.downstream_usd,0) AS downstream_usd,COALESCE(m.profit_usd,0) AS profit_usd,COALESCE(m.final_profit,0) AS final_profit
      FROM users u LEFT JOIN users p ON p.id=u.parent_id LEFT JOIN (
        SELECT e.user_id,sum(d.raw_usd) AS raw_usd,sum(e.gross_usd) AS gross_usd,sum(e.downstream_usd) AS downstream_usd,
          sum(e.profit_usd) AS profit_usd,sum(CASE WHEN d.state='final' THEN e.profit_usd ELSE 0 END) AS final_profit
        FROM earnings e JOIN usage_days d ON d.id=e.usage_id WHERE d.day BETWEEN $2 AND $3 GROUP BY e.user_id
      ) m ON m.user_id=u.id WHERE u.id=ANY($1::text[]) ORDER BY u.created_at`,[ids,q.from,q.to]);
    const rates=await db.query(`SELECT DISTINCT ON(user_id,provider) user_id,provider,rate,effective_date FROM rates WHERE user_id=ANY($1::text[]) AND effective_date<=$2 ORDER BY user_id,provider,effective_date DESC`,[ids,current]);
    const upcoming=await db.query(`SELECT user_id,provider,rate,effective_date FROM rates WHERE user_id=ANY($1::text[]) AND effective_date>$2`,[ids,current]);
    return {users,rates,upcoming,period:q,providers:PROVIDERS};
  });
  app.post('/api/team',async req=>{
    const d=z.object({name:z.string().trim().min(1).max(80),email,password,rates:z.partialRecord(provider,rate).refine(v=>Object.keys(v).length>0,'请至少设置一个平台价格'),effectiveFrom:date.optional()}).parse(req.body);
    const hash=await hashPassword(d.password),userId=id(),effective=d.effectiveFrom??today();assert(effective<=today(),'初始价格日期不能在未来');
    return db.transaction(async tx=>{
      const [u]=await tx.query('INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING *',[userId,req.user.id,d.email,d.name,hash]);
      for(const [p,value] of Object.entries(d.rates)) await tx.query('INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id(),userId,p,value,effective,req.user.id]);
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
    const d=z.object({provider,rate,effectiveFrom:date.optional()}).parse(req.body);
    return db.transaction(async tx=>{
      await requireDirect(tx,req.user,target);
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[target]);
      const [existing]=await tx.query('SELECT id FROM rates WHERE user_id=$1 AND provider=$2 LIMIT 1',[target,d.provider]);
      const effective=existing?nextDay():(d.effectiveFrom??today());
      assert(!existing||!d.effectiveFrom||d.effectiveFrom===effective,'已有价格只能从次日变更');
      assert(existing||effective<=today(),'初始价格日期不能在未来');
      await tx.query(`INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(user_id,provider,effective_date) DO UPDATE SET rate=EXCLUDED.rate,created_by=EXCLUDED.created_by,created_at=now()`,[id(),target,d.provider,d.rate,effective,req.user.id]);
      await audit(tx,req.user.id,'rate.update',target,{...d,effectiveDate:effective});return {effectiveDate:effective};
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
    const d=z.object({provider,name:z.string().trim().min(1).max(80),username:z.string().min(1).max(200),password:z.string().min(1).max(500),payoutRate:rate,effectiveFrom:date.optional()}).parse(req.body);
    const connectionId=id(),effective=d.effectiveFrom??today();assert(effective<=today(),'初始价格日期不能在未来');
    await db.transaction(async tx=>{
      await tx.query('INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,$2,$3,$4,$5)',[connectionId,d.provider,d.name,box.encrypt({username:d.username,password:d.password}),d.payoutRate]);
      await tx.query('INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5)',[id(),connectionId,d.payoutRate,effective,req.user.id]);
      await audit(tx,req.user.id,'connection.create',connectionId,{provider:d.provider});
    });
    const job=await enqueue(db,box,req.user.id,connectionId,'sync',{},id());
    return {id:connectionId,job};
  });
  app.patch('/api/connections/:id',async req=>{
    await requireOwner(req.user);const target=identifier.parse((req.params as Row).id),effective=nextDay();
    const d=z.object({enabled:z.boolean().optional(),payoutRate:rate.optional(),username:z.string().max(200).optional(),password:z.string().min(1).max(500).optional(),name:z.string().trim().min(1).max(80).optional()}).parse(req.body);
    await db.transaction(async tx=>{
      const [c]=await tx.query('SELECT * FROM connections WHERE id=$1 FOR UPDATE',[target]);assert(c,'平台连接不存在',404);
      const credentials=box.decrypt(c.credentials);
      await tx.query('UPDATE connections SET enabled=$2,credentials=$3,name=$4 WHERE id=$1',[target,d.enabled??c.enabled,box.encrypt({username:d.username??credentials.username,password:d.password??credentials.password}),d.name??c.name]);
      if(d.payoutRate!==undefined) {
        await tx.query(`INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(connection_id,effective_date) DO UPDATE SET rate=EXCLUDED.rate,created_by=EXCLUDED.created_by,created_at=now()`,[id(),target,d.payoutRate,effective,req.user.id]);
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
    const [c]=await db.query('SELECT provider FROM connections WHERE id=$1 AND enabled=true',[target]);assert(c && PROVIDERS[c.provider as ProviderKey]?.historicalUsage,'此平台不支持历史查询，请导入确认的日账单');
    return enqueue(db,box,req.user.id,target,'reconcile',{day:d.day},d.key);
  });

  app.get('/api/proxies',async req=>{
    const ids=await subtree(db,req.user.id);
    const proxies=await db.query(`SELECT p.id,p.owner_id,p.name,p.endpoint,p.enabled,p.created_at,u.name AS owner_name,a.id AS account_id,a.email AS account_email
      FROM proxies p JOIN users u ON u.id=p.owner_id LEFT JOIN accounts a ON a.proxy_id=p.id
      WHERE p.owner_id=ANY($1::text[]) OR a.owner_id=ANY($1::text[]) ORDER BY p.created_at DESC`,[ids]);
    const mappings=await db.query(`SELECT m.proxy_id,m.connection_id,m.external_id,c.name AS connection_name FROM proxy_bindings m JOIN connections c ON c.id=m.connection_id WHERE m.proxy_id=ANY($1::text[])`,[proxies.map(p=>p.id)]);
    return {proxies:proxies.map(p=>({...p,mappings:mappings.filter(m=>m.proxy_id===p.id)}))};
  });
  app.post('/api/proxies',async req=>{
    const d=z.object({name:z.string().trim().min(1).max(80),url:z.string().trim().min(1).max(2000)}).parse(req.body);
    const parsed=parseProxy(d.url),proxyId=id();
    await db.transaction(async tx=>{
      await tx.query('INSERT INTO proxies(id,owner_id,name,endpoint,secret,fingerprint) VALUES($1,$2,$3,$4,$5,$6)',[proxyId,req.user.id,d.name,parsed.endpoint,box.encrypt({url:parsed.url}),proxyFingerprint(parsed.url,config.encryptionKey)]);
      await audit(tx,req.user.id,'proxy.create',proxyId);
    });return {id:proxyId};
  });
  app.patch('/api/proxies/:id',async req=>{
    const proxyId=identifier.parse((req.params as Row).id),d=z.object({name:z.string().trim().min(1).max(80).optional(),enabled:z.boolean().optional()}).parse(req.body);
    await db.transaction(async tx=>{
      const [p]=await tx.query('SELECT * FROM proxies WHERE id=$1 FOR UPDATE',[proxyId]);assert(p && (p.owner_id===req.user.id||req.user.role==='owner'),'只能管理自己添加的代理',403);
      await tx.query('UPDATE proxies SET name=$2,enabled=$3 WHERE id=$1',[proxyId,d.name??p.name,d.enabled??p.enabled]);
      await audit(tx,req.user.id,'proxy.update',proxyId,{enabled:d.enabled});
    });return {ok:true};
  });
  app.post('/api/proxies/:id/mappings',async req=>{
    await requireOwner(req.user);
    const proxyId=identifier.parse((req.params as Row).id),d=z.object({connectionId:identifier,externalId:z.string().min(1).max(200),evidence:z.string().trim().min(5).max(2000)}).parse(req.body);
    const [p]=await db.query('SELECT * FROM proxies WHERE id=$1',[proxyId]),[c]=await db.query('SELECT * FROM connections WHERE id=$1 AND enabled=true',[d.connectionId]);assert(p?.enabled && c,'代理或平台不可用');
    assert(c.provider!=='gatelink','Gatelink 直接使用账号固定代理 URL，无需配置平台映射');
    const client=new ProviderClient(c.provider,box.decrypt(c.credentials));await client.login();await client.verifyProxyMapping(box.decrypt(p.secret).url,d.externalId);
    await db.transaction(async tx=>{
      const [old]=await tx.query('SELECT * FROM proxy_bindings WHERE proxy_id=$1 AND connection_id=$2',[proxyId,c.id]);
      assert(!old||old.external_id===d.externalId,'已有平台代理映射不能直接更换，请先核对上游账号',409);
      await tx.query('INSERT INTO proxy_bindings(id,proxy_id,connection_id,external_id) VALUES($1,$2,$3,$4) ON CONFLICT(proxy_id,connection_id) DO NOTHING',[id(),proxyId,c.id,d.externalId]);
      await audit(tx,req.user.id,'proxy.mapping.confirm',proxyId,{connectionId:c.id,externalId:d.externalId,evidence:d.evidence});
    });return {ok:true};
  });
  app.get('/api/accounts',async req=>{
    const ids=await subtree(db,req.user.id),root=req.user.role==='owner';
    const accounts=await db.query(`SELECT a.*,u.name AS owner_name,p.name AS proxy_name,p.endpoint AS proxy_endpoint,p.enabled AS proxy_enabled FROM accounts a LEFT JOIN users u ON u.id=a.owner_id LEFT JOIN proxies p ON p.id=a.proxy_id
      WHERE a.owner_id=ANY($1::text[]) OR $2::boolean ORDER BY a.created_at DESC`,[ids,root]);
    const bindings=await db.query(`SELECT b.*,c.provider,c.name AS connection_name FROM bindings b JOIN connections c ON c.id=b.connection_id JOIN accounts a ON a.id=b.account_id
      WHERE (a.owner_id=ANY($1::text[]) AND a.ownership_verified) OR $2::boolean`,[ids,root]);
    return {accounts:accounts.map(a=>({...a,bindings:bindings.filter(b=>b.account_id===a.id)})),providers:PROVIDERS};
  });
  app.post('/api/accounts/:id/proxy',async req=>{
    const accountId=identifier.parse((req.params as Row).id),d=z.object({proxyId:identifier}).parse(req.body);
    return db.transaction(async tx=>{
      const [a]=await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);assert(a && (a.owner_id===req.user.id||req.user.role==='owner'),'只能为自己名下账号绑定代理',403);
      assert(!a.proxy_id||a.proxy_id===d.proxyId,'账号已固定绑定代理，不能在平台之间切换代理',409);
      const [p]=await tx.query('SELECT * FROM proxies WHERE id=$1 FOR UPDATE',[d.proxyId]);assert(p?.enabled && (p.owner_id===req.user.id||req.user.role==='owner'),'请选择自己添加且已启用的代理',403);
      assert(p.owner_id===a.owner_id||p.owner_id===req.user.id,'不能把其他团队上传的代理绑定给此账号',403);
      await tx.query('UPDATE accounts SET proxy_id=$2 WHERE id=$1',[accountId,p.id]);
      await audit(tx,req.user.id,'account.proxy.bind',accountId,{proxyId:p.id});
      return {account:{...a,proxy_id:p.id,proxy_name:p.name,proxy_endpoint:p.endpoint,proxy_enabled:p.enabled}};
    });
  });
  app.post('/api/bindings/:id/proxy/confirm',async req=>{
    await requireOwner(req.user);const bindingId=identifier.parse((req.params as Row).id),d=z.object({evidence:z.string().trim().min(5).max(2000)}).parse(req.body);
    await db.transaction(async tx=>{
      const [b]=await tx.query('SELECT b.*,c.provider FROM bindings b JOIN connections c ON c.id=b.connection_id WHERE b.id=$1 FOR UPDATE OF b',[bindingId]);assert(b,'平台绑定不存在',404);
      const p=await accountProxy(tx,box,b.account_id);
      assert(b.provider==='gatelink','AI008 / Mini CC 请使用平台代理同步核对，不允许仅凭说明确认');
      await tx.query('UPDATE bindings SET proxy_id=$2 WHERE id=$1',[bindingId,p.id]);
      await audit(tx,req.user.id,'binding.proxy.manual_confirm',bindingId,{proxyId:p.id,evidence:d.evidence});
    });return {ok:true};
  });
  app.post('/api/bindings/:id/proxy/sync',async req=>{
    const bindingId=identifier.parse((req.params as Row).id),d=z.object({key}).parse(req.body);
    const [b]=await db.query(`SELECT b.*,a.owner_id,a.ownership_verified,c.provider FROM bindings b JOIN accounts a ON a.id=b.account_id JOIN connections c ON c.id=b.connection_id WHERE b.id=$1`,[bindingId]);
    assert(b && ((b.ownership_verified&&b.owner_id===req.user.id)||req.user.role==='owner'),'不能修改该账号代理',403);
    assert(b.provider!=='gatelink','Gatelink 需在上游修改代理，再由管理员核实');
    const p=await accountProxy(db,box,b.account_id);
    return enqueue(db,box,req.user.id,b.connection_id,'set_proxy',{bindingId,accountId:b.account_id,proxyId:p.id},d.key);
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
      const [a]=await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[target]);assert(a && !a.ownership_verified,'只有未核实归属账号可分配；已确认账号不可改挂团队',409);
      const [u]=await tx.query('SELECT id FROM users WHERE id=$1 AND active=true',[d.userId]);assert(u,'用户不存在或已停用');
      if(a.proxy_id) {
        const [p]=await tx.query('SELECT owner_id FROM proxies WHERE id=$1',[a.proxy_id]);
        assert(p.owner_id===req.user.id||p.owner_id===u.id,'该账号的固定代理由其他成员上传，请先核对代理和账号归属',409);
      }
      await tx.query('UPDATE accounts SET owner_id=$2,ownership_verified=true WHERE id=$1',[target,d.userId]);await audit(tx,req.user.id,'account.assign',target,{userId:d.userId});
    });return {ok:true};
  });
  app.post('/api/accounts/:id/authorize',async req=>{
    const accountId=identifier.parse((req.params as Row).id);
    const d=z.object({targets:z.array(z.object({connectionId:identifier,options:optionSchema})).min(1).max(10),key}).parse(req.body);
    return db.transaction(async tx=>{
      const [a]=await tx.query('SELECT * FROM accounts WHERE id=$1 AND owner_id=$2 FOR UPDATE',[accountId,req.user.id]);assert(a,'只能为自己名下的账号上号',403);
      const proxy=await accountProxy(tx,box,accountId);await requireConsistentBindings(tx,accountId,proxy.id);
      assert(new Set(d.targets.map(t=>t.connectionId)).size===d.targets.length,'不能重复选择同一平台连接');
      const jobs=[];
      for(const t of d.targets) {
        const [c]=await tx.query('SELECT id FROM connections WHERE id=$1 AND enabled=true',[t.connectionId]);assert(c,'连接不存在或已停用');
        const [b]=await tx.query('SELECT id FROM bindings WHERE account_id=$1 AND connection_id=$2',[accountId,c.id]);assert(!b,'此账号已在所选平台上号，请联系管理员核实归属',409);
        const [pending]=await tx.query(`SELECT id FROM oauth_attempts WHERE account_id=$1 AND connection_id=$2 AND state IN ('pending','exchanging') AND expires_at>now()`,[accountId,c.id]);
        assert(!pending,'已有有效授权流程，请完成回调或等待过期',409);
        jobs.push(await enqueue(tx,box,req.user.id,c.id,'oauth_start',{accountId,proxyId:proxy.id,options:t.options},d.key));
      }return {jobs};
    });
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
      const [previous]=await tx.query(`SELECT id FROM jobs WHERE requested_by=$1 AND kind='oauth_exchange' AND connection_id=$2 AND idempotency_key=$3`,[req.user.id,a.connection_id,d.key]);
      if(previous) {
        // Completed exchanges erase their secrets. The immutable account proxy
        // still reconstructs the request hash without reusing a one-time code.
        const [account]=await tx.query('SELECT proxy_id FROM accounts WHERE id=$1',[a.account_id]);
        return enqueue(tx,box,req.user.id,a.connection_id,'oauth_exchange',{accountId:a.account_id,proxyId:account.proxy_id,attemptId,callback:d.callback},d.key);
      }
      const secret=box.decrypt(a.secret);assert(secret.proxyId,'旧授权流程没有固定代理，请重新授权');
      const proxy=await accountProxy(tx,box,a.account_id,secret.proxyId);await requireConsistentBindings(tx,a.account_id,proxy.id);
      assert(a.state==='pending' && new Date(a.expires_at)>new Date(),'授权已过期或已经提交，请核对任务状态',409);
      await tx.query(`UPDATE oauth_attempts SET state='exchanging' WHERE id=$1`,[a.id]);
      return enqueue(tx,box,req.user.id,a.connection_id,'oauth_exchange',{accountId:a.account_id,proxyId:proxy.id,attemptId,callback:d.callback},d.key);
    });
  });
  app.post('/api/accounts/:id/import-token',async req=>{
    const accountId=identifier.parse((req.params as Row).id),d=z.object({connectionId:identifier,refreshToken:z.string().trim().min(10).max(10000),options:optionSchema,key}).parse(req.body);
    return db.transaction(async tx=>{
      const [a]=await tx.query('SELECT id FROM accounts WHERE id=$1 AND owner_id=$2 FOR UPDATE',[accountId,req.user.id]);assert(a,'只能为自己名下账号上号',403);
      const proxy=await accountProxy(tx,box,accountId);await requireConsistentBindings(tx,accountId,proxy.id);
      const [c]=await tx.query('SELECT * FROM connections WHERE id=$1 AND enabled=true',[d.connectionId]);assert(c && PROVIDERS[c.provider as ProviderKey]?.refreshTokenImport,'此平台不支持 RT 导入');
      const [bound]=await tx.query('SELECT id FROM bindings WHERE account_id=$1 AND connection_id=$2',[accountId,c.id]);assert(!bound,'账号已在此平台，请联系管理员核实归属',409);
      const [pending]=await tx.query(`SELECT id FROM oauth_attempts WHERE account_id=$1 AND connection_id=$2 AND state IN ('pending','exchanging') AND expires_at>now()`,[accountId,c.id]);assert(!pending,'此账号已有有效 OAuth 流程，请先完成或等待过期',409);
      return enqueue(tx,box,req.user.id,c.id,'import_rt',{accountId,proxyId:proxy.id,options:d.options,refreshToken:d.refreshToken},d.key);
    });
  });
  app.post('/api/bindings/:id/status',async req=>{
    const bindingId=identifier.parse((req.params as Row).id),d=z.object({enabled:z.boolean(),key}).parse(req.body);
    const [b]=await db.query('SELECT b.*,a.owner_id,a.ownership_verified FROM bindings b JOIN accounts a ON a.id=b.account_id WHERE b.id=$1',[bindingId]);
    assert(b && ((b.ownership_verified&&b.owner_id===req.user.id)||req.user.role==='owner'),'不能操作该账号',403);
    if(d.enabled) {const p=await accountProxy(db,box,b.account_id);await requireConsistentBindings(db,b.account_id,p.id);}
    return enqueue(db,box,req.user.id,b.connection_id,'set_enabled',{bindingId,enabled:d.enabled},d.key);
  });

  app.get('/api/jobs',async req=>{
    const q=z.object({id:identifier.optional()}).parse(req.query);
    const jobs=await db.query(`SELECT j.id,j.connection_id,j.requested_by,j.kind,j.state,j.result,j.error,j.created_at,j.completed_at,c.name AS connection_name
      FROM jobs j JOIN connections c ON c.id=j.connection_id WHERE (j.requested_by=$1 OR $2::boolean) AND ($3::text IS NULL OR j.id=$3) ORDER BY j.created_at DESC LIMIT 100`,[req.user.id,req.user.role==='owner',q.id??null]);
    // OAuth URLs belong only to the submitting user, including in admin views.
    return {jobs:jobs.map(j=>j.kind==='oauth_start' && j.requested_by!==req.user.id?{...j,result:null}:j)};
  });
  async function usageRows(user:Row,query:any,exporting=false) {
    const q=z.object({from:date.optional(),to:date.optional(),provider:provider.optional(),search:z.string().max(200).default(''),page:z.coerce.number().int().min(1).max(1000000).default(1)}).parse(query);
    assert(!q.from||!q.to||q.from<=q.to,'开始日期不能晚于结束日期');
    const ids=await subtree(db,user.id);
    const params=[user.id,ids,user.role==='owner',q.from??null,q.to??null,q.provider??null,q.search];
    const source=`FROM usage_days u JOIN bindings b ON b.id=u.binding_id JOIN connections c ON c.id=b.connection_id
      JOIN accounts a ON a.id=b.account_id LEFT JOIN users o ON o.id=a.owner_id
      LEFT JOIN earnings e ON e.usage_id=u.id AND e.user_id=$1
      WHERE ((a.owner_id=ANY($2::text[]) AND a.ownership_verified) OR $3::boolean) AND ($4::date IS NULL OR u.day>=$4) AND ($5::date IS NULL OR u.day<=$5)
      AND ($6::text IS NULL OR c.provider=$6) AND ($7::text='' OR strpos(lower(a.email||' '||COALESCE(o.name,'')),lower($7))>0)`;
    const [totals]=await db.query(`SELECT count(*) AS count,COALESCE(sum(u.raw_usd),0) AS raw_usd,COALESCE(sum(e.gross_usd),0) AS gross_usd,
      COALESCE(sum(e.downstream_usd),0) AS downstream_usd,COALESCE(sum(e.profit_usd),0) AS profit_usd ${source}`,params);
    if(exporting)assert(Number(totals.count)<=100000,'导出超过 100,000 条，请缩小日期或平台范围；未导出截断账单',400);
    const rows=await db.query(`SELECT u.id,u.day,u.raw_usd,u.state,u.source,u.evidence,u.updated_at,b.id AS binding_id,c.provider,c.name AS connection_name,
      a.email,a.owner_id,a.ownership_verified,o.name AS owner_name,e.rate,e.gross_usd,e.downstream_usd,e.profit_usd ${source}
      ORDER BY u.day DESC,a.email,u.id LIMIT $8 OFFSET $9`,[...params,exporting?100000:12,exporting?0:(q.page-1)*12]);
    return {rows,totals,total:Number(totals.count),page:q.page};
  }
  app.get('/api/usage',async req=>usageRows(req.user,req.query));
  app.get('/api/usage/export',async(req,reply)=>{const {rows}=await usageRows(req.user,req.query,true);return reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="ccmax-usage.csv"').send(csv(rows,[['day','日期（北京时间）'],['email','账号'],['connection_name','平台'],['raw_usd','平台账单 USD'],['rate','结算折扣'],['gross_usd','我的应收 USD'],['downstream_usd','下级应付 USD'],['profit_usd','我的利润 USD'],['state','核实状态']]));});
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
    const [accounts]=await db.query('SELECT count(*) AS total FROM accounts WHERE owner_id=ANY($1::text[]) AND ownership_verified',[ids]);
    const [team]=await db.query('SELECT count(*) AS total FROM users WHERE id=ANY($1::text[]) AND id<>$2',[ids,req.user.id]);
    const [totals]=await db.query(`SELECT COALESCE(sum(u.raw_usd),0) AS raw_usd,COALESCE(sum(e.gross_usd),0) AS gross_usd,COALESCE(sum(e.downstream_usd),0) AS downstream_usd,COALESCE(sum(e.profit_usd),0) AS profit_usd,
      COALESCE(sum(CASE WHEN u.state='final' THEN e.profit_usd ELSE 0 END),0) AS final_profit FROM earnings e JOIN usage_days u ON u.id=e.usage_id WHERE e.user_id=$1`,[req.user.id]);
    const daily=await db.query(`SELECT u.day,sum(u.raw_usd) AS raw_usd,sum(e.gross_usd) AS gross_usd,sum(e.profit_usd) AS profit_usd
      FROM earnings e JOIN usage_days u ON u.id=e.usage_id WHERE e.user_id=$1 GROUP BY u.day ORDER BY u.day DESC LIMIT 14`,[req.user.id]);
    const platforms=await db.query(`SELECT c.provider,c.name,c.status,c.last_sync_at,count(b.id) AS account_count,COALESCE(sum(b.daily_usd),0) AS daily_usd
      FROM connections c LEFT JOIN bindings b ON b.connection_id=c.id LEFT JOIN accounts a ON a.id=b.account_id
      WHERE c.enabled=true AND ((a.owner_id=ANY($1::text[]) AND a.ownership_verified) OR b.id IS NULL OR $2::boolean) GROUP BY c.id ORDER BY c.created_at`,[ids,req.user.role==='owner']);
    const [pending]=await db.query(`SELECT count(*) AS total FROM withdrawals WHERE payer_id=$1 AND state='pending'`,[req.user.id]);
    const [unassigned]=req.user.role==='owner'?await db.query('SELECT count(*) AS total FROM accounts WHERE ownership_verified=false'):[{total:0}];
    return {totals,accounts:Number(accounts.total),team:Number(team.total),balance:await balance(db,req.user.id),daily:daily.reverse(),platforms,providers:PROVIDERS,pendingWithdrawals:Number(pending.total),unassigned:Number(unassigned.total)};
  });
  app.get('/api/finance',async req=>{
    const q=z.object({tab:z.enum(['all','mine','children']).default('all'),page:z.coerce.number().int().min(1).max(1000000).default(1)}).parse(req.query);
    const filter=(alias:string)=>`(${alias}.user_id=$1 OR ${alias}.payer_id=$1) AND ($2::text='all' OR ($2='mine' AND ${alias}.user_id=$1) OR ($2='children' AND ${alias}.payer_id=$1))`;
    const params=[req.user.id,q.tab],offset=(q.page-1)*12;
    const [ic]=await db.query(`SELECT count(*) AS count FROM invoices i WHERE ${filter('i')}`,params);
    const [wc]=await db.query(`SELECT count(*) AS count FROM withdrawals w WHERE ${filter('w')}`,params);
    const [pending]=await db.query(`SELECT COALESCE(sum(profit_usd),0) AS amount FROM invoices WHERE user_id=$1 AND state='pending'`,[req.user.id]);
    const invoices=await db.query(`SELECT i.*,u.name AS user_name,p.name AS payer_name FROM invoices i JOIN users u ON u.id=i.user_id LEFT JOIN users p ON p.id=i.payer_id
      WHERE ${filter('i')} ORDER BY i.created_at DESC,i.id LIMIT 12 OFFSET $3`,[...params,offset]);
    const withdrawals=await db.query(`SELECT w.*,u.name AS user_name FROM withdrawals w JOIN users u ON u.id=w.user_id
      WHERE ${filter('w')} ORDER BY w.created_at DESC,w.id LIMIT 12 OFFSET $3`,[...params,offset]);
    const ledger=await db.query('SELECT * FROM ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.id]);
    return {balance:await balance(db,req.user.id),pendingProfit:pending.amount,invoicesTotal:Number(ic.count),withdrawalsTotal:Number(wc.count),invoices,withdrawals:withdrawals.map(w=>({...w,destination:withdrawalDestination(box,w.destination)})),ledger};
  });
  app.get('/api/ledger/export',async(req,reply)=>{
    const [total]=await db.query('SELECT count(*) AS count FROM ledger WHERE user_id=$1',[req.user.id]);
    assert(Number(total.count)<=100000,'流水超过 100,000 条，请联系管理员按数据库备份导出');
    const rows=await db.query('SELECT * FROM ledger WHERE user_id=$1 ORDER BY created_at,id',[req.user.id]);
    return reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="ccmax-ledger.csv"').send(csv(rows,[['created_at','时间'],['kind','类型'],['amount_usd','金额 USD'],['reference_id','关联账单或提现编号']]));
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
    const d=z.object({amount:money,method:z.string().trim().min(1).max(80),destination:z.string().trim().min(3).max(500),key}).parse(req.body);const w=await requestWithdrawal(db,req.user,d.amount,d.method,d.destination,d.key,box);return {...w,destination:withdrawalDestination(box,w.destination)};
  });
  app.post('/api/withdrawals/:id/review',async req=>{
    const d=z.object({action:z.enum(['paid','rejected']),reference:z.string().trim().min(3).max(500)}).parse(req.body);const w=await reviewWithdrawal(db,req.user,identifier.parse((req.params as Row).id),d.action,d.reference);return {...w,destination:withdrawalDestination(box,w.destination)};
  });
  app.get('/api/audits',async req=>({rows:await db.query(`SELECT a.*,u.name AS actor_name FROM audits a LEFT JOIN users u ON u.id=a.actor_id WHERE a.actor_id=$1 OR $2::boolean ORDER BY a.created_at DESC LIMIT 300`,[req.user.id,req.user.role==='owner'])}));
  return {app,box};
}
