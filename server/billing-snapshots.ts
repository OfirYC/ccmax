import Decimal from 'decimal.js';
import type { DB, Row } from './db.js';
import { MAX_USD, usd } from './core.js';
import type { UpstreamAccount } from './providers.js';

export async function saveBillingSnapshot(db: DB, bindingId: string, remote: UpstreamAccount) {
  const t=remote.telemetry;
  if(remote.dailyUsd===null || !t?.sourceAt)return false;
  const source=Date.parse(t.sourceAt),collected=Date.parse(t.collectedAt);
  // Source timestamps can lag the request across midnight. Preserve the source
  // day, never assign a reset counter to yesterday using the request time.
  if(!Number.isFinite(source)||!Number.isFinite(collected)||source>collected+60000)return false;
  const day=new Date(source+8*3600000).toISOString().slice(0,10);
  let amount:Decimal;
  try {amount=new Decimal(remote.dailyUsd);} catch {return false;}
  if(day!==t.day || !amount.isFinite() || amount.lt(0) || amount.gt(MAX_USD))return false;
  await db.query(`INSERT INTO billing_snapshots(binding_id,day,collected_at,source_at,raw_usd)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(binding_id,collected_at) DO NOTHING`,[bindingId,day,t.collectedAt,t.sourceAt,usd(remote.dailyUsd)]);
  return true;
}

export async function snapshotDay(db: DB, connection: Row, day: string) {
  // A deployment must not strand daily counters captured before the dedicated
  // archive existed. Only recover a dated source or an observation actually
  // collected on that Beijing day; a later reset is never relabelled yesterday.
  await db.query(`INSERT INTO billing_snapshots(binding_id,day,collected_at,source_at,raw_usd,origin)
    SELECT d.binding_id,d.day,d.updated_at,d.source_at,d.raw_usd,'usage_archive'
    FROM usage_days d JOIN bindings b ON b.id=d.binding_id
    WHERE b.connection_id=$1 AND d.day=$2 AND d.source IN ('live_snapshot','daily_snapshot')
    AND ((d.source_at IS NOT NULL AND (d.source_at AT TIME ZONE 'Asia/Shanghai')::date=d.day)
      OR (d.source_at IS NULL AND d.source='live_snapshot' AND (d.updated_at AT TIME ZONE 'Asia/Shanghai')::date=d.day))
    AND (d.source_at IS NULL OR d.source_at<=d.updated_at+interval '1 minute')
    ON CONFLICT(binding_id,collected_at) DO NOTHING`,[connection.id,day]);
  const bindings=await db.query(`SELECT b.id,b.external_id,b.status,latest.source_at,latest.collected_at,latest.raw_usd,latest.origin
    FROM bindings b JOIN accounts a ON a.id=b.account_id LEFT JOIN LATERAL
      (SELECT * FROM billing_snapshots s WHERE s.binding_id=b.id AND s.day=$2
       ORDER BY COALESCE(s.source_at,s.collected_at) DESC,s.collected_at DESC LIMIT 1) latest ON true
    WHERE b.connection_id=$1 AND ((a.created_at AT TIME ZONE 'Asia/Shanghai')::date<=$2
      OR EXISTS(SELECT 1 FROM billing_snapshots s WHERE s.binding_id=b.id AND s.day=$2))`,[connection.id,day]);
  const rows:{externalId:string;rawUsd:string;sourceAt:string|null;collectedAt:string;origin:string}[]=[],issues:{externalId:string;message:string}[]=[];
  for(const b of bindings) {
    if(!b.collected_at) {
      issues.push({externalId:b.external_id,message:'当日用量数据待补齐'});continue;
    }
    const observedAt=b.source_at??b.collected_at;
    const [regressed]=await db.query(`SELECT 1 FROM billing_snapshots WHERE binding_id=$1 AND day=$2
      AND (COALESCE(source_at,collected_at)<$3 OR (COALESCE(source_at,collected_at)=$3 AND collected_at<$5)) AND raw_usd>$4 LIMIT 1`,[b.id,day,observedAt,b.raw_usd,b.collected_at]);
    if(regressed) {issues.push({externalId:b.external_id,message:'当日用量计数回退，快照不能自动结算'});continue;}
    rows.push({externalId:b.external_id,rawUsd:b.raw_usd,sourceAt:b.source_at?new Date(b.source_at).toISOString():null,collectedAt:new Date(b.collected_at).toISOString(),origin:b.origin});
  }
  return {rows,issues};
}
