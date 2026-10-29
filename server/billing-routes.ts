import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB, Row } from './db.js';
import { assert, audit, requireOwner, today, type SecretBox } from './core.js';
import { queueBillingRange, shiftBillingDay } from './billing-scheduler.js';
import { snapshotDay } from './billing-snapshots.js';
import { recordDailyStatement } from './daily-billing.js';
import { publicPlatformName } from './platform-privacy.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(v)) && new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v,'日期无效');

export function registerBilling(app: FastifyInstance, db: DB, box: SecretBox) {
  app.get('/api/billing/days', async req => {
    await requireOwner(req.user);
    const q=z.object({from:date.default(shiftBillingDay(today(),-30)),to:date.default(today()),provider:z.string().max(30).default(''),page:z.coerce.number().int().min(1).max(10000).default(1)}).parse(req.query);
    assert(q.from<=q.to,'开始日期不能晚于结束日期');
    const params=[q.from,q.to,q.provider];
    const [totals]=await db.query(`SELECT count(*)::int AS count,count(*) FILTER(WHERE d.state='succeeded')::int AS succeeded,
      count(*) FILTER(WHERE d.state IN ('failed','needs_attention','awaiting_data'))::int AS attention
      FROM billing_days d JOIN connections c ON c.id=d.connection_id WHERE d.day BETWEEN $1 AND $2 AND ($3='' OR c.provider=$3)`,params);
    const rows=await db.query(`SELECT d.*,c.provider,c.name AS connection_name,s.raw_usd,s.created_at AS source_at,
      EXISTS(SELECT 1 FROM billing_entries be JOIN usage_days u ON u.id=be.usage_id
        WHERE be.connection_id=d.connection_id AND be.day=d.day AND u.source='reviewed_statement') AS reviewed
      FROM billing_days d JOIN connections c ON c.id=d.connection_id LEFT JOIN upstream_statements s ON s.id=d.statement_id
      WHERE d.day BETWEEN $1 AND $2 AND ($3='' OR c.provider=$3) ORDER BY d.day DESC,c.provider,c.id LIMIT 12 OFFSET $4`,[...params,(q.page-1)*12]);
    return {rows:rows.map(({source_error,...row})=>({...row,connection_name:`${publicPlatformName(row.provider)} · ${row.connection_id.slice(0,8)}`})),totals,page:q.page,total:totals.count,timezone:'Asia/Shanghai',dailyAfter:'02:00'};
  });
  app.post('/api/billing/collect',async req=>{
    await requireOwner(req.user);
    const d=z.object({connectionIds:z.array(z.string().uuid()).min(1).max(20),from:date,to:date}).strict().parse(req.body);
    const jobs=await queueBillingRange(db,box,req.user,d.connectionIds,d.from,d.to);
    await audit(db,req.user.id,'billing.collect',undefined,{connectionIds:d.connectionIds,from:d.from,to:d.to,jobs:jobs.length});
    return {jobs};
  });
  app.post('/api/billing/finalize-snapshot',async req=>{
    await requireOwner(req.user);
    const d=z.object({connectionId:z.string().uuid(),day:date,evidence:z.string().trim().min(5).max(2000)}).strict().parse(req.body);
    assert(d.day<today(),'只能核实已经结束的北京时间日期');
    const [connection]=await db.query('SELECT * FROM connections WHERE id=$1',[d.connectionId]);
    assert(connection,'平台连接不存在',404);
    await db.query(`INSERT INTO billing_days(connection_id,day) VALUES($1,$2)
      ON CONFLICT(connection_id,day) DO NOTHING`,[connection.id,d.day]);
    const snapshot=await snapshotDay(db,connection,d.day);
    assert(snapshot.rows.length,'没有可核实的日终快照，请先等待平台采集或补充原始日账单',409);
    const result=await recordDailyStatement(db,connection,req.user,d.day,snapshot.rows,{basis:'snapshot',autoFinalize:true,reviewed:true,issues:snapshot.issues,sourceError:'管理员核实日终快照'});
    await audit(db,req.user.id,'billing.snapshot_finalize',connection.id,{day:d.day,evidence:d.evidence,accounts:snapshot.rows.length,issues:snapshot.issues.length,finalized:result.finalized});
    return {...result,evidence:d.evidence};
  });
  app.get('/api/billing/statements/:id',async(req,reply)=>{
    await requireOwner(req.user);
    const target=z.string().uuid().parse((req.params as Row).id);
    const [statement]=await db.query('SELECT * FROM upstream_statements WHERE id=$1',[target]);
    assert(statement,'账单不存在',404);
    return reply.header('Content-Disposition',`attachment; filename="ccmax-statement-${statement.day}-${target}.json"`).send(statement);
  });
}
