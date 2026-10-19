import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { today, usd } from './core.js';

// Calendar windows end yesterday in Beijing. Read the recorded prices rather
// than repricing old usage at today's quote or extrapolating a quota percentage.
export async function accountEarnings(db: DB, userId: string, endExclusive = today()) {
  const rows = await db.query(`WITH periods(days) AS (VALUES (7),(30))
    SELECT a.id AS account_id,a.email,p.days,
      ($2::date-p.days)::text AS date_from,($2::date-1)::text AS date_to,
      count(DISTINCT b.id)::integer*p.days AS expected_binding_days,
      count(u.id) FILTER (WHERE u.state='final' AND u.source<>'daily_snapshot' AND e.id IS NOT NULL)::integer AS verified_binding_days,
      count(u.id) FILTER (WHERE u.source='daily_snapshot')::integer AS snapshot_binding_days,
      count(u.id) FILTER (WHERE u.state='provisional' AND u.source<>'daily_snapshot')::integer AS provisional_binding_days,
      sum(u.raw_usd) FILTER (WHERE u.state='final' AND u.source<>'daily_snapshot' AND e.id IS NOT NULL) AS raw_usd,
      sum(e.gross_usd) FILTER (WHERE u.state='final' AND u.source<>'daily_snapshot') AS gross_usd,
      sum(CASE WHEN i.state='confirmed' THEN e.profit_usd ELSE 0 END)
        FILTER (WHERE u.state='final' AND u.source<>'daily_snapshot' AND e.id IS NOT NULL) AS confirmed_profit_usd
    FROM accounts a CROSS JOIN periods p
    LEFT JOIN bindings b ON b.account_id=a.id
    LEFT JOIN usage_days u ON u.binding_id=b.id AND u.day>=$2::date-p.days AND u.day<$2::date
    LEFT JOIN earnings e ON e.usage_id=u.id AND e.user_id=$1
    LEFT JOIN invoice_items x ON x.earning_id=e.id LEFT JOIN invoices i ON i.id=x.invoice_id
    WHERE a.owner_id=$1 AND a.ownership_verified
    GROUP BY a.id,a.email,p.days ORDER BY a.email,p.days`, [userId, endExclusive]);
  return { asOf: endExclusive, accounts: rows.reduce<any[]>((accounts, row) => {
    let account = accounts.at(-1);
    if (account?.id !== row.account_id) { account = { id: row.account_id, email: row.email, periods: {} }; accounts.push(account); }
    account.periods[row.days === 7 ? '7d' : '30d'] = {
      from: row.date_from, to: row.date_to,
      expectedBindingDays: row.expected_binding_days, verifiedBindingDays: row.verified_binding_days,
      snapshotBindingDays: row.snapshot_binding_days, provisionalBindingDays: row.provisional_binding_days,
      complete: row.expected_binding_days > 0 && row.verified_binding_days === row.expected_binding_days,
      rawUsd: row.raw_usd === null ? null : usd(row.raw_usd), grossUsd: row.gross_usd === null ? null : usd(row.gross_usd),
      confirmedProfitUsd: row.confirmed_profit_usd === null ? null : usd(row.confirmed_profit_usd),
    };
    return accounts;
  }, []) };
}

export function registerMonetization(app: FastifyInstance, db: DB) {
  app.get('/api/monetization', async req => accountEarnings(db, req.user.id));
}
