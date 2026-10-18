import Decimal from 'decimal.js';
import type { DB, Row } from './db.js';
import { assert, MAX_USD, usd } from './core.js';
import type { UpstreamAccount } from './providers.js';

export async function saveBillingSnapshot(db: DB, bindingId: string, remote: UpstreamAccount) {
  const t=remote.telemetry;
  if(remote.dailyUsd===null || !t?.sourceAt)return false;
  const source=Date.parse(t.sourceAt),collected=Date.parse(t.collectedAt);
  // Source timestamps can lag the request across midnight. Preserve the source
  // day, never assign a reset counter to yesterday using the request time.
  if(!Number.isFinite(source)||!Number.isFinite(collected)||source>collected+60000)return false;
  const day=new Date(source+8*3600000).toISOString().slice(0,10);
  if(day!==t.day || new Decimal(remote.dailyUsd).gt(MAX_USD))return false;
  await db.query(`INSERT INTO billing_snapshots(binding_id,day,collected_at,source_at,raw_usd)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(binding_id,collected_at) DO NOTHING`,[bindingId,day,t.collectedAt,t.sourceAt,usd(remote.dailyUsd)]);
  return true;
}

export async function snapshotDay(db: DB, connection: Row, day: string) {
  const end=Date.parse(day+'T23:59:59.999+08:00');
  const bindings=await db.query(`SELECT b.id,b.external_id,b.status,latest.source_at,latest.collected_at,latest.raw_usd
    FROM bindings b JOIN accounts a ON a.id=b.account_id LEFT JOIN LATERAL
      (SELECT * FROM billing_snapshots s WHERE s.binding_id=b.id AND s.day=$2 AND s.collected_at<=$3
       ORDER BY s.source_at DESC,s.collected_at DESC LIMIT 1) latest ON true
    WHERE b.connection_id=$1 AND ((a.created_at AT TIME ZONE 'Asia/Shanghai')::date<=$2
      OR EXISTS(SELECT 1 FROM billing_snapshots s WHERE s.binding_id=b.id AND s.day=$2))`,[connection.id,day,new Date(end+10*60000)]);
  assert(bindings.some(b=>b.source_at),'没有当天有效快照，无法补建历史金额');
  const rows:{externalId:string;rawUsd:string;sourceAt:string;collectedAt:string}[]=[],issues:{externalId:string;message:string}[]=[];
  for(const b of bindings) {
    if(!b.source_at || end-new Date(b.source_at).getTime()>10*60000) {
      issues.push({externalId:b.external_id,message:'日终快照缺失或距离零点超过 10 分钟，等待核对'});continue;
    }
    const [regressed]=await db.query(`SELECT 1 FROM billing_snapshots WHERE binding_id=$1 AND day=$2
      AND (source_at<$3 OR (source_at=$3 AND collected_at<$5)) AND raw_usd>$4 LIMIT 1`,[b.id,day,b.source_at,b.raw_usd,b.collected_at]);
    if(regressed) {issues.push({externalId:b.external_id,message:'当日用量计数回退，快照不能自动结算'});continue;}
    rows.push({externalId:b.external_id,rawUsd:b.raw_usd,sourceAt:new Date(b.source_at).toISOString(),collectedAt:new Date(b.collected_at).toISOString()});
  }
  return {rows,issues};
}
