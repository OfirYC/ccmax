import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, type DB } from './db.js';
import { bootstrap, id, today, nextDay, secretBox } from './core.js';
import { createApp } from './app.js';
import { ingestUsage, requestWithdrawal, balance, createInvoice, confirmInvoice, reviewWithdrawal } from './billing.js';
import { openTestDB, seedSettlement } from './test-db.js';
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
    await seedSettlement(db, agentId, '100');
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
  async function bindProxy(cookie:string,acct:any,url='http://test-user:test-secret@proxy.example.com:8080') {
    const response=await api(cookie,'POST','/api/proxies',{name:'Fixed test proxy',url});expect(response.statusCode).toBe(200);
    const proxyId=response.json().id;expect((await api(cookie,'POST',`/api/accounts/${acct.id}/proxy`,{proxyId})).statusCode).toBe(200);return proxyId;
  }
  async function observe(bindingId:string,rawUsd:string,final=false,day=prior()) {
    return db.transaction(tx=>ingestUsage(tx,{bindingId,day,rawUsd,final,source:'test',evidence:'verified test statement'}));
  }

  it('shows each user their own current and scheduled prices without changing the upstream contract or sealed earnings',async()=>{
    const ownerCookie=await login('owner@example.com','correct horse battery staple'),[owner]=await db.query("SELECT * FROM users WHERE role='owner'"),ai=await connection('ai008','0.5');await connection('gatelink','0.6');await connection('minicc','0.7');
    const child=(await api(ownerCookie,'POST','/api/team',{name:'Price child',email:'price-child@example.com',password:'price-child-password',rates:{ai008:0.2,gatelink:0},effectiveFrom:'1970-01-01'})).json().user;
    const childCookie=await login(child.email,'price-child-password');
    const leaf=(await api(childCookie,'POST','/api/team',{name:'Price leaf',email:'price-leaf@example.com',password:'price-leaf-password',rates:{ai008:0.1},effectiveFrom:'1970-01-01'})).json().user,leafCookie=await login(leaf.email,'price-leaf-password');
    const acct=await account(child,'priced-account@example.com'),binding=await db.transaction(tx=>saveBinding(tx,ai,remote('price-remote',acct.email)));await observe(binding.id,'100',true);
    const earningsBefore=await db.query('SELECT user_id,rate,gross_usd,profit_usd FROM earnings ORDER BY user_id');
    const changed=await api(ownerCookie,'PUT',`/api/team/${child.id}/rates`,{provider:'ai008',rate:0.25});expect(changed.json().effectiveDate).toBe(nextDay());
    const teamPrices=(await api(childCookie,'GET','/api/team')).json();
    expect(teamPrices.rates.find((r:any)=>r.user_id===child.id&&r.provider==='ai008').effective_date).toBe('1970-01-01');
    expect(teamPrices.upcoming.find((r:any)=>r.user_id===child.id&&r.provider==='ai008').effective_date).toBe(nextDay());
    const mine=(cookie:string)=>api(cookie,'GET','/api/connections').then(r=>r.json().connections);
    const ownerPrices=await mine(ownerCookie),childPrices=await mine(childCookie),leafPrices=await mine(leafCookie);
    expect(ownerPrices.find((c:any)=>c.id===ai.id)).toMatchObject({payout_rate:'0.5000',settlement_rate:'0.5000',upcoming_settlement_rate:null});
    expect(childPrices.find((c:any)=>c.id===ai.id)).toMatchObject({settlement_rate:'0.2000',settlement_effective_date:'1970-01-01',upcoming_settlement_rate:'0.2500',upcoming_settlement_date:nextDay()});
    expect(childPrices.find((c:any)=>c.provider==='gatelink').settlement_rate).toBe('0.0000');
    expect(childPrices.find((c:any)=>c.provider==='minicc')).toMatchObject({settlement_rate:null,upcoming_settlement_rate:null});
    expect(childPrices.every((c:any)=>!Object.hasOwn(c,'payout_rate')&&!Object.hasOwn(c,'upcoming_payout_rate'))).toBe(true);
    expect(leafPrices.find((c:any)=>c.id===ai.id)).toMatchObject({settlement_rate:'0.1000',upcoming_settlement_rate:null});
    expect((await api(childCookie,'PUT',`/api/team/${child.id}/rates`,{provider:'ai008',rate:0.8})).statusCode).toBe(403);
    expect((await api(childCookie,'PATCH',`/api/connections/${ai.id}`,{payoutRate:0.8})).statusCode).toBe(403);
    expect((await api(ownerCookie,'PATCH',`/api/connections/${ai.id}`,{payoutRate:0.55})).statusCode).toBe(200);
    expect((await mine(childCookie)).find((c:any)=>c.id===ai.id)).toMatchObject({settlement_rate:'0.2000',upcoming_settlement_rate:'0.2500'});
    const tomorrow=nextDay(),clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse(`${tomorrow}T00:00:00+08:00`));
    try {
      expect((await mine(childCookie)).find((c:any)=>c.id===ai.id)).toMatchObject({settlement_rate:'0.2500',settlement_effective_date:tomorrow,upcoming_settlement_rate:null});
      expect((await mine(ownerCookie)).find((c:any)=>c.id===ai.id)).toMatchObject({settlement_rate:'0.5500',upcoming_settlement_rate:null});
    } finally {clock.mockRestore();}
    expect(await db.query('SELECT user_id,rate,gross_usd,profit_usd FROM earnings ORDER BY user_id')).toEqual(earningsBefore);
  });

  it('hides private platform account labels for every role, including admin views and CSV exports',async()=>{
    const ownerCookie=await login('owner@example.com','correct horse battery staple'),conn=await connection(),internal='private-platform-login@example.com';
    await db.query('UPDATE connections SET name=$2 WHERE id=$1',[conn.id,internal]);
    const child=(await api(ownerCookie,'POST','/api/team',{name:'Private labels',email:'private-labels@example.com',password:'private-labels-password',rates:{ai008:0.2},effectiveFrom:'1970-01-01'})).json().user,childCookie=await login(child.email,'private-labels-password');
    const acct=await account(child,'owned-claude@example.com'),proxyId=await bindProxy(childCookie,acct),box=secretBox(key);
    await db.query('INSERT INTO proxy_bindings(id,proxy_id,connection_id,external_id) VALUES($1,$2,$3,$4)',[id(),proxyId,conn.id,'fixed']);
    const binding=await db.transaction(tx=>saveBinding(tx,conn,{...remote('private-remote',acct.email),proxyExternalId:'fixed'}));await observe(binding.id,'100',true);
    await enqueue(db,box,child.id,conn.id,'set_enabled',{bindingId:binding.id,enabled:false},id());
    await db.query('INSERT INTO oauth_attempts(id,user_id,connection_id,account_id,secret,authorization_url,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id(),child.id,conn.id,acct.id,box.encrypt({}),'https://auth.example.com/test',new Date(Date.now()+600000)]);
    const invoice=await createInvoice(db,child,child.id,prior(),prior());
    const history=await db.query('SELECT * FROM usage_days'),earnings=await db.query('SELECT * FROM earnings');
    const paths=['/api/connections','/api/dashboard','/api/accounts','/api/jobs','/api/proxies','/api/telemetry','/api/usage','/api/usage/export',`/api/invoices/${invoice.id}/export`,`/api/invoices/preview?from=1970-01-01&to=${prior()}`];
    for(const cookie of [ownerCookie,childCookie])for(const path of paths) {
      const response=await api(cookie,'GET',path);expect(response.statusCode,path).toBe(200);expect(response.body,path).not.toContain(internal);expect(response.body,path).toContain(`AI008 · ${conn.id.slice(0,8)}`);
    }
    expect((await api(childCookie,'GET',`/api/accounts/${acct.id}/attempts`)).body).not.toContain(internal);
    expect((await db.query('SELECT name FROM connections WHERE id=$1',[conn.id]))[0].name).toBe(internal);
    expect(await db.query('SELECT * FROM usage_days')).toEqual(history);
    expect(await db.query('SELECT * FROM earnings')).toEqual(earnings);
  });

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

  it('requires independent Mini CC pricing throughout the tree and preserves historical profits',async()=>{
    const cookie=await login('owner@example.com','correct horse battery staple');
    const created=await api(cookie,'POST','/api/team',{name:'Mini Parent',email:'mini-parent@example.com',password:'mini-parent-password',rates:{ai008:0.3,gatelink:0.3},effectiveFrom:'1970-01-01'});
    expect(created.statusCode).toBe(200);
    const a=created.json().user,ac=await login(a.email,'mini-parent-password');
    const b=(await api(ac,'POST','/api/team',{name:'Mini Leaf',email:'mini-leaf@example.com',password:'mini-leaf-password',rates:{ai008:0.1,gatelink:0.1},effectiveFrom:'1970-01-01'})).json().user;
    const team=(await api(cookie,'GET','/api/team')).json();
    expect(team.providers.minicc.historicalUsage).toBe(true);
    expect(team.rates.filter((r:any)=>r.provider==='minicc')).toHaveLength(0);
    const mini=await connection('minicc','0.8'),ai=await connection('ai008','0.5'),acct=await account(b);
    const binding=await db.transaction(tx=>saveBinding(tx,mini,remote('mini-remote',acct.email)));
    await expect(observe(binding.id,'100',true)).rejects.toThrow('没有 minicc 结算折扣');
    expect(await db.query('SELECT * FROM usage_days')).toHaveLength(0);
    expect((await api(cookie,'PUT',`/api/team/${a.id}/rates`,{provider:'minicc',rate:0.6,effectiveFrom:prior()})).json().effectiveDate).toBe(prior());
    expect((await api(cookie,'PUT',`/api/team/${b.id}/rates`,{provider:'minicc',rate:0.25,effectiveFrom:prior()})).statusCode).toBe(403);
    expect((await api(ac,'PUT',`/api/team/${b.id}/rates`,{provider:'minicc',rate:0.25,effectiveFrom:prior()})).json().effectiveDate).toBe(prior());
    await observe(binding.id,'100',true);
    const aiBinding=await db.transaction(tx=>saveBinding(tx,ai,remote('ai-remote',acct.email)));
    await observe(aiBinding.id,'100',true);
    const profits=await db.query('SELECT user_id,sum(profit_usd) AS profit FROM earnings GROUP BY user_id');
    expect(profits.find(r=>r.user_id===a.id)?.profit).toBe('55.00000000');
    expect(profits.find(r=>r.user_id===b.id)?.profit).toBe('35.00000000');
    expect((await api(cookie,'PUT',`/api/team/${a.id}/rates`,{provider:'minicc',rate:0.9,effectiveFrom:prior()})).statusCode).toBe(400);
    const changed=await api(cookie,'PUT',`/api/team/${a.id}/rates`,{provider:'minicc',rate:0.9});
    expect(changed.statusCode).toBe(200);expect(changed.json().effectiveDate).toBe(nextDay());
    const allowed=await api(cookie,'PUT',`/api/team/${a.id}/rates`,{provider:'minicc',rate:0.7});expect(allowed.statusCode).toBe(200);expect(allowed.json().effectiveDate>today()).toBe(true);
    await observe(binding.id,'100',true);
    expect((await db.query('SELECT sum(profit_usd) AS profit FROM earnings WHERE user_id=$1',[a.id]))[0].profit).toBe('55.00000000');
    const usage=(await api(cookie,'GET',`/api/usage?provider=minicc&from=${prior()}&to=${prior()}`)).json();
    expect(usage.total).toBe(1);expect(usage.totals.raw_usd).toBe('100.00000000');
  });

  it('allows Mini CC onboarding and history jobs by capability without exposing credentials',async()=>{
    const cookie=await login('owner@example.com','correct horse battery staple'),[owner]=await db.query("SELECT * FROM users WHERE role='owner'");
    const created=await api(cookie,'POST','/api/connections',{provider:'minicc',name:'Mini CC',username:'private-username',password:'private-password',payoutRate:0.5});
    expect(created.statusCode).toBe(200);const cid=created.json().id;
    const connections=(await api(cookie,'GET','/api/connections')).json();
    expect(connections.connections[0].capabilities.refreshTokenImport).toBe(true);
    expect(JSON.stringify(connections)).not.toContain('private-password');
    const acct=await account(owner,'new-mini@example.com',false);await bindProxy(cookie,acct);
    const imported=await api(cookie,'POST',`/api/accounts/${acct.id}/import-token`,{connectionId:cid,refreshToken:'owned-private-refresh-token',options:{},key:id()});
    expect(imported.statusCode).toBe(200);
    const [job]=await db.query('SELECT * FROM jobs WHERE id=$1',[imported.json().id]);
    expect(job.kind).toBe('import_rt');expect(job.payload).not.toContain('owned-private-refresh-token');
    expect((await api(cookie,'POST',`/api/connections/${cid}/reconcile`,{day:prior(),key:id()})).statusCode).toBe(200);
    const gate=await connection('gatelink');
    expect((await api(cookie,'POST',`/api/connections/${gate.id}/reconcile`,{day:prior(),key:id()})).statusCode).toBe(400);
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
    await seedSettlement(db,a.id,'100');
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
    const cookie=await login('owner@example.com','correct horse battery staple'),[owner]=await db.query("SELECT * FROM users WHERE role='owner'"),acct=await account(owner,'jobs@example.com',false),conn=await connection(),box=secretBox(key);await bindProxy(cookie,acct);
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

  it('encrypts proxy credentials, isolates teams and reserves one proxy for one account',async()=>{
    const cookie=await login('owner@example.com','correct horse battery staple'),[owner]=await db.query("SELECT * FROM users WHERE role='owner'");
    const acct=await account(owner,'proxy-one@example.com',false),other=await account(owner,'proxy-two@example.com',false),proxyId=await bindProxy(cookie,acct);
    const [stored]=await db.query('SELECT * FROM proxies WHERE id=$1',[proxyId]);
    expect(stored.secret).not.toContain('test-secret');expect(secretBox(key).decrypt(stored.secret).url).toContain('test-secret');
    const shown=JSON.stringify((await api(cookie,'GET','/api/proxies')).json());expect(shown).not.toContain('test-secret');expect(shown).not.toContain('test-user');
    expect((await api(cookie,'POST',`/api/accounts/${other.id}/proxy`,{proxyId})).statusCode).toBe(409);
    expect((await api(cookie,'POST','/api/proxies',{name:'Same proxy, rotated password',url:'http://test-user:changed-password@PROXY.example.com:8080'})).statusCode).toBe(409);
    const p2=(await api(cookie,'POST','/api/proxies',{name:'Second',url:'https://other.example.com:8443'})).json().id;
    expect((await api(cookie,'POST',`/api/accounts/${acct.id}/proxy`,{proxyId:p2})).statusCode).toBe(409);
    await expect(db.query('UPDATE accounts SET proxy_id=$2 WHERE id=$1',[acct.id,p2])).rejects.toThrow('immutable');
    await expect(db.query("UPDATE proxies SET secret='changed' WHERE id=$1",[proxyId])).rejects.toThrow('immutable');
    const u=(await api(cookie,'POST','/api/team',{name:'Proxy sibling',email:'proxy-sibling@example.com',password:'proxy-sibling-password',rates:{ai008:0.2}})).json().user;
    const siblingCookie=await login(u.email,'proxy-sibling-password'),siblingAccount=(await api(siblingCookie,'POST','/api/accounts',{email:'sibling-claude@example.com'})).json().account;
    expect((await api(siblingCookie,'GET','/api/proxies')).json().proxies).toHaveLength(0);
    expect((await api(siblingCookie,'POST',`/api/accounts/${siblingAccount.id}/proxy`,{proxyId:p2})).statusCode).toBe(403);
    expect((await api(siblingCookie,'PATCH',`/api/proxies/${proxyId}`,{enabled:false})).statusCode).toBe(403);
    const siblingProxy=(await api(siblingCookie,'POST','/api/proxies',{name:'Sibling-owned proxy',url:'http://sibling.proxy.example.com:8080'})).json().id;
    expect((await api(cookie,'POST',`/api/accounts/${other.id}/proxy`,{proxyId:siblingProxy})).statusCode).toBe(403);
    expect((await api(siblingCookie,'POST',`/api/accounts/${siblingAccount.id}/proxy`,{proxyId:siblingProxy})).statusCode).toBe(200);
    expect((await api(cookie,'POST',`/api/accounts/${siblingAccount.id}/assign`,{userId:owner.id})).statusCode).toBe(409);
    expect((await api(cookie,'POST','/api/proxies',{name:'Invalid',url:'http://private-user:private-secret@proxy.example.com/path'})).statusCode).toBe(400);
  });

  it('requires a proxy for every onboarding path and rechecks it before a queued job executes',async()=>{
    const cookie=await login('owner@example.com','correct horse battery staple'),[owner]=await db.query("SELECT * FROM users WHERE role='owner'"),acct=await account(owner,'mandatory@example.com',false),conn=await connection();
    const targets=[{connectionId:conn.id,options:{}}];
    expect((await api(cookie,'POST',`/api/accounts/${acct.id}/authorize`,{targets,key:id()})).statusCode).toBe(400);
    expect((await api(cookie,'POST',`/api/accounts/${acct.id}/import-token`,{connectionId:conn.id,refreshToken:'private-owned-token',options:{},key:id()})).statusCode).toBe(400);
    const proxyId=await bindProxy(cookie,acct);
    expect((await api(cookie,'POST',`/api/accounts/${acct.id}/authorize`,{targets:[{connectionId:conn.id,options:{proxy:'https://bypass.example.com:443'}}],key:id()})).statusCode).toBe(400);
    expect((await api(cookie,'POST',`/api/accounts/${acct.id}/import-token`,{connectionId:conn.id,refreshToken:'private-owned-token',options:{proxyExternalId:'bypass'},key:id()})).statusCode).toBe(400);
    const queued=await api(cookie,'POST',`/api/accounts/${acct.id}/authorize`,{targets,key:id()});expect(queued.statusCode).toBe(200);
    const [job]=await db.query('SELECT * FROM jobs WHERE id=$1',[queued.json().jobs[0].id]);expect(secretBox(key).decrypt(job.payload).proxyId).toBe(proxyId);
    await api(cookie,'PATCH',`/api/proxies/${proxyId}`,{enabled:false});
    let requests=0;
    const {ProviderClient}=await import('./providers.js');
    const worker=createWorker(db,secretBox(key),(p,c)=>new ProviderClient(p,c,async()=>{requests++;return Response.json({});}));
    await worker.runOne();expect(requests).toBe(0);
    expect((await db.query('SELECT state FROM jobs WHERE id=$1',[job.id]))[0].state).toBe('failed');
    expect((await api(cookie,'POST',`/api/accounts/${acct.id}/authorize`,{targets,key:id()})).statusCode).toBe(400);
  });

  it('detects upstream proxy drift without changing sealed usage and restores verification after reconciliation',async()=>{
    const cookie=await login('owner@example.com','correct horse battery staple'),[owner]=await db.query("SELECT * FROM users WHERE role='owner'"),acct=await account(owner,'drift@example.com'),conn=await connection('minicc'),proxyId=await bindProxy(cookie,acct);
    await db.query('INSERT INTO proxy_bindings(id,proxy_id,connection_id,external_id) VALUES($1,$2,$3,$4)',[id(),proxyId,conn.id,'expected-proxy']);
    const observed={...remote('drift',acct.email),proxyExternalId:'expected-proxy'};
    const binding=await db.transaction(tx=>saveBinding(tx,conn,observed));expect(binding.proxy_id).toBe(proxyId);
    await observe(binding.id,'100',true);
    const changed=await db.transaction(tx=>saveBinding(tx,conn,{...observed,proxyExternalId:'wrong-proxy'}));expect(changed.proxy_id).toBeNull();
    const second=await connection('ai008');
    expect((await api(cookie,'POST',`/api/accounts/${acct.id}/authorize`,{targets:[{connectionId:second.id,options:{}}],key:id()})).statusCode).toBe(409);
    expect((await api(cookie,'POST',`/api/bindings/${binding.id}/status`,{enabled:true,key:id()})).statusCode).toBe(409);
    const restored=await db.transaction(tx=>saveBinding(tx,conn,observed));expect(restored.proxy_id).toBe(proxyId);
    expect((await db.query('SELECT raw_usd,state FROM usage_days'))[0]).toMatchObject({raw_usd:'100.00000000',state:'final'});
    expect((await db.query('SELECT profit_usd FROM earnings'))[0].profit_usd).toBe('50.00000000');
    const foreign=(await api(cookie,'POST','/api/proxies',{name:'Foreign proxy',url:'http://different.example.com:80'})).json().id;
    await expect(db.query('UPDATE bindings SET proxy_id=$2 WHERE id=$1',[binding.id,foreign])).rejects.toThrow('differs');
  });

  it('repairs legacy platform bindings through audited fixed-proxy jobs and restricts manual confirmation to Gatelink administrators',async()=>{
    const cookie=await login('owner@example.com','correct horse battery staple'),[owner]=await db.query("SELECT * FROM users WHERE role='owner'"),acct=await account(owner,'legacy-proxy@example.com'),proxyId=await bindProxy(cookie,acct),box=secretBox(key);
    const {ProviderClient}=await import('./providers.js');
    const actual=new Map<string,string>(),writes:string[]=[];
    const worker=createWorker(db,box,(provider,credentials)=>new ProviderClient(provider,credentials,async(input,init={})=>{
      const path=new URL(String(input)).pathname,body=init.body?JSON.parse(String(init.body)):{};
      if(path==='/api/login')return Response.json({role:'supplier'},{headers:{'set-cookie':'mini_session=test; Path=/; HttpOnly'}});
      if(path==='/api/me')return Response.json({authenticated:true,user:{role:'supplier'}});
      if(path.endsWith('/auth/admin-login'))return Response.json({user:{role:'admin'},accessToken:'session'});
      if(path.endsWith('/proxies/manage')||path.endsWith('/outbound-proxies'))return Response.json({total:1,proxies:[{id:'fixed',upstream_id:'fixed',scheme:'http',host:'proxy.example.com',port:8080,status:'active',at_bound_account_limit:true,selectable:false}]});
      if(body.outbound_proxy_id) {actual.set(provider,body.outbound_proxy_id);writes.push(provider);return Response.json({});}
      return Response.json({account:{email:acct.email,outbound_proxy_id:actual.get(provider)}});
    }));
    const bindings=[];
    for(const provider of ['ai008','minicc','gatelink']) {
      const conn=await connection(provider),binding=await db.transaction(tx=>saveBinding(tx,conn,remote(`legacy-${provider}`,acct.email)));bindings.push(binding);
      expect(binding.proxy_id).toBeNull();
      if(provider==='gatelink')continue;
      await db.query('INSERT INTO proxy_bindings(id,proxy_id,connection_id,external_id) VALUES($1,$2,$3,$4)',[id(),proxyId,conn.id,'fixed']);
      expect((await api(cookie,'POST',`/api/bindings/${binding.id}/proxy/confirm`,{evidence:'Cannot bypass the real upstream verification'})).statusCode).toBe(400);
      const queued=await api(cookie,'POST',`/api/bindings/${binding.id}/proxy/sync`,{key:id()});expect(queued.statusCode).toBe(200);
      await worker.runOne();expect((await db.query('SELECT state FROM jobs WHERE id=$1',[queued.json().id]))[0].state).toBe('succeeded');
    }
    expect(writes.sort()).toEqual(['ai008','minicc']);
    const gate=bindings[2];
    expect((await api(cookie,'POST',`/api/bindings/${gate.id}/proxy/sync`,{key:id()})).statusCode).toBe(400);
    expect((await api(cookie,'POST',`/api/bindings/${gate.id}/proxy/confirm`,{evidence:'Verified the same proxy URL and authentication in Gatelink'})).statusCode).toBe(200);
    expect((await db.query('SELECT proxy_id FROM bindings WHERE account_id=$1',[acct.id])).every(b=>b.proxy_id===proxyId)).toBe(true);
    expect(await db.query("SELECT id FROM audits WHERE action IN ('binding.proxy.sync','binding.proxy.manual_confirm')")).toHaveLength(3);
    const child=(await api(cookie,'POST','/api/team',{name:'Proxy child',email:'proxy-child@example.com',password:'proxy-child-password',rates:{ai008:0.2}})).json().user;
    const childCookie=await login(child.email,'proxy-child-password');
    expect((await api(childCookie,'POST',`/api/bindings/${gate.id}/proxy/confirm`,{evidence:'Untrusted confirmation'})).statusCode).toBe(403);
    expect((await api(childCookie,'POST',`/api/bindings/${bindings[0].id}/proxy/sync`,{key:id()})).statusCode).toBe(403);
  });

  it('keeps each platform attempt usable after a callback for another platform or an incomplete code',async()=>{
    const cookie=await login('owner@example.com','correct horse battery staple'),[owner]=await db.query("SELECT * FROM users WHERE role='owner'"),acct=await account(owner,'callback-check@example.com',false),proxyId=await bindProxy(cookie,acct),box=secretBox(key);
    for(const provider of ['gatelink','ai008','minicc']){
      const conn=await connection(provider),attemptId=id(),pendingState=`state-${provider}`;
      // Exercise pre-fix Gatelink attempts whose state was only in the URL.
      const secret={options:{email:acct.email,proxy:'http://test-user:test-secret@proxy.example.com:8080'},proxyId,...(provider==='gatelink'?{}:{pendingState})};
      await db.query(`INSERT INTO oauth_attempts(id,user_id,connection_id,account_id,secret,authorization_url,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[attemptId,owner.id,conn.id,acct.id,box.encrypt(secret),`https://auth.example.com/?state=${pendingState}`,new Date(Date.now()+600000)]);
      for(const callback of ['wrong-code#other-platform','incomplete-code','https://callback.example/?code=ambiguous&state='+pendingState+'&state=other']){
        const response=await api(cookie,'POST',`/api/oauth/${attemptId}/exchange`,{callback,key:id()});
        expect(response.statusCode).toBe(400);
        expect(response.body).not.toContain('wrong-code');
        expect((await db.query('SELECT state FROM oauth_attempts WHERE id=$1',[attemptId]))[0].state).toBe('pending');
      }
      expect((await api(cookie,'POST',`/api/oauth/${attemptId}/exchange`,{callback:`unique-${provider}#${pendingState}`,key:id()})).statusCode).toBe(200);
      expect(box.decrypt((await db.query('SELECT secret FROM oauth_attempts WHERE id=$1',[attemptId]))[0].secret).pendingState).toBe(pendingState);
    }
    expect(await db.query('SELECT * FROM jobs')).toHaveLength(3);
    expect(await db.query('SELECT * FROM oauth_code_claims')).toHaveLength(3);
    expect(await db.query('SELECT * FROM bindings')).toHaveLength(0);
  });

  it('claims a code once across concurrent platform requests while preserving safe idempotent retries',async()=>{
    const cookie=await login('owner@example.com','correct horse battery staple'),[owner]=await db.query("SELECT * FROM users WHERE role='owner'"),acct=await account(owner,'one-code@example.com',false),proxyId=await bindProxy(cookie,acct),box=secretBox(key);
    const attempts:{attemptId:string;requestKey:string;callback:string}[]=[];
    for(const provider of ['ai008','minicc']){
      const conn=await connection(provider),attemptId=id(),pendingState=`state-${provider}`,requestKey=id();
      await db.query(`INSERT INTO oauth_attempts(id,user_id,connection_id,account_id,secret,authorization_url,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[attemptId,owner.id,conn.id,acct.id,box.encrypt({options:{email:acct.email},proxyId,pendingState}),`https://auth.example.com/?state=${pendingState}`,new Date(Date.now()+600000)]);
      attempts.push({attemptId,requestKey,callback:`private-same-code#${pendingState}`});
    }
    const send=(attempt:typeof attempts[number])=>api(cookie,'POST',`/api/oauth/${attempt.attemptId}/exchange`,{callback:attempt.callback,key:attempt.requestKey});
    const results=await Promise.all(attempts.map(send));
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);
    const accepted=results.findIndex(r=>r.statusCode===200),rejected=1-accepted;
    expect((await send(attempts[accepted])).json().id).toBe(results[accepted].json().id);
    expect((await db.query('SELECT state FROM oauth_attempts WHERE id=$1',[attempts[rejected].attemptId]))[0].state).toBe('pending');
    const claims=await db.query('SELECT * FROM oauth_code_claims');
    expect(claims).toHaveLength(1);expect(JSON.stringify(claims)).not.toContain('private-same-code');
    expect(await db.query('SELECT * FROM jobs')).toHaveLength(1);
  });

  it('automatically verifies the submitting agent through all three OAuth flows without manual assignment',async()=>{
    const ownerCookie=await login('owner@example.com','correct horse battery staple');
    const created=await api(ownerCookie,'POST','/api/team',{name:'Onboarding agent',email:'onboarding-agent@example.com',password:'onboarding-agent-password',rates:{gatelink:0.2,ai008:0.2,minicc:0.2}});
    expect(created.statusCode).toBe(200);const member=created.json().user,cookie=await login(member.email,'onboarding-agent-password');
    const submitted=await api(cookie,'POST','/api/accounts',{email:'all-platforms@example.com'});expect(submitted.statusCode).toBe(200);
    const acct=submitted.json().account,proxyId=await bindProxy(cookie,acct),box=secretBox(key);
    expect(acct).toMatchObject({owner_id:member.id,submitted_by:member.id,ownership_verified:false});
    const conns=await Promise.all(['gatelink','ai008','minicc'].map(p=>connection(p)));
    const {ProviderClient}=await import('./providers.js');
    const imported=new Set<string>(),actualProxyUrls:string[]=[];
    const worker=createWorker(db,box,(provider,credentials)=>new ProviderClient(provider,credentials,async(input,init={})=>{
      const path=new URL(String(input)).pathname,body=init.body?JSON.parse(String(init.body)):{};
      if(path==='/api/login')return Response.json({role:'supplier'},{headers:{'set-cookie':'mini_session=test; Path=/; HttpOnly'}});
      if(path==='/api/me')return Response.json({authenticated:true,user:{role:'supplier'}});
      if(path.endsWith('/auth/login'))return Response.json({user:{role:'supplier'},csrfToken:'csrf'});
      if(path.endsWith('/auth/admin-login'))return Response.json({user:{role:'admin'},accessToken:'session'});
      if(path==='/api/meta')return Response.json({groups:[{id:'group',name:'Group'}],policyTemplates:[{id:'policy',name:'Policy',is_default:true,group_ids:['group'],policy:{max_rpm:1,max_tpm:1,max_concurrent:1,max_sessions:1}}],ccTemplates:[{id:'cc',name:'CC',is_default:true}]});
      if(path.endsWith('/proxies/manage')||path.endsWith('/outbound-proxies'))return Response.json({proxies:imported.has(provider)?[{id:'local',upstream_id:`remote-${provider}`,...(provider==='ai008'?{id:`remote-${provider}`} : {}),scheme:'http',host:'proxy.example.com',port:8080,status:'active'}]:[],total:imported.has(provider)?1:0});
      if(path.endsWith('/proxies/import')||path.endsWith('/outbound-proxies/import')) {
        actualProxyUrls.push(body.text);imported.add(provider);return Response.json({imported:1,failed:0});
      }
      if(path.endsWith('/authorize')) {actualProxyUrls.push(body.proxy);return Response.json({authorizationUrl:'https://auth.example.com/gate?state=state-gatelink'});}
      if(path.endsWith('/auth-url')) {
        expect(body.outbound_proxy_mode).toBe('manual');expect(body.outbound_proxy_id).toBe(`remote-${provider}`);
        return Response.json({url:`https://auth.example.com/${provider}`,state:`state-${provider}`});
      }
      if(path.endsWith('/exchange')) {
        if(provider==='gatelink') {actualProxyUrls.push(body.proxy);return Response.json({item:{id:'acct-gate',upstreamEmail:acct.email}});}
        expect(body.outbound_proxy_mode).toBe('manual');expect(body.outbound_proxy_id).toBe(`remote-${provider}`);
        expect(body.code).toBe(`one-use-${conns.find(c=>c.provider===provider)!.id}#state-${provider}`);expect(body.pending_state).toBe(`state-${provider}`);
        return Response.json({id:`acct-${provider}`});
      }
      if(path.endsWith('/detail')||path.endsWith('/acct-ai008'))return Response.json({account:{email:acct.email,outbound_proxy_id:`remote-${provider}`}});
      throw new Error('Unexpected mocked upstream endpoint');
    }));
    const started=await api(cookie,'POST',`/api/accounts/${acct.id}/authorize`,{targets:conns.map(c=>({connectionId:c.id,options:{}})),key:id()});expect(started.statusCode).toBe(200);
    for(let i=0;i<3;i++)await worker.runOne();
    const attempts=await db.query('SELECT * FROM oauth_attempts');expect(attempts).toHaveLength(3);
    const exchanges:{attemptId:string;callback:string;key:string}[]=[];
    for(const attempt of attempts) {
      const secret=box.decrypt(attempt.secret);expect(secret.proxyId).toBe(proxyId);expect(secret.options.proxy).toBe('http://test-user:test-secret@proxy.example.com:8080');
      const callback=`one-use-${attempt.connection_id}#${secret.pendingState}`;
      const request={attemptId:attempt.id,callback,key:id()};exchanges.push(request);
      expect((await api(cookie,'POST',`/api/oauth/${attempt.id}/exchange`,{callback,key:request.key})).statusCode).toBe(200);
    }
    for(let i=0;i<3;i++)await worker.runOne();
    const jobs=await db.query('SELECT kind,state,error FROM jobs');expect(jobs.every(j=>j.state==='succeeded')).toBe(true);
    expect(await db.query('SELECT * FROM bindings WHERE proxy_id=$1',[proxyId])).toHaveLength(3);
    const visible=(await api(cookie,'GET','/api/accounts')).json().accounts.find((a:any)=>a.id===acct.id);
    expect(visible).toMatchObject({owner_id:member.id,submitted_by:member.id,ownership_verified:true});expect(visible.bindings).toHaveLength(3);
    expect(await db.query("SELECT id FROM audits WHERE action='account.assign'")).toHaveLength(0);
    expect((await db.query("SELECT daily_usd FROM bindings WHERE external_id='acct-gate'"))[0].daily_usd).toBeNull();
    expect(await db.query('SELECT * FROM usage_days')).toHaveLength(0);
    expect(await db.query('SELECT * FROM earnings')).toHaveLength(0);
    expect(new Set(actualProxyUrls)).toEqual(new Set(['http://test-user:test-secret@proxy.example.com:8080']));
    expect(await db.query('SELECT * FROM proxy_bindings WHERE proxy_id=$1',[proxyId])).toHaveLength(2);
    await api(cookie,'PATCH',`/api/proxies/${proxyId}`,{enabled:false});
    for(const request of exchanges) {
      const url=`/api/oauth/${request.attemptId}/exchange`;
      const retry=await api(cookie,'POST',url,{callback:request.callback,key:request.key});
      expect(retry.statusCode).toBe(200);expect(retry.json().state).toBe('succeeded');
      expect((await api(cookie,'POST',url,{callback:'changed-callback',key:request.key})).statusCode).toBe(409);
    }
    expect(await db.query('SELECT id FROM jobs')).toHaveLength(6);
  });

});
