import Decimal from 'decimal.js';
import type { DB, Row } from './db.js';
import { assert, audit, id, sum, usd } from './core.js';
import { confirmInvoiceInTransaction, ingestUsage } from './billing.js';
import { assertUsageAccounting } from './financial-integrity.js';

const JADEN='1cf8308f-6e34-4aa8-acd7-b45a9c9cf6f5';
const REFERENCE='automatic historical repair 2026-10-29';
const TARGETS=[
  {id:'a7f06884-629f-4e0c-90ff-0b8c6c45515e',email:'dev2@sartel.ai',provider:'gatelink',day:'2026-10-28',raw:'353.92761200'},
  {id:'1a6d2bda-701d-4c6c-870c-ec40af1b12ba',email:'dev3@sartel.ai',provider:'gatelink',day:'2026-10-28',raw:'151.24591100'},
  {id:'652e804b-36b6-449a-a6a1-acbc23df8b17',email:'dev3@sartel.ai',provider:'maxchat',day:'2026-10-26',raw:'328.85530500'},
  {id:'9e4dcc77-263c-4fce-b5ad-cc39d0cc0380',email:'dev4@sartel.ai',provider:'maxchat',day:'2026-10-26',raw:'106.45597000'},
] as const;

async function exactInvoice(tx:DB,actor:Row,user:Row,usageIds:string[]) {
  const items=await tx.query(`SELECT e.* FROM earnings e JOIN usage_days u ON u.id=e.usage_id
    LEFT JOIN invoice_items ii ON ii.earning_id=e.id
    WHERE e.user_id=$1 AND e.usage_id=ANY($2::text[]) AND u.state='final' AND ii.earning_id IS NULL ORDER BY e.id`,[user.id,usageIds]);
  assert(items.length===usageIds.length,'CCMAX historical repair invoice item mismatch',409);
  assert(new Set(items.map(item=>item.usage_id)).size===usageIds.length,'CCMAX historical repair duplicate item',409);
  await assertUsageAccounting(tx,usageIds);
  const totals=['gross_usd','downstream_usd','profit_usd'].map(field=>usd(sum(items.map(item=>item[field]))));
  const invoiceId=id(),number=`CC-REPAIR-${invoiceId.slice(0,8).toUpperCase()}`;
  const [invoice]=await tx.query(`INSERT INTO invoices(id,number,user_id,payer_id,date_from,date_to,gross_usd,downstream_usd,profit_usd,created_by,automatic,estimated)
    VALUES($1,$2,$3,$4,'2026-10-26','2026-10-28',$5,$6,$7,$8,true,false) RETURNING *`,
    [invoiceId,number,user.id,user.parent_id,...totals,actor.id]);
  for(const item of items) await tx.query('INSERT INTO invoice_items(earning_id,invoice_id) VALUES($1,$2)',[item.id,invoiceId]);
  await audit(tx,actor.id,'invoice.create',invoiceId,{repair:REFERENCE,usageIds});
  return invoice;
}

// One production-only repair. Exact immutable fingerprints make a wrong target
// fail the whole migration transaction instead of manufacturing a balance.
export async function applyJadenSettlementRepair(tx:DB) {
  const [jaden]=await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[JADEN]);
  if(!jaden) return;
  const [owner]=await tx.query("SELECT * FROM users WHERE role='owner' FOR UPDATE");
  assert(owner && jaden.parent_id===owner.id,'CCMAX historical repair hierarchy mismatch',409);
  const usageIds=TARGETS.map(target=>target.id);
  const rows=await tx.query(`SELECT u.*,b.id AS binding_id,a.email,a.owner_id,a.ownership_verified,c.provider
    FROM usage_days u JOIN bindings b ON b.id=u.binding_id JOIN accounts a ON a.id=b.account_id
    JOIN connections c ON c.id=b.connection_id WHERE u.id=ANY($1::text[]) FOR UPDATE OF u`,[usageIds]);
  assert(rows.length===TARGETS.length,'CCMAX historical repair fingerprint mismatch',409);
  for(const target of TARGETS) {
    const row=rows.find(candidate=>candidate.id===target.id);
    assert(row && row.email===target.email && row.provider===target.provider && row.day===target.day
      && new Decimal(row.raw_usd).eq(target.raw) && row.owner_id===JADEN && row.ownership_verified
      && row.source==='live_snapshot','CCMAX historical repair fingerprint mismatch',409);
    assert(row.state==='provisional','CCMAX historical repair target is no longer provisional',409);
    const [linked]=await tx.query('SELECT count(*)::int AS count FROM earnings e JOIN invoice_items i ON i.earning_id=e.id WHERE e.usage_id=$1',[target.id]);
    assert(linked.count===0,'CCMAX historical repair target is already invoiced',409);
  }
  await tx.query(`INSERT INTO rates(id,user_id,provider,rate,effective_date,created_by)
    VALUES($1,$2,'maxchat',0.2,'2026-10-26',$3) ON CONFLICT(user_id,provider,effective_date) DO NOTHING`,
    ['repair-jaden-maxchat-2026-10-26',JADEN,owner.id]);
  const [maxchatRate]=await tx.query("SELECT rate FROM rates WHERE user_id=$1 AND provider='maxchat' AND effective_date='2026-10-26'",[JADEN]);
  assert(maxchatRate && new Decimal(maxchatRate.rate).eq('0.2'),'CCMAX historical repair rate mismatch',409);
  for(const target of TARGETS) {
    const row=rows.find(candidate=>candidate.id===target.id)!;
    await ingestUsage(tx,{bindingId:row.binding_id,day:target.day,rawUsd:target.raw,final:true,source:'reviewed_statement',evidence:REFERENCE});
  }
  const jadenEarnings=await tx.query('SELECT profit_usd FROM earnings WHERE user_id=$1 AND usage_id=ANY($2::text[])',[JADEN,usageIds]);
  assert(jadenEarnings.length===4 && sum(jadenEarnings.map(row=>row.profit_usd)).eq('233.56257667'),'CCMAX historical repair amount mismatch',409);
  const rootInvoice=await exactInvoice(tx,owner,owner,usageIds);
  await confirmInvoiceInTransaction(tx,owner,rootInvoice.id,REFERENCE);
  const jadenInvoice=await exactInvoice(tx,owner,jaden,usageIds);
  await confirmInvoiceInTransaction(tx,owner,jadenInvoice.id,REFERENCE);
}
