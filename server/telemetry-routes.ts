import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { today } from './core.js';
import { aggregateTelemetry,staleSeconds } from './telemetry.js';
import { attributionTotals,telemetryFilters as filters,visibleTelemetry,type ConnectionName } from './telemetry-data.js';

export function registerTelemetry(app:FastifyInstance,db:DB,name:ConnectionName) {
  app.get('/api/telemetry',async req=>{
    const q=filters.parse(req.query),rows=await visibleTelemetry(db,req.user,q,name);
    const platforms=[...new Set(rows.map(r=>r.connection_id))].map(connectionId=>{
      const group=rows.filter(r=>r.connection_id===connectionId),first=group[0];
      return {id:connectionId,provider:first.provider,name:first.connection_name,attribution:attributionTotals(group),...aggregateTelemetry(group,q.period)};
    });
    const memberId=(r:typeof rows[number])=>r.ownership_verified?r.owner_id:null;
    const members=[...new Set(rows.map(memberId))].map(userId=>{
      const group=rows.filter(r=>memberId(r)===userId);
      return {id:userId,name:userId?group[0].owner_name:null,...aggregateTelemetry(group,q.period)};
    });
    return {period:q.period,scope:q.scope,day:today(),generatedAt:new Date().toISOString(),staleSeconds:staleSeconds(),
      totals:aggregateTelemetry(rows,q.period),attribution:attributionTotals(rows),platforms,members,total:rows.length,page:q.page,pageSize:12,rows:rows.slice((q.page-1)*12,q.page*12)};
  });
  app.get('/api/telemetry/trend',async req=>{
    const q=filters.omit({page:true}).parse(req.query),rows=await visibleTelemetry(db,req.user,{...q,page:1},name);
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
