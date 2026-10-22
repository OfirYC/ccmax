import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DB, Row } from './db.js';
import { migrate } from './db.js';
import { openTestDB, seedSettlement } from './test-db.js';
import { bootstrap, id, nextDay, secretBox, today } from './core.js';
import { createApp } from './app.js';
import { balance, confirmInvoice, createInvoice, ingestUsage, requestWithdrawal, reviewWithdrawal } from './billing.js';
import { assertWalletAccounting } from './financial-integrity.js';

describe('pricing risk reports and atomic batch adjustments',()=>{
  let db:DB,app:FastifyInstance,owner:Row,parent:Row,child:Row,leaf:Row,sibling:Row,connectionId:string;
  const encryptionKey='91'.repeat(32);
  async function quote(user:Row,rate:string,date='1970-01-01') {
    await db.query(`INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,'ai008',$3,$4,$5) ON CONFLICT(user_id,provider,effective_date) DO UPDATE SET rate=EXCLUDED.rate`,[id(),user.id,rate,date,user.parent_id]);
  }
  async function user(upper:Row,name:string,rate?:string) {
    const [u]=await db.query(`INSERT INTO users(id,parent_id,name,email,password_hash) VALUES($1,$2,$3,$4,'x') RETURNING *`,[id(),upper.id,name,name+'@example.com']);
    if(rate!==undefined)await quote(u,rate);return u;
  }
  async function call(actor:Row,method:string,url:string,payload?:any) {
    // A real authenticated session; avoid password hashing per request.
    const token=id();
    const {createHash}=await import('node:crypto');
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[createHash('sha256').update(token).digest('hex'),actor.id]);
    return app.inject({method:method as any,url,headers:{cookie:`ccmax_session=${token}`,'x-ccmax-request':'1'},payload});
  }
  const input=(userIds:string[],mode='cap',value?:number)=>({provider:'ai008',userIds,mode,...value===undefined?{}:{value}});
  async function preview(actor:Row,data:any) {const r=await call(actor,'POST','/api/team/rates/preview',data);expect(r.statusCode,r.body).toBe(200);return r.json();}
  async function apply(actor:Row,data:any,plan:any,acknowledgeRisk=false) {return call(actor,'POST','/api/team/rates/batch',{...data,snapshot:plan.snapshot,acknowledgeRisk});}

  beforeEach(async()=>{
    db=await openTestDB();await migrate(db);await bootstrap(db,{ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'pricing-owner-password'});
    [owner]=await db.query("SELECT * FROM users WHERE role='owner'");
    parent=await user(owner,'parent','0.4');child=await user(parent,'child','0.3');leaf=await user(child,'leaf','0.1');sibling=await user(owner,'sibling','0.35');
    connectionId=id();
    await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','private-upstream-identity',$2,0.5)",[connectionId,secretBox(encryptionKey).encrypt({username:'private-login',password:'private-secret'})]);
    await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,0.5,'1970-01-01')",[id(),connectionId]);
    ({app}=await createApp(db,{encryptionKey,appUrl:'http://localhost:3000'}));
  });
  afterEach(async()=>{vi.restoreAllMocks();await app.close();await db.close();});

  it('reports a future upstream drop to each affected parent without changing contracts or exposing other teams',async()=>{
    await quote(parent,'0.2',nextDay());
    const data=(await call(parent,'GET','/api/team/pricing')).json();
    expect(data.prices.find((r:any)=>r.provider==='B')).toMatchObject({currentRate:'0.4000',nextRate:'0.2000'});
    expect(data.risks.filter((r:any)=>r.kind==='inverted')).toEqual([expect.objectContaining({payerId:parent.id,userId:child.id,date:nextDay(),ownRate:'0.2000',childRate:'0.3000',lossPer100Usd:'10.00000000'})]);
    expect(data.directUsers.map((u:any)=>u.id)).toEqual([child.id]);
    expect(JSON.stringify(data)).not.toContain('private-');expect(JSON.stringify(data)).not.toContain(sibling.id);expect(JSON.stringify(data)).not.toContain('0.5000');
    expect((await db.query('SELECT rate FROM rates WHERE user_id=$1',[child.id]))[0].rate).toBe('0.3000');
    const leafView=(await call(child,'GET','/api/team/pricing')).json();expect(leafView.prices.find((r:any)=>r.provider==='B').currentRate).toBe('0.3000');expect(leafView.risks).toHaveLength(0);
  });

  it('evaluates multiple owner connections at their lowest enabled contract and treats missing quotes separately from zero',async()=>{
    const extra=id();await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'ai008','private-second','x',0.25)",[extra]);
    await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date) VALUES($1,$2,0.25,'1970-01-01')",[id(),extra]);
    let data=(await call(owner,'GET','/api/team/pricing')).json();expect(data.prices.find((p:any)=>p.provider==='B').currentRate).toBe('0.2500');expect(data.risks.some((r:any)=>r.userId===parent.id&&r.kind==='inverted')).toBe(true);
    await db.query('UPDATE connections SET enabled=false WHERE id=$1',[extra]);
    data=(await call(owner,'GET','/api/team/pricing')).json();expect(data.prices.find((p:any)=>p.provider==='B').currentRate).toBe('0.5000');
    await quote(parent,'0',nextDay());await quote(child,'0',nextDay());
    data=(await call(parent,'GET','/api/team/pricing')).json();expect(data.risks.some((r:any)=>r.date===nextDay()&&r.kind==='inverted')).toBe(false);
    const missing=await user(parent,'unpriced');data=(await call(parent,'GET','/api/team/pricing')).json();expect(data.risks.some((r:any)=>r.userId===missing.id&&r.kind==='missing_child')).toBe(true);
  });

  it('records a lower upstream master contract without rewriting or rejecting the direct agents’ agreed rates',async()=>{
    const before=await db.query('SELECT * FROM rates ORDER BY id');
    const response=await call(owner,'PATCH',`/api/connections/${connectionId}`,{payoutRate:0.2});
    expect(response.statusCode,response.body).toBe(200);
    const report=(await call(owner,'GET','/api/team/pricing')).json();
    expect(report.prices.find((p:any)=>p.provider==='B')).toMatchObject({currentRate:'0.5000',nextRate:'0.2000'});
    expect(report.risks).toContainEqual(expect.objectContaining({userId:parent.id,date:nextDay(),childRate:'0.4000',lossPer100Usd:'20.00000000'}));
    expect(await db.query('SELECT * FROM rates ORDER BY id')).toEqual(before);
    const agent=(await call(parent,'GET','/api/team/pricing')).json();
    expect(agent.prices.find((p:any)=>p.provider==='B')).toMatchObject({currentRate:'0.4000',nextRate:'0.4000'});
    expect(JSON.stringify(agent)).not.toContain('private-');
  });

  it('caps only prices above tomorrow’s income and keeps current and historical quotes intact',async()=>{
    const low=await user(parent,'low','0.1');await quote(parent,'0.2',nextDay());
    const data=input([child.id,low.id]),plan=await preview(parent,data);
    expect(plan.changedCount).toBe(1);expect(plan.items.find((r:any)=>r.userId===child.id)).toMatchObject({currentRate:'0.3000',afterRate:'0.2000',marginPer100Usd:'0.00000000'});expect(plan.risks).toHaveLength(0);
    expect((await apply(parent,data,plan)).statusCode).toBe(200);
    expect((await db.query('SELECT rate FROM rates WHERE user_id=$1 AND effective_date<$2',[child.id,nextDay()]))[0].rate).toBe('0.3000');
    expect(await db.query('SELECT rate FROM rates WHERE user_id=$1 AND effective_date=$2',[low.id,nextDay()])).toHaveLength(0);
    expect((await db.query("SELECT details FROM audits WHERE action='rate.batch'"))[0].details.count).toBe(1);
  });

  it('uses pending prices for proportional adjustments, rounds down to four decimals, and allows explicit zero',async()=>{
    await quote(child,'0.3333',nextDay());
    const data=input([child.id],'scale',0.8),plan=await preview(parent,data);
    expect(plan.items[0]).toMatchObject({beforeRate:'0.3333',afterRate:'0.2666'});expect((await apply(parent,data,plan)).statusCode).toBe(200);
    const zero=input([child.id],'fixed',0),zeroPlan=await preview(parent,zero);
    expect(zeroPlan.items[0].afterRate).toBe('0.0000');expect(zeroPlan.risks.some((r:any)=>r.payerId===child.id&&r.userId===leaf.id)).toBe(true);
    expect((await apply(parent,zero,zeroPlan)).statusCode).toBe(409);
    expect((await apply(parent,zero,zeroPlan,true)).statusCode).toBe(200);
  });

  it('requires explicit acknowledgement for operator or downstream losses and missing income',async()=>{
    const high=input([child.id],'fixed',0.6),plan=await preview(parent,high);
    expect(plan.risks).toContainEqual(expect.objectContaining({payerId:parent.id,userId:child.id,kind:'inverted',lossPer100Usd:'20.00000000'}));
    expect((await apply(parent,high,plan)).statusCode).toBe(409);expect(await db.query('SELECT id FROM rates WHERE user_id=$1 AND effective_date=$2',[child.id,nextDay()])).toHaveLength(0);
    expect((await apply(parent,high,plan,true)).statusCode).toBe(200);
    const noIncome=await user(owner,'no-income'),unpricedChild=await user(noIncome,'new-child');
    expect((await call(noIncome,'POST','/api/team/rates/preview',input([unpricedChild.id]))).statusCode).toBe(400);
    const fixed=input([unpricedChild.id],'fixed',0.1),missing=await preview(noIncome,fixed);
    expect(missing.risks[0].kind).toBe('missing_own');expect((await apply(noIncome,fixed,missing)).statusCode).toBe(409);
  });

  it('rejects stale previews after parent, child, grandchild, or Beijing date changes',async()=>{
    const data=input([child.id],'fixed',0.25);
    let plan=await preview(parent,data);
    expect((await call(owner,'PUT',`/api/team/${parent.id}/rates`,{provider:'ai008',rate:0.15})).statusCode).toBe(200);
    expect((await apply(parent,data,plan,true)).statusCode).toBe(409);
    plan=await preview(parent,data);await call(parent,'PUT',`/api/team/${child.id}/rates`,{provider:'ai008',rate:0.24});
    expect((await apply(parent,data,plan,true)).statusCode).toBe(409);
    plan=await preview(parent,data);await call(child,'PUT',`/api/team/${leaf.id}/rates`,{provider:'ai008',rate:0.27});
    expect((await apply(parent,data,plan,true)).statusCode).toBe(409);
    plan=await preview(parent,data);const timestamp=Date.now();vi.spyOn(Date,'now').mockReturnValue(timestamp+86400000);
    expect((await apply(parent,data,plan,true)).statusCode).toBe(409);
  });

  it('limits every batch to direct children, validates the entire request, and serializes simultaneous commits',async()=>{
    for(const target of [owner.id,parent.id,leaf.id,sibling.id])expect((await call(parent,'POST','/api/team/rates/preview',input([child.id,target],'fixed',0.2))).statusCode).toBe(403);
    expect((await call(parent,'POST','/api/team/rates/preview',input([child.id,child.id],'fixed',0.2))).statusCode).toBe(400);
    for(const data of [{...input([child.id],'fixed',1.1)},input([child.id],'scale'),{...input([child.id],'cap'),effectiveFrom:'1970-01-01'}])expect((await call(parent,'POST','/api/team/rates/preview',data)).statusCode).toBe(400);
    const data=input([child.id],'fixed',0.2),plan=await preview(parent,data);
    const replies=await Promise.all([apply(parent,data,plan),apply(parent,data,plan)]);
    expect(replies.map(r=>r.statusCode).sort()).toEqual([200,409]);
    expect(await db.query("SELECT id FROM audits WHERE action='rate.batch'")).toHaveLength(1);
  });

  it('preserves sealed earnings and applies reviewed prices only to new days',async()=>{
    const accountId=id(),bindingId=id(),oldDay=new Date(Date.parse(today()+'T00:00:00Z')-86400000).toISOString().slice(0,10);
    await db.query("INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,'priced@example.com',true)",[accountId,leaf.id]);
    await db.query("INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,'price-history')",[bindingId,accountId,connectionId]);
    const observe=(date:string)=>db.transaction(tx=>ingestUsage(tx,{bindingId,day:date,rawUsd:'100',final:true,source:'pricing-test'}));
    await observe(oldDay);const old=await db.query('SELECT * FROM earnings ORDER BY user_id');
    await quote(parent,'0.2',nextDay());const data=input([child.id]),plan=await preview(parent,data);expect((await apply(parent,data,plan)).statusCode).toBe(200);
    expect(await db.query('SELECT * FROM earnings ORDER BY user_id')).toEqual(old);
    const newDay=nextDay(),timestamp=Date.now();vi.spyOn(Date,'now').mockReturnValue(timestamp+2*86400000);await observe(newDay);
    const [profit]=await db.query('SELECT e.profit_usd FROM earnings e JOIN usage_days d ON d.id=e.usage_id WHERE e.user_id=$1 AND d.day=$2',[parent.id,newDay]);expect(profit.profit_usd).toBe('0.00000000');
    expect((await db.query('SELECT sum(profit_usd) AS total FROM earnings e JOIN usage_days d ON d.id=e.usage_id WHERE d.day=$1',[newDay]))[0].total).toBe('50.00000000');
  });

  it('rolls back every quote and audit when any member write fails',async()=>{
    const second=await user(parent,'second','0.3'),data=input([child.id,second.id],'fixed',0.2),plan=await preview(parent,data);
    const last=[child.id,second.id].sort().at(-1);
    await db.query(`CREATE FUNCTION reject_batch_quote() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.user_id='${last}' AND NEW.effective_date=DATE '${nextDay()}' THEN RAISE EXCEPTION 'test write failure'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER reject_batch BEFORE INSERT ON rates FOR EACH ROW EXECUTE FUNCTION reject_batch_quote()');
    expect((await apply(parent,data,plan)).statusCode).toBe(500);
    expect(await db.query('SELECT id FROM rates WHERE effective_date=$1',[nextDay()])).toHaveLength(0);
    expect(await db.query("SELECT id FROM audits WHERE action IN ('rate.batch','rate.update')")).toHaveLength(0);
    await db.query('DROP TRIGGER reject_batch ON rates');
    expect((await apply(parent,data,plan)).statusCode).toBe(200);
    expect(await db.query('SELECT id FROM rates WHERE effective_date=$1',[nextDay()])).toHaveLength(2);
  });

  it('settles genuine contractual losses as signed profit, prevents withdrawal, and offsets later income',async()=>{
    const date=today(),newDay=nextDay(date),timestamp=Date.now();
    // A real upper-layer change leaves existing lower contracts unchanged.
    expect((await call(owner,'PUT',`/api/team/${parent.id}/rates`,{provider:'ai008',rate:0.2})).statusCode).toBe(200);
    vi.spyOn(Date,'now').mockReturnValue(timestamp+2*86400000);
    async function observe(member:Row,email:string) {
      const accountId=id(),bindingId=id();
      await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,true)',[accountId,member.id,email]);
      await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)',[bindingId,accountId,connectionId]);
      return db.transaction(tx=>ingestUsage(tx,{bindingId,day:newDay,rawUsd:'100',final:true,source:'loss-test'}));
    }
    await observe(leaf,'loss-test@example.com');
    const firstBills=[];
    for(const [member,payer] of [[owner,owner],[parent,owner],[child,parent],[leaf,child]]) {
      const bill=await createInvoice(db,member,member.id,newDay,newDay);firstBills.push(bill);
      await confirmInvoice(db,payer,bill.id,'verified contractual loss');
      await confirmInvoice(db,payer,bill.id,'idempotent replay');
      await assertWalletAccounting(db,member.id);
    }
    expect((await balance(db,parent.id)).available).toBe('-10.00000000');
    expect((await balance(db,child.id)).available).toBe('20.00000000');
    expect((await db.query('SELECT sum(amount_usd) AS total FROM ledger'))[0].total).toBe('50.00000000');
    expect(await db.query("SELECT id FROM ledger WHERE kind='settlement'")).toHaveLength(4);
    await expect(requestWithdrawal(db,parent,'1','Binance ID','test-destination',id(),secretBox(encryptionKey))).rejects.toThrow('可提现利润余额不足');
    const before=await db.query('SELECT * FROM invoices WHERE id=ANY($1::text[]) ORDER BY id',[firstBills.map(b=>b.id)]);
    await observe(parent,'later-income@example.com');
    for(const [member,payer] of [[owner,owner],[parent,owner]]) {
      const bill=await createInvoice(db,member,member.id,newDay,newDay);await confirmInvoice(db,payer,bill.id,'verified later income');
    }
    expect((await balance(db,parent.id)).available).toBe('10.00000000');
    await assertWalletAccounting(db,parent.id);
    expect((await requestWithdrawal(db,parent,'10','Binance ID','test-destination',id(),secretBox(encryptionKey))).amount_usd).toBe('10.00000000');
    expect((await balance(db,parent.id)).available).toBe('0.00000000');
    expect(await db.query('SELECT * FROM invoices WHERE id=ANY($1::text[]) ORDER BY id',[firstBills.map(b=>b.id)])).toEqual(before);
  });

  it('blocks payment of an earlier withdrawal consumed by a later loss, while allowing its hold to be released',async()=>{
    await seedSettlement(db,parent.id,'40');
    const withdrawal=await requestWithdrawal(db,parent,'35','Binance ID','test-destination',id(),secretBox(encryptionKey));
    await quote(parent,'0.2');
    const accountId=id(),bindingId=id(),day=new Date(Date.parse(today()+'T00:00:00Z')-86400000).toISOString().slice(0,10);
    await db.query("INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,'reserved-loss@example.com',true)",[accountId,leaf.id]);
    await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id) VALUES($1,$2,$3,$1)',[bindingId,accountId,connectionId]);
    await db.transaction(tx=>ingestUsage(tx,{bindingId,day,rawUsd:'100',final:true,source:'reserved-loss'}));
    for(const [member,payer] of [[owner,owner],[parent,owner]]) {
      const bill=await createInvoice(db,member,member.id,day,day);await confirmInvoice(db,payer,bill.id,'verified reserved loss');
    }
    await assertWalletAccounting(db,parent.id);
    expect((await balance(db,parent.id)).available).toBe('-5.00000000');
    await expect(reviewWithdrawal(db,owner,withdrawal.id,'paid','cannot pay debt')).rejects.toThrow('可提现利润余额不足');
    expect((await db.query('SELECT state FROM withdrawals WHERE id=$1',[withdrawal.id]))[0].state).toBe('pending');
    await reviewWithdrawal(db,owner,withdrawal.id,'rejected','release consumed reservation');
    expect(await balance(db,parent.id)).toEqual({available:'30.00000000',pending:'0.00000000'});
    await assertWalletAccounting(db,parent.id);
  });
});
