import { z } from 'zod';
import type { DB,Row } from './db.js';
import { assert,subtree } from './core.js';
import { PROVIDER_KEYS,type ProviderKey } from './providers.js';
import { telemetrySchema,telemetryPeriods } from '../shared/telemetry.js';
import { isFresh } from './telemetry.js';

export const telemetryFilters=z.object({scope:z.enum(['self','descendants','team']).default('team'),provider:z.enum(PROVIDER_KEYS).optional(),
  accountId:z.string().uuid().optional(),connectionId:z.string().uuid().optional(),ownerId:z.string().uuid().optional(),
  search:z.string().max(200).default(''),period:z.enum(telemetryPeriods).default('today'),page:z.coerce.number().int().min(1).max(1000000).default(1)}).strict();
export type ConnectionName=(user:Row,provider:ProviderKey,id:string,internal:string)=>string;
export function attributionTotals(rows:Row[]) {
  const assigned=rows.filter(r=>r.ownership_verified&&r.owner_id).length;
  return {assigned,unassigned:rows.length-assigned};
}

export function snapshotView(row:Row) {
  const parsed=telemetrySchema.safeParse(row.data),telemetry=parsed.success?parsed.data:null;
  return {telemetry,fresh:!!telemetry&&isFresh(telemetry)&&row.status!=='missing'&&row.enabled===true};
}

// Dashboard, account lists and analytics must share the same visibility and
// freshness rules. A platform master account is never an ownership boundary.
export async function visibleTelemetry(db:DB,user:Row,q:z.infer<typeof telemetryFilters>,name:ConnectionName) {
  const ids=await subtree(db,user.id);
  assert(!q.ownerId||ids.includes(q.ownerId),'不能查看其他团队的调用数据',403);
  const scopeIds=q.ownerId?[q.ownerId]:q.scope==='self'?[user.id]:q.scope==='descendants'?ids.filter(id=>id!==user.id):ids;
  const includePending=user.role==='owner'&&q.scope==='team'&&!q.ownerId;
  const rows=await db.query(`SELECT b.id,b.account_id,b.connection_id,b.status,c.provider,c.name AS internal_name,c.enabled,c.status AS connection_status,
    a.email,a.label,a.owner_id,a.ownership_verified,u.name AS owner_name,t.data
    FROM bindings b JOIN accounts a ON a.id=b.account_id JOIN connections c ON c.id=b.connection_id LEFT JOIN users u ON u.id=a.owner_id
    LEFT JOIN binding_telemetry t ON t.binding_id=b.id
    WHERE (a.ownership_verified OR $1::boolean) AND (a.owner_id=ANY($2::text[]) OR ($3::boolean AND a.owner_id IS NULL))
    AND ($4::text IS NULL OR c.provider=$4) AND ($5::text IS NULL OR a.id=$5) AND ($6::text IS NULL OR c.id=$6)
    AND ($7::text='' OR strpos(lower(a.email||' '||a.label||' '||COALESCE(u.name,'')),lower($7))>0)
    ORDER BY a.email,c.provider,b.id LIMIT 100001`,
  [includePending,scopeIds,includePending,q.provider??null,q.accountId??null,q.connectionId??null,q.search]);
  assert(rows.length<=100000,'调用数据过多，请按平台或账号筛选',400);
  return rows.map(r=>({id:r.id,account_id:r.account_id,connection_id:r.connection_id,provider:r.provider,
    connection_name:name(user,r.provider,r.connection_id,r.internal_name),email:r.email,label:r.label,owner_id:r.owner_id,owner_name:r.owner_name,ownership_verified:r.ownership_verified,
    status:r.status,connection_status:r.connection_status,...snapshotView(r)}));
}
