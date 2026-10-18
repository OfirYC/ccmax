import type { DB, Row } from './db.js';
import { createHash } from 'node:crypto';
import { assert, audit, id, today, type SecretBox } from './core.js';
import { ingestUsage } from './billing.js';
import { ProviderClient, type ProviderKey, type UpstreamAccount } from './providers.js';
import { accountProxy, requireConsistentBindings } from './proxies.js';
import { saveTelemetry } from './telemetry.js';

export async function enqueue(db:DB,box:SecretBox,actor:string,connectionId:string,kind:string,payload:object,key:string) {
  const subject=(payload as any).accountId??(payload as any).bindingId??(payload as any).day??null;
  const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const duplicate=async()=>{
    const [row]=await db.query('SELECT id,state,subject_id,request_hash FROM jobs WHERE requested_by=$1 AND connection_id=$2 AND kind=$3 AND idempotency_key=$4',[actor,connectionId,kind,key]);
    if(row) assert(row.subject_id===subject && (!row.request_hash||row.request_hash===hash),'请求编号已用于不同任务',409);
    return row?{id:row.id,state:row.state}:undefined;
  };
  const existing=await duplicate();if(existing)return existing;
  const [job]=await db.query(`INSERT INTO jobs(id,connection_id,requested_by,kind,payload,idempotency_key,subject_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT DO NOTHING RETURNING id,state`,[id(),connectionId,actor,kind,box.encrypt(payload),key,subject,hash]);
  if(job) return job;
  if(kind==='sync') {
    const [running]=await db.query(`SELECT id,state FROM jobs WHERE connection_id=$1 AND kind='sync' AND state IN ('queued','running') LIMIT 1`,[connectionId]);
    if(running)return running;
  }
  const retry=await duplicate();assert(retry,'此账号已有正在执行的上号任务，请等待完成',409);return retry;
}

export async function saveBinding(tx:DB,connection:Row,remote:UpstreamAccount,expectedAccount?:Row,proxyId?:string) {
  let account=expectedAccount;
  if(account) {
    [account]=await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[account.id]);
    assert(account && account.owner_id===expectedAccount!.owner_id && remote.email===account.email,'平台返回的邮箱或账号归属与提交账号不符，需要管理员核对',409);
    if(!account.ownership_verified) await tx.query('UPDATE accounts SET ownership_verified=true WHERE id=$1',[account.id]);
  }
  else {
    [account]=await tx.query(`INSERT INTO accounts(id,email,label) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING *`,[id(),remote.email,remote.name]);
  }
  let [bound]=await tx.query(`INSERT INTO bindings(id,account_id,connection_id,external_id,status,daily_usd,cost_7d,cost_30d,utilization,proxy_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(connection_id,external_id) DO UPDATE SET
    status=EXCLUDED.status,daily_usd=EXCLUDED.daily_usd,cost_7d=EXCLUDED.cost_7d,cost_30d=EXCLUDED.cost_30d,
    utilization=EXCLUDED.utilization,proxy_id=COALESCE(EXCLUDED.proxy_id,bindings.proxy_id),last_seen_at=now() RETURNING *`,
    [id(),account!.id,connection.id,remote.id,remote.status,remote.dailyUsd,remote.cost7d,remote.cost30d,remote.utilization,proxyId??null]);
  assert(bound.account_id===account!.id,'上游账号归属冲突',409);
  if(connection.provider!=='gatelink' && account!.proxy_id && remote.proxyExternalId!==undefined) {
    const [mapping]=await tx.query('SELECT external_id FROM proxy_bindings WHERE proxy_id=$1 AND connection_id=$2',[account!.proxy_id,connection.id]);
    const verified=mapping && mapping.external_id===remote.proxyExternalId?account!.proxy_id:null;
    [bound]=await tx.query('UPDATE bindings SET proxy_id=$2 WHERE id=$1 RETURNING *',[bound.id,verified]);
  }
  if(remote.telemetry)await saveTelemetry(tx,bound.id,remote.telemetry);
  return bound;
}

