import type { DB } from './db.js';
import { AppError } from './core.js';
import { assertUsageAccounting } from './financial-integrity.js';
import { snapshotView } from './telemetry-data.js';
import { aggregateTelemetry } from './telemetry.js';

// Call inside a repeatable-read, read-only transaction. Only opaque record IDs
// and numeric totals leave the database; no account emails or upstream secrets.
export async function auditAttribution(db:DB) {
  const findings:{entity:string;ids:string[];code:string}[]=[];
  const users=await db.query('SELECT id,parent_id,role FROM users'),byId=new Map(users.map(u=>[u.id,u]));
  for(const user of users) {
    const visited=new Set<string>();let cursor=byId.get(user.id);
    while(cursor) {
      if(visited.has(cursor.id)){findings.push({entity:'user',ids:[user.id],code:'OWNERSHIP_CYCLE'});break;}
      visited.add(cursor.id);
      if(!cursor.parent_id){if(cursor.role!=='owner')findings.push({entity:'user',ids:[user.id],code:'MISSING_ROOT'});break;}
      if(!byId.has(cursor.parent_id)){findings.push({entity:'user',ids:[user.id],code:'MISSING_PARENT'});break;}
      cursor=byId.get(cursor.parent_id);
    }
  }
  const usages=await db.query(`SELECT d.id,a.ownership_verified,a.owner_id FROM usage_days d
    JOIN bindings b ON b.id=d.binding_id JOIN accounts a ON a.id=b.account_id ORDER BY d.id`);
  const attributed=usages.filter(d=>d.ownership_verified&&d.owner_id);
  if(!findings.length)for(let start=0;start<attributed.length;start+=500) {
    const ids=attributed.slice(start,start+500).map(d=>d.id);
    try{await assertUsageAccounting(db,ids,{allowProvisional:true});}
    catch(error){if(!(error instanceof AppError))throw error;findings.push({entity:'usage_batch',ids,code:error.code??'ATTRIBUTION_CONFLICT'});}
  }
  const invalid=await db.query(`SELECT DISTINCT d.id FROM usage_days d JOIN bindings b ON b.id=d.binding_id JOIN accounts a ON a.id=b.account_id
    LEFT JOIN earnings e ON e.usage_id=d.id WHERE (NOT a.ownership_verified OR a.owner_id IS NULL) AND (e.id IS NOT NULL OR d.state='final')`);
  for(const row of invalid)findings.push({entity:'usage',ids:[row.id],code:'UNVERIFIED_EARNINGS'});
  const rows=await db.query(`SELECT b.id,b.status,c.enabled,t.data FROM bindings b JOIN connections c ON c.id=b.connection_id LEFT JOIN binding_telemetry t ON t.binding_id=b.id`);
  const snapshots=rows.map(r=>({...r,...snapshotView(r)}));
  const [inventory]=await db.query(`SELECT count(*)::int AS accounts,count(*) FILTER(WHERE ownership_verified AND owner_id IS NOT NULL)::int AS assigned,
    count(*) FILTER(WHERE NOT ownership_verified OR owner_id IS NULL)::int AS awaiting_attribution FROM accounts`);
  return {ok:findings.length===0,checkedAt:new Date().toISOString(),checked:{users:users.length,usageDays:usages.length,attributedUsageDays:attributed.length},
    inventory,unassignedUsageDays:usages.length-attributed.length,currentPlatformTotals:aggregateTelemetry(snapshots,'today'),findings};
}
