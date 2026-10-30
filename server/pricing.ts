import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import type { DB, Row } from './db.js';
import { assert, audit, id, nextDay, today, usd } from './core.js';
import { PROVIDER_KEYS, type ProviderKey } from './providers.js';

// All quote writers take the same transaction lock. A reviewed batch cannot race
// a single-user edit or a new upstream quote between verification and commit.
export const lockPricing=(tx:DB)=>tx.query('SELECT pg_advisory_xact_lock(7164022)');
type Quote={rate:string;effective_date:string;[key:string]:any};
type Context=Awaited<ReturnType<typeof context>>;
export type BatchPricing={provider:ProviderKey;userIds:string[];mode:'fixed'|'scale'|'cap';value?:number};
const priceAt=(quotes:Quote[],date:string):string|null=>quotes.filter(q=>q.effective_date<=date).sort((a,b)=>b.effective_date.localeCompare(a.effective_date))[0]?.rate??null;

async function context(db:DB,actor:Row) {
  const current=today(),effectiveDate=nextDay(current);
  const users=await db.query('SELECT id,parent_id,name,active FROM users WHERE parent_id=$1 OR parent_id IN (SELECT id FROM users WHERE parent_id=$1) ORDER BY id',[actor.id]);
  const ids=[actor.id,...users.map(u=>u.id)];
  const rates=await db.query<Quote>(`SELECT user_id,provider,rate,effective_date::text AS effective_date FROM rates WHERE user_id=ANY($1::text[]) ORDER BY user_id,provider,effective_date`,[ids]);
  // Provider-level downstream quotes apply to every connection. Use the lowest
  // enabled upstream contract so the owner sees risk on any of those accounts.
  const connections=actor.role==='owner'?await db.query('SELECT id,provider,enabled FROM connections ORDER BY id'):[];
  const upstream=actor.role==='owner'?await db.query<Quote>(`SELECT connection_id,rate,effective_date::text AS effective_date FROM connection_rates WHERE connection_id=ANY($1::text[]) ORDER BY connection_id,effective_date`,[connections.map(c=>c.id)]):[];
  const states=await db.query<{provider:ProviderKey;enabled:string|boolean}>(`SELECT provider,bool_or(enabled) AS enabled
    FROM connections GROUP BY provider ORDER BY provider`);
  const providers=new Set<ProviderKey>(PROVIDER_KEYS);
  for(const state of states)if(state.enabled!==true&&state.enabled!=='true')providers.delete(state.provider);
  return {actorId:actor.id,root:actor.role==='owner',current,effectiveDate,users,rates,connections,upstream,providers};
}

function ownRate(c:Context,provider:ProviderKey,date:string):string|null {
  if(!c.root)return priceAt(c.rates.filter(r=>r.user_id===c.actorId&&r.provider===provider),date);
  const enabled=c.connections.filter(r=>r.enabled&&r.provider===provider);
  if(!enabled.length)return null;
  const values=enabled.map(r=>priceAt(c.upstream.filter(q=>q.connection_id===r.id),date));
  if(values.some(r=>r===null))return null;
  return Decimal.min(...values as string[]).toFixed(4);
}

function risk(payerId:string,payerName:string,user:Row,provider:ProviderKey,date:string,upstreamRate:string|null,downstreamRate:string|null) {
  if(downstreamRate===null)return {payerId,payerName,userId:user.id,userName:user.name,provider,date,ownRate:upstreamRate,childRate:downstreamRate,kind:'missing_child',lossPer100Usd:null};
  if(upstreamRate===null)return {payerId,payerName,userId:user.id,userName:user.name,provider,date,ownRate:upstreamRate,childRate:downstreamRate,kind:'missing_own',lossPer100Usd:null};
  if(new Decimal(downstreamRate).lte(upstreamRate))return null;
  return {payerId,payerName,userId:user.id,userName:user.name,provider,date,ownRate:upstreamRate,childRate:downstreamRate,kind:'inverted',lossPer100Usd:usd(new Decimal(downstreamRate).minus(upstreamRate).mul(100))};
}

function report(c:Context,actor:Row) {
  const direct=c.users.filter(u=>u.parent_id===actor.id);
  // Paused providers keep their historical contracts, but they are no longer
  // part of the active quote surface. Do not turn their missing upstream
  // contract into a false risk for every member and future effective date.
  const providerKeys=[...c.providers];
  const prices=providerKeys.map(provider=>({provider,currentRate:ownRate(c,provider,c.current),nextRate:ownRate(c,provider,c.effectiveDate),connectionCount:c.connections.filter(r=>r.enabled&&r.provider===provider).length}));
  const risks=[];
  for(const p of providerKeys) {
    // Ignore platforms neither side has priced and which have no active upstream.
    if(!c.rates.some(r=>r.provider===p&&(r.user_id===actor.id||direct.some(u=>u.id===r.user_id)))&&!c.connections.some(r=>r.enabled&&r.provider===p))continue;
    const dates=[...new Set([c.current,c.effectiveDate,...c.rates.filter(r=>r.provider===p&&r.effective_date>c.current).map(r=>r.effective_date),...c.upstream.filter(r=>r.effective_date>c.current).map(r=>r.effective_date)])].sort();
    for(const user of direct)for(const date of dates) {
      const issue=risk(actor.id,actor.name,user,p,date,ownRate(c,p,date),priceAt(c.rates.filter(r=>r.user_id===user.id&&r.provider===p),date));
      if(issue)risks.push(issue);
    }
  }
  return {today:c.current,effectiveDate:c.effectiveDate,prices,risks,directUsers:direct};
}

