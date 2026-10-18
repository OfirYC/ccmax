import Decimal from 'decimal.js';
import type { DB, Row } from './db.js';
import { AppError, ancestry, assert, audit, dayString, id, MAX_USD, sum, today, usd, type SecretBox } from './core.js';
import { assertFundingAccounting, assertInvoiceAccounting, assertUsageAccounting, assertWalletAccounting } from './financial-integrity.js';

export type UsageInput = { bindingId: string; day: string; rawUsd: string; final: boolean; source: string; evidence?: string };

// Daily source values replace provisional observations; they are NEVER added to
// each other. A finalized account/day is immutable and has exactly one charge.
export async function ingestUsage(tx: DB, input: UsageInput) {
  const observed = new Decimal(input.rawUsd);
  assert(observed.isFinite() && observed.gte(0) && observed.lte(MAX_USD),'用量金额超出范围');
  // Upstreams sometimes return more decimals than our USD ledger supports.
  // Calculate every layer from exactly the same eight-decimal recorded bill.
  const raw=new Decimal(usd(observed));
  assert(input.day<=today(),'不能导入未来用量');
  if (input.final) assert(input.day<today(),'北京时间今天的用量尚未结束，不能结算');
  const [binding]=await tx.query(`SELECT b.*,a.owner_id,a.ownership_verified,c.provider,c.payout_rate,c.id AS connection_id FROM bindings b
    JOIN accounts a ON a.id=b.account_id JOIN connections c ON c.id=b.connection_id WHERE b.id=$1 FOR UPDATE OF b`,[input.bindingId]);
  assert(binding,'找不到平台账号',404);
  if (input.final) assert(binding.owner_id && binding.ownership_verified,'请先核实账号归属再确认用量');
  const [existing]=await tx.query('SELECT * FROM usage_days WHERE binding_id=$1 AND day=$2 FOR UPDATE',[input.bindingId,input.day]);
  if (existing?.state==='final') {
    assert(new Decimal(existing.raw_usd).eq(raw),'该账号此日用量已封账；金额冲突，请对账处理',409);
    return existing.id;
  }
  const usageId=existing?.id??id();
  const [connectionRate]=await tx.query(`SELECT rate FROM connection_rates
    WHERE connection_id=$1 AND effective_date<=$2 ORDER BY effective_date DESC LIMIT 1`,[binding.connection_id,input.day]);
  assert(connectionRate,'该平台在所选日期没有已备案的结算折扣，无法安全入账');
  const rootRate=existing?.root_rate??connectionRate.rate;
  await tx.query(`INSERT INTO usage_days(id,binding_id,day,raw_usd,state,source,evidence,root_rate,finalized_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $5='final' THEN now() ELSE NULL END)
    ON CONFLICT(binding_id,day) DO UPDATE SET raw_usd=EXCLUDED.raw_usd,state=EXCLUDED.state,source=EXCLUDED.source,
    evidence=EXCLUDED.evidence,finalized_at=EXCLUDED.finalized_at,updated_at=now()`,
    [usageId,input.bindingId,input.day,usd(raw),'provisional',input.source,input.evidence??null,rootRate]);
  if (!binding.owner_id || !binding.ownership_verified) return usageId;
  const chain=await ancestry(tx,binding.owner_id);
  const previous=await tx.query('SELECT * FROM earnings WHERE usage_id=$1',[usageId]);
  const rates: Decimal[]=[];
  for (const user of chain) {
    const frozen=previous.find(e=>e.user_id===user.id);
    if (frozen) rates.push(new Decimal(frozen.rate));
    else if (user.role==='owner') rates.push(new Decimal(rootRate));
    else {
      const [price]=await tx.query('SELECT rate FROM rates WHERE user_id=$1 AND provider=$2 AND effective_date<=$3 ORDER BY effective_date DESC LIMIT 1',[user.id,binding.provider,input.day]);
      assert(price,`${user.name} 在 ${input.day} 没有 ${binding.provider} 结算折扣，无法记账`);
      rates.push(new Decimal(price.rate));
    }
  }
  for (let i=0;i<chain.length;i++) {
    const downstream=rates[i+1]??new Decimal(0);
    const gross=new Decimal(usd(raw.mul(rates[i]))), payable=new Decimal(usd(raw.mul(downstream)));
    // Subtract rounded payable from rounded receivable: profit always telescopes
    // to the root's receivable, including tiny USD values and long agent chains.
    await tx.query(`INSERT INTO earnings(id,usage_id,user_id,payer_id,next_user_id,rate,downstream_rate,gross_usd,downstream_usd,profit_usd)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(usage_id,user_id) DO UPDATE SET
      gross_usd=EXCLUDED.gross_usd,downstream_usd=EXCLUDED.downstream_usd,profit_usd=EXCLUDED.profit_usd`,
      [id(),usageId,chain[i].id,chain[i-1]?.id??null,chain[i+1]?.id??null,rates[i].toFixed(4),downstream.toFixed(4),usd(gross),usd(payable),usd(gross.minus(payable))]);
  }
  // Seal only after all earnings are calculated; database guards then prevent
  // any subsequent change to either the usage or its price snapshots.
  if(input.final) await tx.query("UPDATE usage_days SET state='final',finalized_at=now() WHERE id=$1",[usageId]);
  return usageId;
}

