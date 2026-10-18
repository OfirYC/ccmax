import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DB,Row } from './db.js';
import { assert,subtree,today } from './core.js';
import { PROVIDER_KEYS,type ProviderKey } from './providers.js';
import { telemetrySchema,telemetryPeriods,type TelemetryPeriod } from '../shared/telemetry.js';
import { aggregateTelemetry,isFresh,staleSeconds } from './telemetry.js';

export function registerTelemetry(app:FastifyInstance,db:DB,name:(user:Row,provider:ProviderKey,id:string,internal:string)=>string) {
  const filters=z.object({scope:z.enum(['self','descendants','team']).default('team'),provider:z.enum(PROVIDER_KEYS).optional(),
    accountId:z.string().uuid().optional(),connectionId:z.string().uuid().optional(),ownerId:z.string().uuid().optional(),
    search:z.string().max(200).default(''),period:z.enum(telemetryPeriods).default('today'),page:z.coerce.number().int().min(1).max(1000000).default(1)}).strict();
  async function visible(user:Row,q:z.infer<typeof filters>) {
    const ids=await subtree(db,user.id);
    assert(!q.ownerId||ids.includes(q.ownerId),'不能查看其他团队的调用数据',403);
    const scopeIds=q.ownerId?[q.ownerId]:q.scope==='self'?[user.id]:q.scope==='descendants'?ids.filter(id=>id!==user.id):ids;
    const rows=await db.query(`SELECT b.id,b.account_id,b.connection_id,b.status,c.provider,c.name AS internal_name,c.enabled,c.status AS connection_status,
      a.email,a.label,a.owner_id,u.name AS owner_name,t.data
      FROM bindings b JOIN accounts a ON a.id=b.account_id JOIN connections c ON c.id=b.connection_id LEFT JOIN users u ON u.id=a.owner_id
      LEFT JOIN binding_telemetry t ON t.binding_id=b.id
      WHERE (a.ownership_verified OR $1::boolean) AND (a.owner_id=ANY($2::text[]) OR ($3::boolean AND a.owner_id IS NULL))
      AND ($4::text IS NULL OR c.provider=$4) AND ($5::text IS NULL OR a.id=$5) AND ($6::text IS NULL OR c.id=$6)
      AND ($7::text='' OR strpos(lower(a.email||' '||a.label||' '||COALESCE(u.name,'')),lower($7))>0)
      ORDER BY a.email,c.provider,b.id LIMIT 100001`,
    [user.role==='owner',scopeIds,user.role==='owner'&&q.scope==='team'&&!q.ownerId,q.provider??null,q.accountId??null,q.connectionId??null,q.search]);
    assert(rows.length<=100000,'调用数据过多，请按平台或账号筛选',400);
    return rows.map(r=>{
      const parsed=telemetrySchema.safeParse(r.data),telemetry=parsed.success?parsed.data:null;
      const fresh=!!telemetry&&isFresh(telemetry)&&r.status!=='missing'&&r.enabled;
      return {id:r.id,account_id:r.account_id,connection_id:r.connection_id,provider:r.provider,
        connection_name:name(user,r.provider,r.connection_id,r.internal_name),email:r.email,label:r.label,owner_id:r.owner_id,owner_name:r.owner_name,
        status:r.status,connection_status:r.connection_status,fresh,telemetry};
    });
  }
  app.get('/api/telemetry',async req=>{
    const q=filters.parse(req.query),rows=await visible(req.user,q);
    const platforms=[...new Set(rows.map(r=>r.connection_id))].map(connectionId=>{
      const group=rows.filter(r=>r.connection_id===connectionId),first=group[0];
      return {id:connectionId,provider:first.provider,name:first.connection_name,...aggregateTelemetry(group,q.period)};
    });
    const members=[...new Set(rows.map(r=>r.owner_id))].map(userId=>{
      const group=rows.filter(r=>r.owner_id===userId);
      return {id:userId,name:group[0].owner_name,...aggregateTelemetry(group,q.period)};
    });
    return {period:q.period,scope:q.scope,day:today(),generatedAt:new Date().toISOString(),staleSeconds:staleSeconds(),
      totals:aggregateTelemetry(rows,q.period),platforms,members,total:rows.length,page:q.page,pageSize:12,rows:rows.slice((q.page-1)*12,q.page*12)};
  });
  app.get('/api/telemetry/trend',async req=>{
    const q=filters.omit({page:true}).parse(req.query),rows=await visible(req.user,{...q,page:1});
    // Samples describe observed rates, never an inferred request count. Select
    // bindings through the exact same ownership filter as the current totals.
    const samples=await db.query(`SELECT bucket_at AS at,sum(rpm) AS rpm,sum(tpm) AS tpm,sum(concurrent) AS concurrent,
      count(rpm)::int AS rpm_covered,count(tpm)::int AS tpm_covered,count(concurrent)::int AS concurrent_covered,
      min(source_at) AS oldest_source_at,max(source_at) AS newest_source_at
      FROM telemetry_samples WHERE binding_id=ANY($1::text[]) AND bucket_at>=now()-interval '24 hours'
      GROUP BY bucket_at ORDER BY bucket_at`,[rows.map(r=>r.id)]);
    return {samples,total:rows.length,retentionHours:48,windowHours:24,bucketSeconds:300};
  });
}
