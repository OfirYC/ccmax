import Decimal from 'decimal.js';
import type { DB, Row } from './db.js';
import { AppError, ancestry, dayString, today, usd } from './core.js';

const conflict = (message: string, code: string): never => { throw new AppError(409, message, code); };
function accountingConflict(): never { return conflict('用量的收益链或金额不一致，请核对原始账单，不能继续结算', 'USAGE_ACCOUNTING_CONFLICT'); }
export const invoiceConflict = () => conflict('账单明细、归属或汇总金额不一致，请核对后再确认', 'INVOICE_INTEGRITY_CONFLICT');
export const walletConflict = () => conflict('资金流水与原始账单或提现记录不一致，请核对后再操作', 'WALLET_INTEGRITY_CONFLICT');
const sameId = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
const sameMoney = (a: Decimal.Value, b: Decimal.Value) => new Decimal(a).eq(b);

// Reconcile frozen prices, never today's contracts. Sealed legacy records are
// preserved, but an incomplete or inconsistent chain cannot create new credit.
export async function assertUsageAccounting(db: DB, usageIds: string[]) {
  if (!usageIds.length) return;
  const ids = [...new Set(usageIds)];
  const usages = await db.query(`SELECT d.*,a.owner_id,a.ownership_verified FROM usage_days d
    JOIN bindings b ON b.id=d.binding_id JOIN accounts a ON a.id=b.account_id WHERE d.id=ANY($1::text[])`, [ids]);
  const earnings = await db.query('SELECT * FROM earnings WHERE usage_id=ANY($1::text[])', [ids]);
  if (earnings.some(e => new Decimal(e.downstream_rate).gt(e.rate) || new Decimal(e.profit_usd).lt(0))) {
    conflict('账单存在层级价格倒挂，请先核对价格及相关用量，不能继续结算', 'RATE_HIERARCHY_CONFLICT');
  }
  const chain = await db.query(`WITH RECURSIVE chain AS (
    SELECT d.id AS usage_id,u.id,u.parent_id,u.role,0 AS depth FROM usage_days d
      JOIN bindings b ON b.id=d.binding_id JOIN accounts a ON a.id=b.account_id JOIN users u ON u.id=a.owner_id
      WHERE d.id=ANY($1::text[])
    UNION ALL SELECT c.usage_id,u.id,u.parent_id,u.role,c.depth+1 FROM users u JOIN chain c ON c.parent_id=u.id
  ) SELECT * FROM chain ORDER BY usage_id,depth DESC`, [ids]);
  const grouped = (rows: Row[]) => {
    const map = new Map<string, Row[]>();
    for (const row of rows) { const group = map.get(row.usage_id) || []; group.push(row); map.set(row.usage_id, group); }
    return map;
  };
  const chains = grouped(chain), priced = grouped(earnings);
  if (usages.length !== ids.length) accountingConflict();
  for (const usage of usages) {
    const members = chains.get(usage.id) || [], rows = priced.get(usage.id) || [];
    if (usage.state !== 'final' || !usage.ownership_verified || !members.length || members[0].role !== 'owner' || rows.length !== members.length) accountingConflict();
    const byUser = new Map(rows.map(row => [row.user_id, row]));
    for (let index = 0; index < members.length; index++) {
      const member = members[index], earning = byUser.get(member.id), next = byUser.get(members[index + 1]?.id);
      if (!earning || !sameId(earning.payer_id, member.parent_id) || !sameId(earning.next_user_id, members[index + 1]?.id)
        || (index === 0 && !sameMoney(earning.rate, usage.root_rate)) || (index + 1 < members.length && !next)) accountingConflict();
      const downstream = next?.rate ?? '0';
      const gross = usd(new Decimal(usage.raw_usd).mul(earning.rate)), payable = usd(new Decimal(usage.raw_usd).mul(downstream));
      if (!sameMoney(earning.downstream_rate, downstream) || !sameMoney(earning.gross_usd, gross)
        || !sameMoney(earning.downstream_usd, payable) || !sameMoney(earning.profit_usd, new Decimal(gross).minus(payable))) accountingConflict();
    }
  }
}

export async function assertInvoiceAccounting(db: DB, invoice: Row) {
  const items = await db.query(`SELECT e.*,d.day,d.state AS usage_state FROM invoice_items i
    JOIN earnings e ON e.id=i.earning_id JOIN usage_days d ON d.id=e.usage_id WHERE i.invoice_id=$1`, [invoice.id]);
  const [user] = await db.query('SELECT parent_id FROM users WHERE id=$1', [invoice.user_id]);
  if (!user || !sameId(invoice.payer_id, user.parent_id) || dayString(invoice.date_from)>dayString(invoice.date_to)
    || dayString(invoice.date_to)>=today() || !items.length || items.some(item => item.user_id !== invoice.user_id
    || !sameId(item.payer_id, invoice.payer_id) || item.usage_state !== 'final'
    || dayString(item.day) < dayString(invoice.date_from) || dayString(item.day) > dayString(invoice.date_to))) invoiceConflict();
  for (const field of ['gross_usd', 'downstream_usd', 'profit_usd']) {
    const total = items.reduce<Decimal>((total, item) => total.plus(item[field]), new Decimal(0));
    if (!sameMoney(invoice[field], total)) invoiceConflict();
  }
  await assertUsageAccounting(db, items.map(item => item.usage_id));
}

