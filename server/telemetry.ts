import Decimal from 'decimal.js';
import { telemetrySchema,telemetryPeriods,emptyPeriod,type AccountTelemetry,type TelemetryPeriod } from '../shared/telemetry.js';
import type { DB,Row } from './db.js';
import { today } from './core.js';

const numeric=(v:unknown):number|null=>{
  if((typeof v!=='number'&&typeof v!=='string')||(typeof v==='string'&&!v.trim()))return null;
  const n=Number(v);return Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER?n:null;
};
const amount=(v:unknown):string|null=>{
  if((typeof v!=='number'&&typeof v!=='string')||v==='')return null;
  try{const n=new Decimal(v);return n.isFinite()&&n.gte(0)&&n.lte('1e24')?n.toFixed():null;}catch{return null;}
};
const timestamp=(v:unknown):string|null=>typeof v==='string'&&v.trim()&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const beijingDay=(v:string)=>new Date(Date.parse(v)+8*3600000).toISOString().slice(0,10);

/** Select only public numeric telemetry; upstream details also contain secrets. */
export function normalizeTelemetry(provider:string,row:any,detail?:any):AccountTelemetry {
  const gate=provider==='gatelink',a=detail?.account??(gate?row.upstreamSnapshot:row)??{},s=detail?.stats??a.stats??{};
  const collectedAt=new Date().toISOString();
  const declared=gate?timestamp(row.upstreamSyncedAt??a.detail_synced_at):collectedAt;
  const sourceAt=declared&&Date.parse(declared)<=Date.now()+60000?declared:null;
  const windows=detail?.cost_windows??a.usage_windows??{};
  const u=s.claude_utilization??a.claude_utilization??{};
  const periods=Object.fromEntries(telemetryPeriods.map(p=>[p,emptyPeriod()])) as AccountTelemetry['periods'];
  periods.today={...emptyPeriod(),requests:numeric(s.daily_req??a.daily_req),tokens:numeric(s.daily_tok??a.daily_tok),
    billedUsd:amount(gate?row.upstreamDailyCost:(s.daily_cost??a.daily_cost))};
  const modelSource=detail?.modelUsage??a.model_usage??{};
  for(const p of telemetryPeriods) {
    if(p!=='today')periods[p]={...emptyPeriod(),requests:numeric(windows[`req_${p}`]??a[`req_${p}`]),tokens:numeric(windows[`tokens_${p}`]??a[`tokens_${p}`]),
      billedUsd:amount(windows[`cost_${p}`]??a[`cost_${p}`]??(gate&&p==='5h'?row.upstreamCost5h:gate&&p==='7d'?row.upstreamCost7d:undefined)),
      officialUsd:amount(windows[`cost_official_${p}`]),cacheCreditUsd:amount(windows[`cache_credit_loss_${p}`])};
    const m=modelSource[{today:'today','5h':'five_hour','7d':'seven_day','30d':'thirty_day'}[p]];
    periods[p].models=normalizeModelAmounts(m);
  }
  return telemetrySchema.parse({version:1,collectedAt,sourceAt,day:beijingDay(sourceAt??collectedAt),source:detail?'account_detail':'account_list',detail:detail?'available':'unavailable',
    modelsAt:timestamp(detail?.modelUsageAt??(gate?row.upstreamSyncedAt:undefined)),
    activity:{rpm:numeric(s.rpm??a.live_rpm??a.rpm),tpm:numeric(s.tpm??a.live_tpm??a.tpm),concurrent:numeric(s.concurrent??a.live_concurrent??a.concurrent),sessions:numeric(s.active_sessions??a.slots_used)},
    limits:{rpm:numeric(a.max_rpm),tpm:numeric(a.max_tpm),concurrent:numeric(a.max_concurrent)},
    quota:{fiveHour:numeric(u.five_hour?.utilization??(gate?row.upstreamUtilization5h:undefined)),sevenDay:numeric(u.seven_day?.utilization),
      reset5h:timestamp(u.five_hour?.resets_at),reset7d:timestamp(u.seven_day?.resets_at),updatedAt:timestamp(s.claude_utilization_updated_at??(gate?row.upstreamSyncedAt:undefined))},
    health:{requests24h:numeric(row.req_24h),successful24h:numeric(row.ok_24h),limited24h:numeric(row.limited_24h)},
    cacheTokens:null,requestLogs:'unavailable',periods,
  });
}
export function normalizeModelAmounts(raw:any):AccountTelemetry['periods']['today']['models'] {
  return ['opus','fable'].flatMap(model=>{const value=amount(raw?.[model]);return value===null?[]:[{model:model as 'opus'|'fable',usageUsd:value}];});
}
export async function telemetryMigration(db:DB) {
  await db.query(`CREATE TABLE binding_telemetry (
    binding_id text PRIMARY KEY REFERENCES bindings(id) ON DELETE CASCADE,
    collected_at timestamptz NOT NULL,source_at timestamptz,data jsonb NOT NULL CHECK(jsonb_typeof(data)='object')
  )`);
  await db.query(`CREATE TABLE telemetry_samples (
    binding_id text NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,bucket_at timestamptz NOT NULL,
    source_at timestamptz NOT NULL,rpm double precision,tpm double precision,concurrent double precision,
    PRIMARY KEY(binding_id,bucket_at),CHECK(rpm>=0 AND tpm>=0 AND concurrent>=0)
  )`);
  await db.query('CREATE INDEX telemetry_samples_retention ON telemetry_samples(bucket_at)');
}
export const staleSeconds=()=>Math.max(600,(Number(process.env.SYNC_INTERVAL_SECONDS)||300)*2);
export function isFresh(data:AccountTelemetry,now=Date.now()) {
  if(!data.sourceAt)return false;
  const age=now-Date.parse(data.sourceAt),collectedAge=now-Date.parse(data.collectedAt);
  return age>=-60000&&age<=staleSeconds()*1000&&collectedAge>=-60000&&collectedAge<=staleSeconds()*1000;
}
export async function saveTelemetry(db:DB,bindingId:string,raw:AccountTelemetry) {
  const data=telemetrySchema.parse(raw);
  await db.query(`INSERT INTO binding_telemetry(binding_id,collected_at,source_at,data) VALUES($1,$2,$3,$4)
    ON CONFLICT(binding_id) DO UPDATE SET collected_at=EXCLUDED.collected_at,source_at=EXCLUDED.source_at,data=EXCLUDED.data
    WHERE binding_telemetry.collected_at<=EXCLUDED.collected_at
    AND (binding_telemetry.source_at IS NULL OR EXCLUDED.source_at>=binding_telemetry.source_at)`,[bindingId,data.collectedAt,data.sourceAt,JSON.stringify(data)]);
  if(isFresh(data))await db.query(`INSERT INTO telemetry_samples(binding_id,bucket_at,source_at,rpm,tpm,concurrent)
    VALUES($1,to_timestamp(floor(extract(epoch FROM $2::timestamptz)/300)*300),$2,$3,$4,$5)
    ON CONFLICT(binding_id,bucket_at) DO UPDATE SET source_at=EXCLUDED.source_at,rpm=EXCLUDED.rpm,tpm=EXCLUDED.tpm,concurrent=EXCLUDED.concurrent
    WHERE telemetry_samples.source_at<=EXCLUDED.source_at`,[bindingId,data.sourceAt,data.activity.rpm,data.activity.tpm,data.activity.concurrent]);
}
// Coverage accompanies each aggregate. Missing metrics never become zero and
// stale values never inflate a current platform/team total.
export function aggregateTelemetry(rows:Row[],period:TelemetryPeriod) {
  const values=rows.filter(r=>r.fresh&&r.telemetry).map(r=>r.telemetry as AccountTelemetry);
  const metric=(fn:(v:AccountTelemetry)=>number|string|null)=>{
    const v=values.map(fn).filter((n):n is number|string=>n!==null);
    return {value:v.length?v.reduce<Decimal>((s,n)=>s.plus(n),new Decimal(0)).toFixed():null,covered:v.length,total:rows.length};
  };
  return {bindings:rows.length,fresh:values.length,
    rpm:metric(v=>v.activity.rpm),tpm:metric(v=>v.activity.tpm),concurrent:metric(v=>v.activity.concurrent),
    requests:metric(v=>period==='today'&&v.day!==today()?null:v.periods[period].requests),
    tokens:metric(v=>period==='today'&&v.day!==today()?null:v.periods[period].tokens),
    billedUsd:metric(v=>period==='today'&&v.day!==today()?null:v.periods[period].billedUsd),
    models:['opus','fable'].map(model=>({model,...metric(v=>!v.modelsAt||Math.abs(Date.now()-Date.parse(v.modelsAt))>10*60000||(period==='today'&&(v.day!==today()||beijingDay(v.modelsAt)!==today()))?null:v.periods[period].models.find(m=>m.model===model)?.usageUsd??null)})),
  };
}
