import type { DB } from './db.js';
import { AppError,today } from './core.js';
import { auditAttribution } from './attribution-audit.js';
import { assertInvoiceAccounting,assertWalletAccounting } from './financial-integrity.js';

// The caller supplies a repeatable-read, read-only transaction. This report
// never confirms invoices, changes ownership or manufactures ledger entries.
export async function auditFinance(db:DB) {
  const attribution=await auditAttribution(db);
  const findings:{entity:string;ids:string[];code:string;message?:string}[]=[...attribution.findings];
  const users=await db.query('SELECT id FROM users ORDER BY id');
  const pending=await db.query("SELECT * FROM invoices WHERE state='pending' ORDER BY id");
  async function check(entity:string,ids:string[],action:()=>Promise<void>) {
    try{await action();}
    catch(error){if(!(error instanceof AppError))throw error;findings.push({entity,ids,code:error.code??'ACCOUNTING_CONFLICT',message:error.message});}
  }
  // A malformed legacy hierarchy must be reported before recursive funding
  // checks; otherwise a cycle can keep a read-only audit running indefinitely.
  const validHierarchy=!findings.some(f=>['OWNERSHIP_CYCLE','MISSING_ROOT','MISSING_PARENT'].includes(f.code));
  if(validHierarchy) {
    for(const user of users)await check('wallet',[user.id],()=>assertWalletAccounting(db,user.id));
    for(const invoice of pending)await check('invoice',[invoice.id],()=>assertInvoiceAccounting(db,invoice));
  }
  const day=today();
  const wallets=await db.query(`SELECT u.id,u.parent_id,
    COALESCE(l.available,0) AS personal_available,COALESCE(t.available,0) AS team_available,
    COALESCE(l.available,0)+COALESCE(t.available,0) AS available,
    COALESCE(w.pending,0) AS pending,COALESCE(w.paid,0) AS paid_withdrawal_usd,
    COALESCE(w.paid_profit,0) AS paid_profit_withdrawal_usd,COALESCE(w.paid_team,0) AS paid_team_withdrawal_usd,
    COALESCE(i.confirmed_profit,0)+COALESCE(a.profit,0) AS confirmed_profit_usd
    FROM users u LEFT JOIN (SELECT user_id,sum(amount_usd) AS available FROM ledger GROUP BY user_id) l ON l.user_id=u.id
    LEFT JOIN (SELECT user_id,sum(amount_usd) AS available FROM team_fund_ledger GROUP BY user_id) t ON t.user_id=u.id
    LEFT JOIN (SELECT user_id,sum(amount_usd) FILTER(WHERE state='pending') AS pending,
      sum(amount_usd) FILTER(WHERE state='paid') AS paid,
      sum(amount_usd-team_amount_usd) FILTER(WHERE state='paid') AS paid_profit,
      sum(team_amount_usd) FILTER(WHERE state='paid') AS paid_team FROM withdrawals GROUP BY user_id) w ON w.user_id=u.id
    LEFT JOIN (SELECT user_id,sum(profit_usd) FILTER(WHERE state='confirmed') AS confirmed_profit FROM invoices GROUP BY user_id) i ON i.user_id=u.id
    LEFT JOIN (SELECT user_id,sum(profit_usd) AS profit FROM settlement_adjustments GROUP BY user_id) a ON a.user_id=u.id
    ORDER BY u.created_at,u.id`);
  const platforms=await db.query(`WITH inventory AS (
    SELECT b.connection_id,count(*)::int AS accounts,
      count(*) FILTER(WHERE a.ownership_verified AND a.owner_id IS NOT NULL)::int AS assigned
      FROM bindings b JOIN accounts a ON a.id=b.account_id GROUP BY b.connection_id
    ), usage AS (
    SELECT b.connection_id,count(*)::int AS usage_days,count(*) FILTER(WHERE d.state='final')::int AS finalized_days,
      count(*) FILTER(WHERE d.state='provisional' AND d.day<$1)::int AS awaiting_finalization_days,
      COALESCE(sum(d.raw_usd) FILTER(WHERE d.state='final'),0) AS finalized_raw_usd,
      COALESCE(sum(d.raw_usd) FILTER(WHERE d.state='provisional' AND d.day<$1),0) AS awaiting_finalization_raw_usd,
      COALESCE(sum(d.raw_usd) FILTER(WHERE NOT a.ownership_verified OR a.owner_id IS NULL),0) AS unassigned_raw_usd,
      COALESCE(sum(e.gross_usd) FILTER(WHERE d.state='final' AND x.earning_id IS NULL),0) AS uninvoiced_receivable_usd
      FROM usage_days d JOIN bindings b ON b.id=d.binding_id JOIN accounts a ON a.id=b.account_id
      LEFT JOIN earnings e ON e.usage_id=d.id AND e.user_id=(SELECT id FROM users WHERE role='owner')
      LEFT JOIN invoice_items x ON x.earning_id=e.id GROUP BY b.connection_id
    ) SELECT c.id,c.provider,c.enabled,c.status,c.last_sync_at,
      COALESCE(i.accounts,0)::int AS accounts,COALESCE(i.assigned,0)::int AS assigned,
      (COALESCE(i.accounts,0)-COALESCE(i.assigned,0))::int AS unassigned,
      COALESCE(d.usage_days,0)::int AS usage_days,COALESCE(d.finalized_days,0)::int AS finalized_days,
      COALESCE(d.awaiting_finalization_days,0)::int AS awaiting_finalization_days,
      COALESCE(d.finalized_raw_usd,0) AS finalized_raw_usd,
      COALESCE(d.awaiting_finalization_raw_usd,0) AS awaiting_finalization_raw_usd,
      COALESCE(d.unassigned_raw_usd,0) AS unassigned_raw_usd,
      COALESCE(d.uninvoiced_receivable_usd,0) AS uninvoiced_receivable_usd
      FROM connections c LEFT JOIN inventory i ON i.connection_id=c.id LEFT JOIN usage d ON d.connection_id=c.id ORDER BY c.created_at,c.id`,[day]);
  const [totals]=await db.query(`SELECT
    (SELECT COALESCE(sum(amount_usd),0) FROM ledger) AS available_profit_usd,
    (SELECT COALESCE(sum(amount_usd),0) FROM team_fund_ledger) AS available_team_funds_usd,
    (SELECT COALESCE(sum(amount_usd),0) FROM ledger)+(SELECT COALESCE(sum(amount_usd),0) FROM team_fund_ledger) AS available_funds_usd,
    (SELECT COALESCE(sum(amount_usd),0) FROM withdrawals WHERE state='pending') AS pending_withdrawal_usd,
    (SELECT count(*)::int FROM usage_days WHERE state='final') AS finalized_usage_days,
    (SELECT count(*)::int FROM usage_days WHERE state='provisional') AS provisional_usage_days`);
  return {ok:findings.length===0,checkedAt:new Date().toISOString(),day,
    checked:{wallets:validHierarchy?users.length:0,pendingInvoices:validHierarchy?pending.length:0,
      finalizedUsageDays:totals.finalized_usage_days,provisionalUsageDays:totals.provisional_usage_days},
    inventory:attribution.inventory,unassignedUsageDays:attribution.unassignedUsageDays,
    totals:{available_profit_usd:totals.available_profit_usd,available_team_funds_usd:totals.available_team_funds_usd,
      available_funds_usd:totals.available_funds_usd,pending_withdrawal_usd:totals.pending_withdrawal_usd},
    wallets,platforms,findings};
}
