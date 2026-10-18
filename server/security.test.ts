import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, type DB } from './db.js';
import { bootstrap, id, today, secretBox } from './core.js';
import { createApp } from './app.js';
import { ingestUsage, requestWithdrawal, balance, createInvoice, confirmInvoice, reviewWithdrawal } from './billing.js';
import { openTestDB } from './test-db.js';
import { enqueue, saveBinding, createWorker } from './worker.js';
import type { FastifyInstance } from 'fastify';

const key = '11'.repeat(32);

describe('CCMAX authorization and ledger safeguards', () => {
  let db: DB;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = await openTestDB();
    await migrate(db);
    await bootstrap(db, { ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'correct horse battery staple' });
    ({ app } = await createApp(db, { encryptionKey: key, appUrl: 'http://localhost:3000' }));
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function login(email: string, password: string) {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'x-ccmax-request': '1' },
      payload: { email, password },
    });
    expect(response.statusCode).toBe(200);
    const cookie = response.headers['set-cookie'];
    return Array.isArray(cookie) ? cookie[0].split(';')[0] : String(cookie).split(';')[0];
  }

  async function api(cookie: string, method: string, url: string, payload?: any): Promise<any> {
    return app.inject({
      method, url,
      headers: { cookie, 'x-ccmax-request': '1' },
      payload,
    });
  }

  it('keeps sibling teams isolated while allowing the owner to see the full tree', async () => {
    const ownerCookie = await login('owner@example.com', 'correct horse battery staple');
    const a = await api(ownerCookie, 'POST', '/api/team', {
      name: 'Team A', email: 'a@example.com', password: 'team-a-password-123', rates: { gatelink: 0.4, ai008: 0.4 },
    });
    const b = await api(ownerCookie, 'POST', '/api/team', {
      name: 'Team B', email: 'b@example.com', password: 'team-b-password-123', rates: { gatelink: 0.4, ai008: 0.4 },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const aId = a.json().user.id;
    const bId = b.json().user.id;
    const bCookie = await login('b@example.com', 'team-b-password-123');
    const bAccount = await api(bCookie, 'POST', '/api/accounts', { email: 'b-claude@example.com', label: 'B' });
    expect(bAccount.statusCode).toBe(200);

    const aCookie = await login('a@example.com', 'team-a-password-123');
    const accounts = await api(aCookie, 'GET', '/api/accounts');
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json().accounts).toHaveLength(0);
    expect((await api(aCookie, 'PATCH', `/api/team/${bId}`, { active: false })).statusCode).toBe(403);
    expect((await api(aCookie, 'PUT', `/api/team/${bId}/rates`, { provider: 'ai008', rate: 0.1 })).statusCode).toBe(403);

    const ownerAccounts = await api(ownerCookie, 'GET', '/api/accounts');
    expect(ownerAccounts.json().accounts.map((account: any) => account.email)).toContain('b-claude@example.com');
    expect(aId).toMatch(/[0-9a-f-]{36}/);
  });

  it('serializes concurrent withdrawals so available balance cannot be overspent', async () => {
    const [owner] = await db.query('SELECT * FROM users WHERE role=\'owner\'');
    const agentId = id();
    await db.query(`INSERT INTO users(id,parent_id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5,'agent')`, [agentId, owner.id, 'ledger@example.com', 'Ledger', 'x']);
    await db.query(`INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'settlement','100.00000000','invoice-ledger-test')`, [id(), agentId]);
    const [agent] = await db.query('SELECT * FROM users WHERE id=$1', [agentId]);

    const results = await Promise.allSettled([
      requestWithdrawal(db, agent, '80', 'test', 'destination-one',id(),secretBox(key)),
      requestWithdrawal(db, agent, '80', 'test', 'destination-two',id(),secretBox(key)),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const current = await balance(db, agentId);
    expect(current.available).toBe('20.00000000');
    expect(current.pending).toBe('80.00000000');
  });

  it('uses the payout rate effective on the usage date for historical imports', async () => {
    const [owner] = await db.query('SELECT * FROM users WHERE role=\'owner\'');
    const connectionId = id(), accountId = id(), bindingId = id();
    await db.query(`INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','AI008','encrypted',0.4)`, [connectionId]);
    await db.query(`INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,0.4,'1970-01-01',$3),($4,$2,0.2,$5,$3)`, [id(), connectionId, owner.id, id(), today()]);
    await db.query(`INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,'historical@example.com',true)`, [accountId, owner.id]);
    await db.query(`INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,'historical-remote')`, [bindingId, accountId, connectionId]);
    const previousDay = new Date(Date.parse(`${today()}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    await ingestUsage(db, { bindingId, day: previousDay, rawUsd: '100', final: true, source: 'test' });
    const [usage] = await db.query('SELECT root_rate FROM usage_days WHERE binding_id=$1', [bindingId]);
    expect(usage.root_rate).toBe('0.4000');
  });
  async function agent(parent:any,name:string,rate='0.3') {
    const [u]=await db.query(`INSERT INTO users(id,parent_id,email,name,password_hash) VALUES($1,$2,$3,$4,'x') RETURNING *`,[id(),parent.id,name+'@example.com',name]);
    for(const provider of ['ai008','gatelink'])await db.query(`INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,'1970-01-01',$5)`,[id(),u.id,provider,rate,parent.id]);
    return u;
  }
  async function connection(provider='ai008',rate='0.5') {
    const [c]=await db.query(`INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,$2,$2,$3,$4) RETURNING *`,[id(),provider,secretBox(key).encrypt({username:'test',password:'test'}),rate]);
    await db.query(`INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,$3,'1970-01-01')`,[id(),c.id,rate]);return c;
  }
  const prior=(n=1)=>new Date(Date.parse(today()+'T00:00:00Z')-n*86400000).toISOString().slice(0,10);
  const remote=(remoteId:string,email:string)=>({id:remoteId,email,name:email,status:'active',dailyUsd:'100',cost7d:null,cost30d:null,utilization:null});
  async function account(user:any,email='claude@example.com',verified=true) {
    const [a]=await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,$4) RETURNING *',[id(),user.id,email,verified]);return a;
  }
  async function observe(bindingId:string,rawUsd:string,final=false,day=prior()) {
    return db.transaction(tx=>ingestUsage(tx,{bindingId,day,rawUsd,final,source:'test',evidence:'verified test statement'}));
  }

  it('settles four levels across two platforms with exact profit conservation and parent-only confirmation',async()=>{
    const [owner]=await db.query("SELECT * FROM users WHERE role='owner'");
    const a=await agent(owner,'a','0.3'),b=await agent(a,'b','0.2'),c=await agent(b,'c','0.1');
    const ai=await connection(),gate=await connection('gatelink'),acct=await account(c);
    const one=await db.transaction(tx=>saveBinding(tx,ai,remote('one',acct.email))),two=await db.transaction(tx=>saveBinding(tx,gate,remote('two',acct.email)));
    await observe(one.id,'100');await observe(one.id,'110');await observe(one.id,'100',true);
    await observe(two.id,'100',true);
    await observe(one.id,'100',true);
    await expect(observe(one.id,'101',true)).rejects.toThrow('已封账');
    const [conserved]=await db.query('SELECT sum(profit_usd) AS total FROM earnings');expect(conserved.total).toBe('100.00000000');
    const invoices=[];for(const u of [owner,a,b,c])invoices.push(await createInvoice(db,u,u.id,prior(),prior()));
    await expect(confirmInvoice(db,a,invoices[2].id,'early')).rejects.toThrow('尚未确认');
    await expect(confirmInvoice(db,b,invoices[1].id,'wrong parent')).rejects.toThrow('只能确认');
    for(let i=0;i<invoices.length;i++)await confirmInvoice(db,[owner,owner,a,b][i],invoices[i].id,'test remittance');
    await confirmInvoice(db,owner,invoices[0].id,'retry');
    expect((await balance(db,owner.id)).available).toBe('40.00000000');
    expect((await balance(db,a.id)).available).toBe('20.00000000');
    expect((await balance(db,b.id)).available).toBe('20.00000000');
    expect((await balance(db,c.id)).available).toBe('20.00000000');
    expect(await db.query("SELECT * FROM ledger WHERE kind='settlement'")).toHaveLength(4);
    await expect(createInvoice(db,a,a.id,prior(),prior())).rejects.toThrow('没有可结算');
    await expect(db.query("UPDATE usage_days SET raw_usd=1 WHERE id=$1",[(await db.query('SELECT id FROM usage_days'))[0].id])).rejects.toThrow('immutable');
    await expect(db.query('UPDATE earnings SET profit_usd=profit_usd WHERE user_id=$1',[c.id])).rejects.toThrow('immutable');
    await expect(db.query('DELETE FROM ledger WHERE user_id=$1',[a.id])).rejects.toThrow('append-only');
    await expect(db.query('UPDATE invoices SET profit_usd=999 WHERE id=$1',[invoices[1].id])).rejects.toThrow('immutable');
    await expect(db.query('UPDATE users SET parent_id=$2 WHERE id=$1',[c.id,owner.id])).rejects.toThrow('immutable');
  });

  it('keeps tiny-dollar rounding conserved through every agent',async()=>{
    const [owner]=await db.query("SELECT * FROM users WHERE role='owner'");
    const a=await agent(owner,'tiny-a','0.3333'),b=await agent(a,'tiny-b','0.1667'),conn=await connection('ai008','0.6667'),acct=await account(b);
    const bound=await db.transaction(tx=>saveBinding(tx,conn,remote('tiny',acct.email)));
    await observe(bound.id,'0.00000007',true);
    const [sum]=await db.query('SELECT sum(profit_usd) AS profit,max(gross_usd) AS gross FROM earnings');expect(sum.profit).toBe(sum.gross);expect(sum.gross).toBe('0.00000005');
  });

  it('does not grant earnings, platform data or control from a guessed email reservation',async()=>{
    const ownerCookie=await login('owner@example.com','correct horse battery staple');
    const created=await api(ownerCookie,'POST','/api/team',{name:'Claimant',email:'claimant@example.com',password:'claimant-password',rates:{gatelink:0.2,ai008:0.2},effectiveFrom:'1970-01-01'});
    const cookie=await login('claimant@example.com','claimant-password'),claimant=created.json().user;
    const reserved=(await api(cookie,'POST','/api/accounts',{email:'known@example.com'})).json().account,conn=await connection();
    const bound=await db.transaction(tx=>saveBinding(tx,conn,remote('known',reserved.email)));
    await observe(bound.id,'100');
    expect(await db.query('SELECT * FROM earnings')).toHaveLength(0);
    expect((await api(cookie,'GET','/api/accounts')).json().accounts[0].bindings).toHaveLength(0);
    expect((await api(cookie,'GET','/api/usage')).json().total).toBe(0);
    expect((await api(cookie,'POST',`/api/bindings/${bound.id}/status`,{enabled:false,key:id()})).statusCode).toBe(403);
    await expect(observe(bound.id,'100',true)).rejects.toThrow('核实账号归属');
    expect((await api(cookie,'POST',`/api/accounts/${reserved.id}/assign`,{userId:claimant.id})).statusCode).toBe(403);
    const [owner]=await db.query("SELECT * FROM users WHERE role='owner'");
    expect((await api(ownerCookie,'POST',`/api/accounts/${reserved.id}/assign`,{userId:owner.id})).statusCode).toBe(200);
    await observe(bound.id,'100',true);
    expect((await api(cookie,'GET','/api/accounts')).json().accounts).toHaveLength(0);
    expect((await db.query('SELECT * FROM earnings'))[0].user_id).toBe(owner.id);
  });

  it('verifies canonical email before sealing account ownership',async()=>{
    const [owner]=await db.query("SELECT * FROM users WHERE role='owner'"),acct=await account(owner,'verify@example.com',false),conn=await connection();
    await expect(db.transaction(tx=>saveBinding(tx,conn,remote('mismatch','other@example.com'),acct))).rejects.toThrow('不符');
    expect((await db.query('SELECT ownership_verified FROM accounts WHERE id=$1',[acct.id]))[0].ownership_verified).toBe(false);
    await db.transaction(tx=>saveBinding(tx,conn,remote('match',acct.email),acct));
    expect((await db.query('SELECT ownership_verified FROM accounts WHERE id=$1',[acct.id]))[0].ownership_verified).toBe(true);
    await expect(db.query("UPDATE accounts SET email='changed@example.com' WHERE id=$1",[acct.id])).rejects.toThrow('immutable');
  });

  it('deduplicates withdrawals across retries, encrypts destinations and releases rejected funds exactly once',async()=>{
    const [owner]=await db.query("SELECT * FROM users WHERE role='owner'"),a=await agent(owner,'withdraw'),other=await agent(owner,'other');
    await db.query(`INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'settlement',100,'fixture-credit')`,[id(),a.id]);
    const box=secretBox(key),requestKey=id();
    const ws=await Promise.all([requestWithdrawal(db,a,'80','bank','secret destination',requestKey,box),requestWithdrawal(db,a,'80','bank','secret destination',requestKey,box)]);
    expect(ws[0].id).toBe(ws[1].id);expect(ws[0].destination).not.toContain('secret destination');
    expect((await balance(db,a.id)).available).toBe('20.00000000');
    await expect(requestWithdrawal(db,a,'79','bank','secret destination',requestKey,box)).rejects.toThrow('另一笔');
    await expect(reviewWithdrawal(db,other,ws[0].id,'paid','wrong parent')).rejects.toThrow('直属上级');
    await reviewWithdrawal(db,owner,ws[0].id,'rejected','invalid address');
    expect((await balance(db,a.id)).available).toBe('100.00000000');
    await expect(reviewWithdrawal(db,owner,ws[0].id,'rejected','retry')).rejects.toThrow('已处理');
    await expect(db.query("UPDATE withdrawals SET state='pending' WHERE id=$1",[ws[0].id])).rejects.toThrow('immutable');
  });

  it('returns complete filtered totals and team branch statistics independently of page size',async()=>{
    const cookie=await login('owner@example.com','correct horse battery staple'),[owner]=await db.query("SELECT * FROM users WHERE role='owner'"),a=await agent(owner,'stats'),leaf=await agent(a,'stats-leaf','0.1'),acct=await account(leaf),conn=await connection();
    const bound=await db.transaction(tx=>saveBinding(tx,conn,remote('stats',acct.email)));
    for(let n=1;n<=15;n++)await observe(bound.id,'1',true,prior(n));
    const q=`from=${prior(15)}&to=${prior()}&search=claude`;
    const first=(await api(cookie,'GET','/api/usage?'+q)).json(),second=(await api(cookie,'GET','/api/usage?'+q+'&page=2')).json();
    expect(first.rows).toHaveLength(12);expect(second.rows).toHaveLength(3);expect(first.total).toBe(15);expect(first.totals.raw_usd).toBe('15.00000000');
    const team=(await api(cookie,'GET',`/api/team?from=${prior(15)}&to=${prior()}`)).json().users.find((u:any)=>u.id===a.id);
    expect(Number(team.team_account_count)).toBe(1);expect(Number(team.account_count)).toBe(0);expect(team.raw_usd).toBe('15.00000000');expect(team.profit_usd).toBe('3.00000000');
    const empty=(await api(cookie,'GET','/api/usage?search=nonexistent')).json();expect(empty.total).toBe(0);expect(empty.totals.raw_usd).toBe('0');
    for(let n=1;n<=15;n++)await createInvoice(db,owner,owner.id,prior(n),prior(n));
    const finance=(await api(cookie,'GET','/api/finance')).json(),next=(await api(cookie,'GET','/api/finance?page=2')).json();
    expect(finance.invoices).toHaveLength(12);expect(next.invoices).toHaveLength(3);expect(finance.invoicesTotal).toBe(15);expect(finance.pendingProfit).toBe('3.00000000');
  });

  it('makes batch onboarding atomic and prevents duplicate or cross-account task reuse',async()=>{
    const cookie=await login('owner@example.com','correct horse battery staple'),[owner]=await db.query("SELECT * FROM users WHERE role='owner'"),acct=await account(owner,'jobs@example.com',false),conn=await connection(),box=secretBox(key);
    const result=await api(cookie,'POST',`/api/accounts/${acct.id}/authorize`,{targets:[{connectionId:conn.id,options:{}},{connectionId:id(),options:{}}],key:id()});
    expect(result.statusCode).toBe(400);expect(await db.query('SELECT * FROM jobs')).toHaveLength(0);
    const requestKey=id(),job=await enqueue(db,box,owner.id,conn.id,'oauth_start',{accountId:acct.id},requestKey);
    expect((await enqueue(db,box,owner.id,conn.id,'oauth_start',{accountId:acct.id},requestKey)).id).toBe(job.id);
    await expect(enqueue(db,box,owner.id,conn.id,'oauth_start',{accountId:id()},requestKey)).rejects.toThrow('不同任务');
    await expect(enqueue(db,box,owner.id,conn.id,'import_rt',{accountId:acct.id},id())).rejects.toThrow('正在执行');
  });

  it('blocks foreign origins and disables the whole descendant tree when its parent is suspended',async()=>{
    const cookie=await login('owner@example.com','correct horse battery staple');
    const a=(await api(cookie,'POST','/api/team',{name:'Parent',email:'parent@example.com',password:'parent-password',rates:{gatelink:0.3,ai008:0.3}})).json().user;
    const ac=await login('parent@example.com','parent-password');
    await api(ac,'POST','/api/team',{name:'Child',email:'child@example.com',password:'child-password',rates:{gatelink:0.1,ai008:0.1}});
    const cc=await login('child@example.com','child-password');
    expect((await app.inject({method:'POST',url:'/api/accounts',headers:{cookie,origin:'https://foreign.example','x-ccmax-request':'1'},payload:{email:'bad@example.com'}})).statusCode).toBe(403);
    await api(cookie,'PATCH',`/api/team/${a.id}`,{active:false});
    expect((await api(cc,'GET','/api/dashboard')).statusCode).toBe(403);
    expect((await api(ac,'GET','/api/team')).statusCode).toBe(401);
  });

  it('recovers an interrupted external mutation without automatically executing it again',async()=>{
    const [owner]=await db.query("SELECT * FROM users WHERE role='owner'"),conn=await connection(),box=secretBox(key);
    const job=await enqueue(db,box,owner.id,conn.id,'import_rt',{accountId:id(),refreshToken:'sensitive-once'},id());
    await db.query("UPDATE jobs SET state='running',started_at=now()-interval '31 minutes' WHERE id=$1",[job.id]);
    const worker=createWorker(db,box);await worker.recover();
    const [stored]=await db.query('SELECT * FROM jobs WHERE id=$1',[job.id]);expect(stored.state).toBe('needs_attention');expect(box.decrypt(stored.payload)).toEqual({});expect(await worker.runOne()).toBe(false);
  });

});