export async function assertFundingAccounting(db: DB, usageIds: string[], userId: string) {
  if (!usageIds.length) return;
  const ancestors = (await ancestry(db, userId)).filter(user => user.id !== userId).map(user => user.id);
  if (!ancestors.length) return;
  const parents = await db.query(`SELECT i.*,e.user_id AS earning_user,e.payer_id AS earning_payer,
    l.user_id AS credited_user,l.amount_usd AS credited_amount FROM earnings e
    LEFT JOIN invoice_items x ON x.earning_id=e.id LEFT JOIN invoices i ON i.id=x.invoice_id
    LEFT JOIN ledger l ON l.kind='settlement' AND l.reference_id=i.id
    WHERE e.usage_id=ANY($1::text[]) AND e.user_id=ANY($2::text[])`, [[...new Set(usageIds)], ancestors]);
  if (parents.some(invoice => invoice.state !== 'confirmed' || invoice.user_id !== invoice.earning_user
    || !sameId(invoice.payer_id, invoice.earning_payer) || invoice.credited_user !== invoice.earning_user
    || !sameMoney(invoice.credited_amount, invoice.profit_usd))) {
    conflict('对应上级账单尚未确认回款，请先从平台到下级逐层结算', 'UPSTREAM_SETTLEMENT_REQUIRED');
  }
  for (const invoice of new Map(parents.map(invoice => [invoice.id, invoice])).values()) await assertInvoiceAccounting(db, invoice);
}

// One SQL snapshot checks all wallet sources, including legacy entries written
// before source guards existed. The user lock serializes balance-changing writes.
export async function assertWalletAccounting(db: DB, userId: string) {
  const [invalid] = await db.query(`SELECT 1 FROM (
    SELECT l.id FROM ledger l LEFT JOIN invoices i ON i.id=l.reference_id LEFT JOIN withdrawals w ON w.id=l.reference_id
    WHERE l.user_id=$1 AND (
      (l.kind='settlement' AND (i.id IS NULL OR i.state<>'confirmed' OR i.user_id<>l.user_id OR i.profit_usd<>l.amount_usd OR l.amount_usd<0
        OR NOT EXISTS(SELECT 1 FROM invoice_items x WHERE x.invoice_id=i.id)
        OR EXISTS(SELECT 1 FROM invoice_items x JOIN earnings e ON e.id=x.earning_id JOIN usage_days d ON d.id=e.usage_id
          WHERE x.invoice_id=i.id AND (e.user_id<>i.user_id OR e.payer_id IS DISTINCT FROM i.payer_id OR d.state<>'final' OR d.day NOT BETWEEN i.date_from AND i.date_to))
        OR (i.gross_usd,i.downstream_usd,i.profit_usd) IS DISTINCT FROM
          (SELECT ROW(sum(e.gross_usd),sum(e.downstream_usd),sum(e.profit_usd)) FROM invoice_items x JOIN earnings e ON e.id=x.earning_id WHERE x.invoice_id=i.id)))
      OR (l.kind='withdrawal_hold' AND (w.id IS NULL OR w.user_id<>l.user_id OR l.amount_usd<>-w.amount_usd))
      OR (l.kind='withdrawal_release' AND (w.id IS NULL OR w.user_id<>l.user_id OR w.state<>'rejected' OR l.amount_usd<>w.amount_usd)))
    UNION ALL
    SELECT i.id FROM invoices i WHERE i.user_id=$1 AND i.state='confirmed'
      AND NOT EXISTS(SELECT 1 FROM ledger l WHERE l.kind='settlement' AND l.reference_id=i.id AND l.user_id=i.user_id AND l.amount_usd=i.profit_usd)
    UNION ALL
    SELECT w.id FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.user_id=$1 AND (
      w.payer_id IS DISTINCT FROM u.parent_id
      OR NOT EXISTS(SELECT 1 FROM ledger l WHERE l.kind='withdrawal_hold' AND l.reference_id=w.id AND l.user_id=w.user_id AND l.amount_usd=-w.amount_usd)
      OR ((w.state='rejected') IS DISTINCT FROM EXISTS(SELECT 1 FROM ledger l WHERE l.kind='withdrawal_release' AND l.reference_id=w.id AND l.user_id=w.user_id AND l.amount_usd=w.amount_usd)))
    UNION ALL
    SELECT $1::text FROM ledger WHERE user_id=$1 HAVING COALESCE(sum(amount_usd),0)<0
  ) problems LIMIT 1`, [userId]);
  if (invalid) walletConflict();
  const usages = await db.query(`SELECT DISTINCT e.usage_id FROM ledger l JOIN invoices i ON i.id=l.reference_id
    JOIN invoice_items x ON x.invoice_id=i.id JOIN earnings e ON e.id=x.earning_id WHERE l.user_id=$1 AND l.kind='settlement'`, [userId]);
  await assertUsageAccounting(db, usages.map(row => row.usage_id));
  await assertFundingAccounting(db, usages.map(row => row.usage_id), userId);
}