export function createWorker(db:DB,box:SecretBox,clientFactory=(p:ProviderKey,c:any)=>new ProviderClient(p,c)) {
  let stopped=false,busy=false;
  async function runOne():Promise<boolean> {
    const job=await db.transaction(async tx=>{
      const [next]=await tx.query(`SELECT * FROM jobs WHERE state='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if(!next) return null;
      const [claimed]=await tx.query(`UPDATE jobs SET state='running',started_at=now() WHERE id=$1 RETURNING *`,[next.id]);return claimed;
    });
    if(!job) return false;
    let recoveryStarted=false;
    try {
      const [connection]=await db.query('SELECT * FROM connections WHERE id=$1',[job.connection_id]);
      assert(connection?.enabled,'平台连接已停用');
      const [actor]=await db.query('SELECT * FROM users WHERE id=$1',[job.requested_by]);
      assert(actor?.active,'任务提交人已停用');
      const [blocked]=await db.query(`WITH RECURSIVE chain AS (SELECT id,parent_id,active FROM users WHERE id=$1 UNION ALL
        SELECT u.id,u.parent_id,u.active FROM users u JOIN chain c ON c.parent_id=u.id) SELECT id FROM chain WHERE active=false LIMIT 1`,[actor.id]);
      assert(!blocked,'所属团队已停用');
      const payload=box.decrypt(job.payload),client=clientFactory(connection.provider,box.decrypt(connection.credentials));
      recoveryStarted=job.kind==='oauth_start'&&!!payload.bindingId;
      let result:Record<string,any>={};
      let attempt:Row|undefined;
      let proxy:any;
      let oauthSecret:any;
      if(job.kind==='oauth_exchange') {
        [attempt]=await db.query(`SELECT * FROM oauth_attempts WHERE id=$1 AND user_id=$2 AND connection_id=$3`,[payload.attemptId,actor.id,connection.id]);
        assert(attempt && attempt.state==='exchanging' && new Date(attempt.expires_at)>new Date(),'授权已过期或状态不允许交换');
        oauthSecret=box.decrypt(attempt.secret);
      }
      const recoveryId=job.kind==='oauth_start'?payload.bindingId:oauthSecret?.bindingId;
      let recovery:Row|undefined;
      if(recoveryId) {
        [recovery]=await db.query(`SELECT b.*,a.owner_id,a.ownership_verified,a.email FROM bindings b JOIN accounts a ON a.id=b.account_id
          WHERE b.id=$1 AND b.account_id=$2 AND b.connection_id=$3`,[recoveryId,payload.accountId,connection.id]);
        assert(recovery?.ownership_verified&&recovery.owner_id===actor.id,'只能重新授权自己名下且已核实归属的平台账号');
      }
      if(['oauth_start','oauth_exchange','import_rt','set_proxy'].includes(job.kind)) {
        assert(payload.proxyId,'旧上号任务缺少账号代理快照，请重新发起上号');
        proxy=await accountProxy(db,box,payload.accountId,payload.proxyId);
        if(job.kind!=='set_proxy'&&!recovery)await requireConsistentBindings(db,payload.accountId,proxy.id);
      }
      if(job.kind==='oauth_exchange') {
        const secret=oauthSecret;
        assert(secret.proxyId===proxy.id && secret.options?.proxy===proxy.url,'OAuth 代理快照不一致，请重新授权');
        if(recovery)assert(secret.options.existingExternalId===recovery.external_id,'重新授权的原绑定已变化，请核对');
        client.restoreSession(secret.session);
        if(connection.provider!=='gatelink')await client.verifyProxyMapping(proxy.url,secret.options.proxyExternalId);
      } else await client.login();
      if(job.kind==='sync') {
        assert(actor.role==='owner','仅管理员可以同步共享主账号');
        const day=today(),accounts=await client.listAccounts();
        if(typeof client.enrichTelemetry==='function')await client.enrichTelemetry(accounts);
        assert(today()===day,'同步跨越北京时间零点，请重新同步');
        let skippedDaily=0;
        await db.transaction(async tx=>{
          for(const remote of accounts) {
            const bound=await saveBinding(tx,connection,remote);
            // Gatelink caches may still contain yesterday's daily counter.
            // Keep the source snapshot for inspection without booking it today.
            if(remote.dailyUsd===null || remote.telemetry&&(remote.telemetry.day!==day||!remote.telemetry.sourceAt)) {skippedDaily++;continue;}
            await ingestUsage(tx,{bindingId:bound.id,day,rawUsd:remote.dailyUsd,final:false,source:'live_snapshot'});
          }
          await tx.query(`UPDATE bindings SET status='missing' WHERE connection_id=$1 AND NOT(external_id=ANY($2::text[]))`,[connection.id,accounts.map(a=>a.id)]);
          await tx.query(`UPDATE connections SET status='connected',last_error=NULL,last_sync_at=now() WHERE id=$1`,[connection.id]);
          await tx.query(`DELETE FROM telemetry_samples WHERE bucket_at<now()-interval '48 hours'`);
        });
        result={accounts:accounts.length,skippedDaily};
      } else if(job.kind==='oauth_start') {
        const [account]=await db.query('SELECT * FROM accounts WHERE id=$1 AND owner_id=$2',[payload.accountId,actor.id]);
        assert(account,'账号归属不匹配');
        const [bound]=await db.query('SELECT id FROM bindings WHERE account_id=$1 AND connection_id=$2',[account.id,connection.id]);
        assert(recovery?bound?.id===recovery.id:!bound,'平台已存在该账号，请由管理员核对归属后使用');
        if(recovery)await client.verifySubmissionTarget(recovery.external_id,account.email);
        const options=await submissionOptions(client,connection,proxy,{...payload.options,email:account.email,...(recovery?{existingExternalId:recovery.external_id}:{})});
        // AI008's targeted reauthorization uses the existing account's proxy.
        // Repair and verify that proxy before asking it to issue a new link.
        if(recovery&&connection.provider==='ai008')await client.setAccountProxy(recovery.external_id,options);
        const oauth=await client.startOAuth(options);
        const oauthId=id();
        await db.query(`INSERT INTO oauth_attempts(id,user_id,connection_id,account_id,secret,authorization_url,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,[oauthId,actor.id,connection.id,account.id,
          box.encrypt({...oauth.secret,proxyId:proxy.id,...(recovery?{bindingId:recovery.id}:{}),session:client.exportSession()}),oauth.url,new Date(Date.now()+oauth.expiresIn*1000)]);
        result={accountId:account.id,attemptId:oauthId,authorizationUrl:oauth.url,expiresIn:oauth.expiresIn};
      } else if(job.kind==='oauth_exchange'||job.kind==='import_rt') {
        const accountId=attempt?.account_id??payload.accountId;
        const [account]=await db.query('SELECT * FROM accounts WHERE id=$1 AND owner_id=$2',[accountId,actor.id]);assert(account,'账号归属不匹配');
        const [bound]=await db.query('SELECT id FROM bindings WHERE account_id=$1 AND connection_id=$2',[account.id,connection.id]);
        assert(recovery?bound?.id===recovery.id:!bound,'平台已存在该账号，未重复写入，请由管理员核对归属');
        if(recovery)await client.verifySubmissionTarget(recovery.external_id,account.email);
        const remote=job.kind==='oauth_exchange'?await client.exchangeOAuth(box.decrypt(attempt!.secret),payload.callback):await client.importRefreshToken(await submissionOptions(client,connection,proxy,{...payload.options,email:account.email}),payload.refreshToken);
        if(recovery)assert(remote.id===recovery.external_id&&remote.email===account.email,'重新授权返回的账号 ID 或邮箱不一致，请同步核对；未替换原绑定',409);
        await db.transaction(async tx=>{
          await accountProxy(tx,box,account.id,proxy.id);
          if(recovery) {
            const [current]=await tx.query(`SELECT b.id FROM bindings b JOIN accounts a ON a.id=b.account_id
              WHERE b.id=$1 AND b.account_id=$2 AND b.external_id=$3 AND a.owner_id=$4 AND a.ownership_verified FOR UPDATE OF b,a`,[recovery.id,account.id,remote.id,actor.id]);
            assert(current,'重新授权的原绑定或账号归属已变化，请核对',409);
            // Token refresh never resets daily counters, historical usage or earnings.
            await tx.query('UPDATE bindings SET status=$2,proxy_id=$3,last_seen_at=now() WHERE id=$1',[recovery.id,remote.status,proxy.id]);
          } else await saveBinding(tx,connection,remote,account,proxy.id);
          if(attempt) await tx.query(`UPDATE oauth_attempts SET state='done',secret=$2,authorization_url='' WHERE id=$1`,[attempt.id,box.encrypt({})]);
          await audit(tx,actor.id,recovery?'binding.reauthorized':'account.submitted',recovery?.id??account.id,{connectionId:connection.id,externalId:remote.id});
        });
        result={accountId:account.id,externalId:remote.id,...(recovery?{bindingId:recovery.id,reauthorized:true}:{})};
      } else if(job.kind==='set_proxy') {
        const [binding]=await db.query(`SELECT b.*,a.owner_id,a.ownership_verified FROM bindings b JOIN accounts a ON a.id=b.account_id WHERE b.id=$1 AND b.account_id=$2 AND b.connection_id=$3`,[payload.bindingId,payload.accountId,connection.id]);
        assert(binding && ((binding.ownership_verified&&binding.owner_id===actor.id)||actor.role==='owner'),'不能修改该账号的代理');
        const options=await submissionOptions(client,connection,proxy,{email:''});
        await client.setAccountProxy(binding.external_id,options);
        await db.transaction(async tx=>{
          await accountProxy(tx,box,binding.account_id,proxy.id);
          await tx.query('UPDATE bindings SET proxy_id=$2 WHERE id=$1',[binding.id,proxy.id]);
          await audit(tx,actor.id,'binding.proxy.sync',binding.id,{proxyId:proxy.id});
        });result={bindingId:binding.id,proxyId:proxy.id};
      } else if(job.kind==='set_enabled') {
        const [binding]=await db.query(`SELECT b.*,a.owner_id,a.ownership_verified,a.email FROM bindings b JOIN accounts a ON a.id=b.account_id WHERE b.id=$1 AND b.connection_id=$2`,[payload.bindingId,connection.id]);
        assert(binding && ((binding.ownership_verified&&binding.owner_id===actor.id)||actor.role==='owner'),'不能操作该账号');
        if(payload.enabled) {
          const proxy=await accountProxy(db,box,binding.account_id);
          await requireConsistentBindings(db,binding.account_id,proxy.id);
        }
        await client.verifySubmissionTarget(binding.external_id,binding.email);
        await client.setEnabled(binding.external_id,payload.enabled);
        await client.verifyAccountStatus(binding.external_id,binding.email,payload.enabled);
        await db.query('UPDATE bindings SET status=$2 WHERE id=$1',[binding.id,payload.enabled?'active':'disabled']);
        result={enabled:payload.enabled};
      } else if(job.kind==='reconcile') {
        assert(actor.role==='owner','仅管理员可读取历史对账数据');
        assert(payload.day<today(),'只能查询已结束日期');
        const rows=await client.historicalDay(payload.day);
        const bindings=await db.query('SELECT id,external_id FROM bindings WHERE connection_id=$1',[connection.id]);
        result={day:payload.day,candidates:rows.map(r=>({bindingId:bindings.find(b=>b.external_id===r.externalId)?.id??null,externalId:r.externalId,day:payload.day,rawUsd:r.rawUsd})),reviewRequired:true};
      }
      await db.query(`UPDATE jobs SET state='succeeded',result=$2,payload=$3,completed_at=now() WHERE id=$1`,[job.id,JSON.stringify(result),box.encrypt({})]);
    } catch(error) {
      const message=error instanceof Error?error.message:'任务执行失败';
      // OAuth codes and credential imports are one-use. Never blindly retry an
      // external mutation after a timeout or crash; reconcile the inventory first.
      const uncertain=['oauth_exchange','import_rt','set_enabled','set_proxy'].includes(job.kind)||recoveryStarted;
      await db.query(`UPDATE jobs SET state=$2,error=$3,payload=$4,completed_at=now() WHERE id=$1`,[job.id,uncertain?'needs_attention':'failed',message,box.encrypt({})]);
      if(job.kind==='oauth_exchange') {
        try {
          const payload=box.decrypt(job.payload);
          await db.query(`UPDATE oauth_attempts SET state='needs_attention',secret=$2 WHERE id=$1 AND state='exchanging'`,[payload.attemptId,box.encrypt({})]);
        } catch { /* the job error already records an encryption/configuration failure */ }
      }
      if(job.kind==='sync') await db.query(`UPDATE connections SET status='error',last_error=$2 WHERE id=$1`,[job.connection_id,message]);
    }
    return true;
  }
  async function submissionOptions(client:ProviderClient,connection:Row,proxy:any,options:any) {
    let externalId:string|undefined;
    if(connection.provider!=='gatelink') {
      let [mapping]=await db.query('SELECT * FROM proxy_bindings WHERE proxy_id=$1 AND connection_id=$2',[proxy.id,connection.id]);
      if(mapping)await client.verifyProxyMapping(proxy.url,mapping.external_id);
      else {
        const remote=await client.provisionProxy(proxy.url);assert(remote,'上游代理映射未确认');
        await db.query('INSERT INTO proxy_bindings(id,proxy_id,connection_id,external_id) VALUES($1,$2,$3,$4) ON CONFLICT(proxy_id,connection_id) DO NOTHING',[id(),proxy.id,connection.id,remote]);
        [mapping]=await db.query('SELECT * FROM proxy_bindings WHERE proxy_id=$1 AND connection_id=$2',[proxy.id,connection.id]);
        assert(mapping?.external_id===remote,'平台代理映射发生冲突',409);
      }
      externalId=mapping.external_id;
    }
    return {...options,proxy:proxy.url,proxyExternalId:externalId};
  }
  return {
    runOne,
    async tick() { if(stopped||busy) return;busy=true;try{for(let i=0;i<10&&!stopped;i++){if(!await runOne())break;}}finally{busy=false;} },
    async recover() {
      // Only stale leases are recovered: another replica may be doing live work.
      await db.query(`UPDATE jobs SET state='needs_attention',error='任务执行中断，请同步上游账号核对后重新提交',payload=$1,completed_at=now()
        WHERE state='running' AND started_at<now()-interval '30 minutes'`,[box.encrypt({})]);
      await db.query(`DELETE FROM sessions WHERE expires_at<now()`);
      await db.query(`UPDATE oauth_attempts SET secret=$1,authorization_url='',state='needs_attention' WHERE state IN ('pending','exchanging') AND expires_at<now()`,[box.encrypt({})]);
    },
    stop() { stopped=true; },
    isBusy() { return busy; },
  };
}
