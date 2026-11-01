import type { DB } from './db.js';

type SnapshotConflict = {
  earning_id: string; usage_id: string; day: string; previous_day: string;
  previous_id: string; previous_source: string; email: string; provider: string;
  raw_usd: string; gross_usd: string; downstream_usd: string; profit_usd: string;
};

// Equal amounts are evidence for review, not proof of upstream caching.
export async function repeatedInvoiceSnapshots(db: DB, invoiceId: string, lockPrevious = false) {
  return db.query<SnapshotConflict>(`SELECT e.id AS earning_id,u.id AS usage_id,u.day,previous.day AS previous_day,
      previous.id AS previous_id,previous.source AS previous_source,a.email,c.provider,
      u.raw_usd,e.gross_usd,e.downstream_usd,e.profit_usd
    FROM invoice_items i JOIN earnings e ON e.id=i.earning_id
    JOIN usage_days u ON u.id=e.usage_id
    JOIN usage_days previous ON previous.binding_id=u.binding_id
      AND previous.day=(u.day-interval '1 day')::date AND previous.raw_usd=u.raw_usd
    JOIN bindings b ON b.id=u.binding_id JOIN accounts a ON a.id=b.account_id
    JOIN connections c ON c.id=b.connection_id
    WHERE i.invoice_id=$1 AND u.source='daily_snapshot' AND u.raw_usd>0
      AND previous.source IN ('live_snapshot','daily_snapshot')
    ORDER BY u.id ${lockPrevious ? 'FOR UPDATE OF previous' : ''}`, [invoiceId]);
}