export async function pricingReport(db:DB,actor:Row) {
  return db.transaction(async tx=>{await lockPricing(tx);return report(await context(tx,actor),actor);});
}

async function preview(tx:DB,actor:Row,input:BatchPricing) {
  const c=await context(tx,actor),userIds=[...new Set(input.userIds)].sort();
  assert(userIds.length===input.userIds.length,'批量成员不能重复');
  const users=userIds.map(userId=>{
    const user=c.users.find(u=>u.id===userId&&u.parent_id===actor.id);
    assert(user,'只能批量调整直属下级的价格',403);return user;
  });
  const own=ownRate(c,input.provider,c.effectiveDate);
  if(input.mode==='cap')assert(own!==null,'你的次日应收价格尚未设置，无法按应收上限调整');
  const items=users.map(user=>{
    const quotes=c.rates.filter(r=>r.user_id===user.id&&r.provider===input.provider),before=priceAt(quotes,c.effectiveDate);
    if(input.mode!=='fixed')assert(before!==null,'存在未定价成员，请先使用统一折扣设置价格');
    const after=input.mode==='fixed'?new Decimal(input.value!):input.mode==='scale'?new Decimal(before!).mul(input.value!).toDecimalPlaces(4,Decimal.ROUND_DOWN):Decimal.min(before!,own!);
    const afterRate=after.toFixed(4);
    return {userId:user.id,userName:user.name,currentRate:priceAt(quotes,c.current),beforeRate:before,afterRate,changed:before===null||!after.eq(before),ownRate:own,marginPer100Usd:own===null?null:usd(new Decimal(own).minus(after).mul(100))};
  });
  const changed=items.filter(i=>i.changed);
  // Evaluate both the operator's margin and the affected agent's obligations.
  // A quote can fix one layer while making the next layer unprofitable.
  const risks=[];
  const dates=[...new Set([c.effectiveDate,...c.rates.filter(r=>r.provider===input.provider&&r.effective_date>c.effectiveDate).map(r=>r.effective_date),...c.upstream.filter(r=>r.effective_date>c.effectiveDate).map(r=>r.effective_date)])].sort();
  for(const item of changed)for(const date of dates) {
    const user=users.find(u=>u.id===item.userId)!;
    const later=c.rates.filter(r=>r.user_id===user.id&&r.provider===input.provider&&r.effective_date>c.effectiveDate);
    const after=priceAt([{rate:item.afterRate,effective_date:c.effectiveDate},...later],date);
    const issue=risk(actor.id,actor.name,user,input.provider,date,ownRate(c,input.provider,date),after);
    if(issue)risks.push(issue);
    for(const child of c.users.filter(u=>u.parent_id===user.id)) {
      const downstream=risk(user.id,user.name,child,input.provider,date,after,priceAt(c.rates.filter(r=>r.user_id===child.id&&r.provider===input.provider),date));
      if(downstream)risks.push(downstream);
    }
  }
  const normalized={...input,userIds};
  const snapshot=createHash('sha256').update(JSON.stringify({input:normalized,context:c})).digest('hex');
  return {provider:input.provider,effectiveDate:c.effectiveDate,items,risks,changedCount:changed.length,snapshot};
}

export async function previewBatchPricing(db:DB,actor:Row,input:BatchPricing) {
  return db.transaction(async tx=>{await lockPricing(tx);return preview(tx,actor,input);});
}

export async function applyBatchPricing(db:DB,actor:Row,input:BatchPricing,snapshot:string,acknowledgeRisk=false) {
  return db.transaction(async tx=>{
    await lockPricing(tx);
    const plan=await preview(tx,actor,input);
    assert(plan.snapshot===snapshot,'报价或团队关系已变化，请重新预览后提交',409);
    assert(!plan.risks.length||acknowledgeRisk,'本次调价存在倒挂或缺价风险，请核对并确认承担风险',409);
    for(const item of plan.items.filter(i=>i.changed)) {
      await tx.query(`INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(user_id,provider,effective_date) DO UPDATE SET rate=EXCLUDED.rate,created_by=EXCLUDED.created_by,created_at=now()`,[id(),item.userId,input.provider,item.afterRate,plan.effectiveDate,actor.id]);
      await audit(tx,actor.id,'rate.update',item.userId,{provider:input.provider,rate:item.afterRate,previousRate:item.beforeRate,effectiveDate:plan.effectiveDate,batch:true});
    }
    if(plan.changedCount)await audit(tx,actor.id,'rate.batch',actor.id,{provider:input.provider,mode:input.mode,value:input.value,effectiveDate:plan.effectiveDate,count:plan.changedCount,riskAcknowledged:acknowledgeRisk,snapshot});
    return {effectiveDate:plan.effectiveDate,changedCount:plan.changedCount,risks:plan.risks};
  });
}