export async function createInvoice(db: DB, actor: Row, userId: string, from: string, to: string) {
  assert(from<=to && to<today(),'仅可结算已经结束的北京时间日期');
  return db.transaction(async tx=>{
    const [user]=await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[userId]);
    assert(user && (user.id===actor.id || user.parent_id===actor.id),'只能为自己或直属下级生成账单',403);
    const items=await tx.query(`SELECT e.* FROM earnings e JOIN usage_days u ON u.id=e.usage_id
      LEFT JOIN invoice_items i ON i.earning_id=e.id WHERE e.user_id=$1 AND u.state='final' AND u.day BETWEEN $2 AND $3 AND i.earning_id IS NULL`,[userId,from,to]);
    assert(items.length,'所选期间没有可结算的已核实用量');
    await assertUsageAccounting(tx,items.map(item=>item.usage_id));
    const totals=['gross_usd','downstream_usd','profit_usd'].map(field=>sum(items.map(item=>item[field])));
    if(totals.some(amount=>amount.abs().gt(MAX_USD))) throw new AppError(400,'账单金额超出单笔上限，请缩小结算日期范围','AMOUNT_OUT_OF_RANGE');
    const invoiceId=id();
    const number=`CC-${today().replaceAll('-','')}-${invoiceId.slice(0,8).toUpperCase()}`;
    const [invoice]=await tx.query(`INSERT INTO invoices(id,number,user_id,payer_id,date_from,date_to,gross_usd,downstream_usd,profit_usd,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[invoiceId,number,user.id,user.parent_id,from,to,
      ...totals.map(amount=>usd(amount)),actor.id]);
    for (const item of items) await tx.query('INSERT INTO invoice_items(earning_id,invoice_id) VALUES($1,$2)',[item.id,invoiceId]);
    await audit(tx,actor.id,'invoice.create',invoiceId,{userId,from,to,items:items.length});
    return invoice;
  });
}

export async function confirmInvoice(db: DB, actor: Row, invoiceId: string, reference: string) {
  return db.transaction(async tx=>{
    const [invoice]=await tx.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE',[invoiceId]);
    assert(invoice,'账单不存在',404);
    assert(invoice.payer_id===actor.id || (!invoice.payer_id && actor.role==='owner'),'只能确认直属下级账单；平台回款仅管理员确认',403);
    if (invoice.state==='confirmed') return invoice;
    await assertInvoiceAccounting(tx,invoice);
    if (invoice.payer_id) {
      const usages=await tx.query('SELECT e.usage_id FROM invoice_items x JOIN earnings e ON e.id=x.earning_id WHERE x.invoice_id=$1',[invoiceId]);
      await assertFundingAccounting(tx,usages.map(row=>row.usage_id),invoice.user_id);
    }
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[invoice.user_id]);
    const [result]=await tx.query(`UPDATE invoices SET state='confirmed',reference=$2,confirmed_by=$3,confirmed_at=now() WHERE id=$1 RETURNING *`,[invoiceId,reference,actor.id]);
    await tx.query(`INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'settlement',$3,$4)`,[id(),invoice.user_id,invoice.profit_usd,invoiceId]);
    await audit(tx,actor.id,'invoice.confirm',invoiceId,{reference});
    return result;
  });
}

export async function balance(db: DB, userId: string) {
  const [row]=await db.query(`SELECT
    (SELECT COALESCE(sum(amount_usd),0) FROM ledger WHERE user_id=$1) AS available,
    (SELECT COALESCE(sum(amount_usd),0) FROM withdrawals WHERE user_id=$1 AND state='pending') AS pending`,[userId]);
  return {available:usd(row.available),pending:usd(row.pending)};
}
export function withdrawalDestination(box:SecretBox, value:string):string {
  return value.startsWith('enc:v1:')?box.decrypt(value.slice(7)).destination:value;
}
export async function requestWithdrawal(db: DB, user: Row, amount: string, method: string, destination: string, key:string, box:SecretBox) {
  const money=new Decimal(amount);
  assert(money.isFinite() && money.gt(0) && money.lte(MAX_USD) && money.decimalPlaces()<=8,'提现金额必须为正数，最多 8 位美元小数');
  return db.transaction(async tx=>{
    const [lockedUser]=await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[user.id]);
    const [existing]=await tx.query('SELECT * FROM withdrawals WHERE user_id=$1 AND idempotency_key=$2',[user.id,key]);
    if(existing) {
      assert(new Decimal(existing.amount_usd).eq(money) && existing.method===method && withdrawalDestination(box,existing.destination)===destination,'此请求编号已用于另一笔提现',409);
      return existing;
    }
    await assertWalletAccounting(tx,user.id);
    const b=await balance(tx,user.id);
    assert(money.lte(b.available),'可提现利润余额不足');
    const withdrawalId=id();
    const [withdrawal]=await tx.query(`INSERT INTO withdrawals(id,user_id,payer_id,amount_usd,method,destination,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [withdrawalId,user.id,lockedUser.parent_id,usd(money),method,'enc:v1:'+box.encrypt({destination}),key]);
    await tx.query(`INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'withdrawal_hold',$3,$4)`,[id(),user.id,usd(money.negated()),withdrawalId]);
    await audit(tx,user.id,'withdrawal.request',withdrawalId,{amount:usd(money)});
    return withdrawal;
  });
}
export async function reviewWithdrawal(db: DB, actor: Row, withdrawalId: string, action: 'paid'|'rejected', reference: string) {
  return db.transaction(async tx=>{
    const [w]=await tx.query('SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE',[withdrawalId]);
    assert(w,'提现申请不存在',404);
    assert(w.payer_id===actor.id || (!w.payer_id && actor.role==='owner'),'仅直属上级可处理；平台利润由管理员记录外部提取',403);
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[w.user_id]);
    await assertWalletAccounting(tx,w.user_id);
    if(w.state===action && w.reference===reference) return w;
    assert(w.state==='pending','提现申请已处理',409);
    // A later settled loss can consume funds reserved by an earlier request.
    // Rejection may still release the hold; payment waits for a sufficient balance.
    if(action==='paid')assert(new Decimal((await balance(tx,w.user_id)).available).gte(0),'可提现利润余额不足');
    const [result]=await tx.query('UPDATE withdrawals SET state=$2,reference=$3,reviewed_by=$4,reviewed_at=now() WHERE id=$1 RETURNING *',[withdrawalId,action,reference,actor.id]);
    if (action==='rejected') await tx.query(`INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,'withdrawal_release',$3,$4)`,[id(),w.user_id,w.amount_usd,withdrawalId]);
    await audit(tx,actor.id,`withdrawal.${action}`,withdrawalId,{reference});
    return result;
  });
}

export function csv(rows: Row[], columns: [string,string][]) {
  const cell=(v: any)=>'"'+String(v??'').replace(/^[=+\-@\t\r]/,'\'$&').replaceAll('"','""')+'"';
  return '\uFEFF'+[columns.map(c=>cell(c[1])).join(','),...rows.map(r=>columns.map(c=>cell(r[c[0]] instanceof Date?(c[0]==='day'?dayString(r[c[0]]):r[c[0]].toISOString()):r[c[0]])).join(','))].join('\r\n');
}
