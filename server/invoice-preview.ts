import { createHash } from 'node:crypto';
import type { DB, Row } from './db.js';
import { assert, dayString, MAX_USD, subtree, sum, today, usd } from './core.js';
import { assertUsageAccounting } from './financial-integrity.js';

export async function invoiceItems(db: DB, userId: string, from: string, to: string) {
  return db.query(`SELECT e.* FROM earnings e JOIN usage_days u ON u.id=e.usage_id
    LEFT JOIN invoice_items i ON i.earning_id=e.id WHERE e.user_id=$1 AND u.state='final'
    AND u.day BETWEEN $2 AND $3 AND i.earning_id IS NULL ORDER BY e.id`, [userId, from, to]);
}

// A review is tied to the exact frozen earning rows, not just rounded totals.
export function invoicePreviewToken(userId: string, from: string, to: string, items: Row[]) {
  return createHash('sha256').update(JSON.stringify([userId, from, to, items.map(item =>
    ['id','usage_id','user_id','payer_id','next_user_id','rate','downstream_rate','gross_usd','downstream_usd','profit_usd'].map(field => item[field]))])).digest('hex');
}

export async function previewInvoice(db: DB, actor: Row, userId: string, from: string, to: string) {
  assert(from <= to && to < today(), '仅可结算已经结束的北京时间日期');
  const [user] = await db.query('SELECT id,parent_id,role FROM users WHERE id=$1', [userId]);
  assert(user && (user.id === actor.id || user.parent_id === actor.id), '只能为自己或直属下级生成账单', 403);
  const ids = await subtree(db, user.id);
  const platforms = await db.query(`WITH scoped AS (
    SELECT u.*,b.connection_id,c.provider,c.name AS connection_name,a.ownership_verified,
      e.id AS earning_id,e.rate,e.gross_usd,e.downstream_usd,e.profit_usd,i.invoice_id
    FROM usage_days u JOIN bindings b ON b.id=u.binding_id JOIN connections c ON c.id=b.connection_id
    JOIN accounts a ON a.id=b.account_id LEFT JOIN earnings e ON e.usage_id=u.id AND e.user_id=$1
    LEFT JOIN invoice_items i ON i.earning_id=e.id
    WHERE ((a.owner_id=ANY($2::text[]) AND a.ownership_verified) OR $3::boolean) AND u.day BETWEEN $4 AND $5
  ) SELECT connection_id,provider,connection_name,min(day) AS first_day,
    count(*) FILTER (WHERE NOT ownership_verified) AS unassigned_count,
    COALESCE(sum(raw_usd) FILTER (WHERE NOT ownership_verified),0) AS unassigned_raw_usd,
    count(*) FILTER (WHERE ownership_verified AND state='provisional') AS provisional_count,
    COALESCE(sum(raw_usd) FILTER (WHERE ownership_verified AND state='provisional'),0) AS provisional_raw_usd,
    count(*) FILTER (WHERE ownership_verified AND state='final' AND earning_id IS NULL) AS missing_earnings,
    count(*) FILTER (WHERE state='final' AND invoice_id IS NOT NULL) AS invoiced_count,
    COALESCE(sum(gross_usd) FILTER (WHERE state='final' AND invoice_id IS NOT NULL),0) AS invoiced_gross_usd,
    count(*) FILTER (WHERE state='final' AND earning_id IS NOT NULL AND invoice_id IS NULL) AS ready_count,
    COALESCE(array_agg(DISTINCT rate ORDER BY rate) FILTER (WHERE state='final' AND earning_id IS NOT NULL AND invoice_id IS NULL),ARRAY[]::numeric[]) AS ready_rates,
    COALESCE(sum(raw_usd) FILTER (WHERE state='final' AND earning_id IS NOT NULL AND invoice_id IS NULL),0) AS ready_raw_usd,
    COALESCE(sum(gross_usd) FILTER (WHERE state='final' AND earning_id IS NOT NULL AND invoice_id IS NULL),0) AS ready_gross_usd,
    COALESCE(sum(downstream_usd) FILTER (WHERE state='final' AND earning_id IS NOT NULL AND invoice_id IS NULL),0) AS ready_downstream_usd,
    COALESCE(sum(profit_usd) FILTER (WHERE state='final' AND earning_id IS NOT NULL AND invoice_id IS NULL),0) AS ready_profit_usd
    FROM scoped GROUP BY connection_id,provider,connection_name ORDER BY provider,connection_id`, [user.id, ids, user.role === 'owner', from, to]);
  assert(!platforms.some(p => Number(p.missing_earnings)), '用量的收益链或金额不一致，请核对原始账单，不能继续结算', 409);
  const items = await invoiceItems(db, user.id, from, to);
  await assertUsageAccounting(db, items.map(item => item.usage_id));
  const total = (field: string) => usd(sum(platforms.map(p => p[field])));
  const count = (field: string) => platforms.reduce((n, p) => n + Number(p[field]), 0);
  const ready = { count: items.length, raw_usd: total('ready_raw_usd'),
    ...Object.fromEntries(['gross_usd','downstream_usd','profit_usd'].map(field => [field, usd(sum(items.map(item => item[field])))])) };
  const withinLimit = ['gross_usd','downstream_usd','profit_usd'].every(field => sum(items.map(item => item[field])).abs().lte(MAX_USD));
  return { userId: user.id, from, to, firstDay: platforms.length ? platforms.map(p => dayString(p.first_day)).sort()[0] : null,
    ready, withinLimit, previewToken: invoicePreviewToken(user.id, from, to, items),
    unassigned: { count: count('unassigned_count'), raw_usd: total('unassigned_raw_usd') },
    provisional: { count: count('provisional_count'), raw_usd: total('provisional_raw_usd') },
    invoiced: { count: count('invoiced_count'), gross_usd: total('invoiced_gross_usd') },
    platforms: platforms.map(({ missing_earnings, first_day, ...p }) => ({ ...p,
      ...Object.fromEntries(['ready_count','unassigned_count','provisional_count','invoiced_count'].map(field => [field, Number(p[field])])) })) };
}
