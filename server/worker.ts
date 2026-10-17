import type { DB, Row } from './db.js';
import { assert, audit, id, today, type SecretBox } from './core.js';
import { ingestUsage } from './billing.js';
import { ProviderClient, type ProviderKey, type UpstreamAccount } from './providers.js';

export async function enqueue(db:DB,box:SecretBox,actor:string,connectionId:string,kind:string,payload:object,key:string) {
  const [existing]=await db.query('SELECT id,state FROM jobs WHERE requested_by=$1 AND connection_id=$2 AND kind=$3 AND idempotency_key=$4',[actor,connectionId,kind,key]);
  if(existing) return existing;
  const [job]=await db.query(`INSERT INTO jobs(id,connection_id,requested_by,kind,payload,idempotency_key) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT DO NOTHING RETURNING id,state`,[id(),connectionId,actor,kind,box.encrypt(payload),key]);
  if(job) return job;
  const [running]=await db.query(`SELECT id,state FROM jobs WHERE connection_id=$1 AND kind=$2 AND state IN ('queued','running') ORDER BY created_at DESC LIMIT 1`,[connectionId,kind]);
  if(running) return running;
  const [duplicate]=await db.query('SELECT id,state FROM jobs WHERE requested_by=$1 AND connection_id=$2 AND kind=$3 AND idempotency_key=$4',[actor,connectionId,kind,key]);
  assert(duplicate,'任务提交冲突，请刷新后重试',409);return duplicate;
}

export async function saveBinding(tx:DB,connection:Row,remote:UpstreamAccount,expectedAccount?:Row) {
  let account=expectedAccount;
  if(account) assert(remote.email===account.email,'平台返回的邮箱与提交账号不符，需要管理员核对',409);
  else {
    [account]=await tx.query(`INSERT INTO accounts(id,email,label) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING *`,[id(),remote.email,remote.name]);
  }
  const [bound]=await tx.query(`INSERT INTO bindings(id,account_id,connection_id,external_id,status,daily_usd,cost_7d,cost_30d,utilization)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(connection_id,external_id) DO UPDATE SET
    status=EXCLUDED.status,daily_usd=EXCLUDED.daily_usd,cost_7d=EXCLUDED.cost_7d,cost_30d=EXCLUDED.cost_30d,
    utilization=EXCLUDED.utilization,last_seen_at=now() RETURNING *`,
    [id(),account!.id,connection.id,remote.id,remote.status,remote.dailyUsd,remote.cost7d,remote.cost30d,remote.utilization]);
  assert(bound.account_id===account!.id,'上游账号归属冲突',409);
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
    try {
      const [connection]=await db.query('SELECT * FROM connections WHERE id=$1',[job.connection_id]);
      assert(connection?.enabled,'平台连接已停用');
      const [actor]=await db.query('SELECT * FROM users WHERE id=$1',[job.requested_by]);
      assert(actor?.active,'任务提交人已停用');
      const [blocked]=await db.query(`WITH RECURSIVE chain AS (SELECT id,parent_id,active FROM users WHERE id=$1 UNION ALL
        SELECT u.id,u.parent_id,u.active FROM users u JOIN chain c ON c.parent_id=u.id) SELECT id FROM chain WHERE active=false LIMIT 1`,[actor.id]);
      assert(!blocked,'所属团队已停用');
      const payload=box.decrypt(job.payload),client=clientFactory(connection.provider,box.decrypt(connection.credentials));
      let result:Record<string,any>={};
      let attempt:Row|undefined;
      if(job.kind==='oauth_exchange') {
        [attempt]=await db.query(`SELECT * FROM oauth_attempts WHERE id=$1 AND user_id=$2 AND connection_id=$3`,[payload.attemptId,actor.id,connection.id]);
        assert(attempt && attempt.state==='exchanging' && new Date(attempt.expires_at)>new Date(),'授权已过期或状态不允许交换');
        const secret=box.decrypt(attempt.secret);client.restoreSession(secret.session);
      } else await client.login();
      if(job.kind==='sync') {
        assert(actor.role==='owner','仅管理员可以同步共享主账号');
        const day=today(),accounts=await client.listAccounts();
        assert(today()===day,'同步跨越北京时间零点，请重新同步');
        await db.transaction(async tx=>{
          for(const remote of accounts) {
            const bound=await saveBinding(tx,connection,remote);
            await ingestUsage(tx,{bindingId:bound.id,day,rawUsd:remote.dailyUsd,final:false,source:'live_snapshot'});
          }
          await tx.query(`UPDATE connections SET status='connected',last_error=NULL,last_sync_at=now() WHERE id=$1`,[connection.id]);
        });
        result={accounts:accounts.length};
      } else if(job.kind==='oauth_start') {
        const [account]=await db.query('SELECT * FROM accounts WHERE id=$1 AND owner_id=$2',[payload.accountId,actor.id]);
        assert(account,'账号归属不匹配');
        const oauth=await client.startOAuth({...payload.options,email:account.email});
        const oauthId=id();
        await db.query(`INSERT INTO oauth_attempts(id,user_id,connection_id,account_id,secret,authorization_url,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,[oauthId,actor.id,connection.id,account.id,
          box.encrypt({...oauth.secret,session:client.exportSession()}),oauth.url,new Date(Date.now()+oauth.expiresIn*1000)]);
        result={accountId:account.id,attemptId:oauthId,authorizationUrl:oauth.url,expiresIn:oauth.expiresIn};
      } else if(job.kind==='oauth_exchange'||job.kind==='import_rt') {
        const accountId=attempt?.account_id??payload.accountId;
        const [account]=await db.query('SELECT * FROM accounts WHERE id=$1 AND owner_id=$2',[accountId,actor.id]);assert(account,'账号归属不匹配');
        const remote=job.kind==='oauth_exchange'?await client.exchangeOAuth(box.decrypt(attempt!.secret),payload.callback):await client.importRefreshToken({...payload.options,email:account.email},payload.refreshToken);
        await db.transaction(async tx=>{
          await saveBinding(tx,connection,remote,account);
          if(attempt) await tx.query(`UPDATE oauth_attempts SET state='done',secret=$2,authorization_url='' WHERE id=$1`,[attempt.id,box.encrypt({})]);
          await audit(tx,actor.id,'account.submitted',account.id,{connectionId:connection.id,externalId:remote.id});
        });
        result={accountId:account.id,externalId:remote.id};
      } else if(job.kind==='set_enabled') {
        const [binding]=await db.query(`SELECT b.*,a.owner_id FROM bindings b JOIN accounts a ON a.id=b.account_id WHERE b.id=$1 AND b.connection_id=$2`,[payload.bindingId,connection.id]);
        assert(binding && (binding.owner_id===actor.id||actor.role==='owner'),'不能操作该账号');
        await client.setEnabled(binding.external_id,payload.enabled);
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
      const uncertain=['oauth_exchange','import_rt','set_enabled'].includes(job.kind);
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
