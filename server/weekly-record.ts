import type { DB } from './db.js';
import { today, usd } from './core.js';
import type { WeeklyRecordReport } from '../shared/monetization.js';

// One account, seven consecutive completed Beijing dates. Every binding must
// have a final, non-estimated bill and that account owner's frozen earnings.
// Return only the aggregate and dates: account and member identities stay private.
export async function historicalWeeklyRecord(db: DB, endExclusive = today()): Promise<WeeklyRecordReport> {
  const [record] = await db.query(`WITH expected AS (
    SELECT a.id,a.owner_id,count(b.id) AS bindings
    FROM accounts a JOIN bindings b ON b.account_id=a.id
    WHERE a.ownership_verified GROUP BY a.id,a.owner_id
  ), daily AS (
    SELECT a.id,u.day,sum(e.gross_usd) AS receivable_usd
    FROM expected a JOIN bindings b ON b.account_id=a.id
    JOIN usage_days u ON u.binding_id=b.id
    JOIN earnings e ON e.usage_id=u.id AND e.user_id=a.owner_id
    WHERE u.state='final' AND u.source<>'daily_snapshot' AND u.day<$1::date
    GROUP BY a.id,a.bindings,u.day HAVING count(u.id)=a.bindings
  ), windows AS (
    SELECT day,lag(day,6) OVER account_days AS first_day,
      sum(receivable_usd) OVER (PARTITION BY id ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS receivable_usd
    FROM daily WINDOW account_days AS (PARTITION BY id ORDER BY day)
  ) SELECT first_day::text AS date_from,day::text AS date_to,receivable_usd
    FROM windows WHERE first_day=day-6
    ORDER BY receivable_usd DESC,day DESC LIMIT 1`, [endExclusive]);
  return { asOf: endExclusive, days: 7, record: record ? { from: record.date_from, to: record.date_to, receivableUsd: usd(record.receivable_usd) } : null };
}

// Public landing pages share one short-lived query, including concurrent loads.
export function weeklyRecordReader(db: DB) {
  let cached: { until: number; report: WeeklyRecordReport } | undefined;
  let pending: { day: string; promise: Promise<WeeklyRecordReport> } | undefined;
  return async () => {
    const day = today();
    if (cached && cached.report.asOf === day && cached.until > Date.now()) return cached.report;
    if (pending?.day === day) return pending.promise;
    const promise = historicalWeeklyRecord(db, day).then(report => {
      cached = { until: Date.now() + 60000, report };
      return report;
    }).finally(() => { if (pending?.promise === promise) pending = undefined; });
    pending = { day, promise };
    return promise;
  };
}

export const isPublicWeeklyRecord = (method: string, route?: string) =>
  ['GET', 'HEAD'].includes(method) && route === '/api/marketing/weekly-record';
