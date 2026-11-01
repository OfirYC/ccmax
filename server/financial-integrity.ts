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
export async function assertUsageAccounting(db: DB, usageIds: string[], options:{allowProvisional?:boolean}={}) {
  if (!usageIds.length) return;
  const ids = [...new Set(usageIds)];
  const usages = await db.query(`SELECT d.*,a.owner_id,a.ownership_verified FROM usage_days d
    JOIN bindings b ON b.id=d.binding_id JOIN accounts a ON a.id=b.account_id WHERE d.id=ANY($1::text[])`, [ids]);
  const earnings = await db.query('SELECT * FROM earnings WHERE usage_id=ANY($1::text[])', [ids]);
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
    if ((usage.state !== 'final' && !(options.allowProvisional&&usage.state==='provisional')) || !usage.ownership_verified || !members.length || members[0].role !== 'owner' || rows.length !== members.length) accountingConflict();
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

// Key supply usage is settled directly from an append-only New API snapshot.
// Keep the same source-of-truth checks as legacy invoices: every credited
// entry must have one matching ledger row, and its frozen arithmetic must be
// internally consistent even when the remote counter moves backwards.
export async function assertTaskSettlementAccounting(db: DB, userId: string) {
  const entries = await db.query(`SELECT e.*,s.used_quota,s.quota_per_unit,s.used_usd,s.delta_quota,s.delta_usd,
      c.task_id,c.supplier_user_id,t.root_rate
    FROM task_settlement_entries e
    JOIN task_usage_snapshots s ON s.id=e.snapshot_id
    JOIN task_channels c ON c.id=s.channel_id
    JOIN key_tasks t ON t.id=c.task_id
    WHERE e.user_id=$1`, [userId]);
  if (!entries.length) return;
  const ledger = await db.query(`SELECT reference_id,kind,amount_usd FROM ledger
    WHERE user_id=$1 AND kind IN ('task_settlement','task_adjustment')`, [userId]);
  const byReference = new Map(ledger.map(row => [`${row.kind}:${row.reference_id}`, row]));
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.id}`;
    const source = byReference.get(key);
    if (!source || !sameMoney(source.amount_usd, entry.profit_usd)) walletConflict();
    const rate = new Decimal(entry.rate), downstream = new Decimal(entry.downstream_rate);
    const gross = new Decimal(entry.gross_usd), payable = new Decimal(entry.downstream_usd), profit = new Decimal(entry.profit_usd);
    const usedQuota = new Decimal(entry.used_quota), deltaQuota = new Decimal(entry.delta_quota), delta = new Decimal(entry.delta_usd);
    if (!rate.gte(0) || !rate.lte(1) || !downstream.gte(0) || !downstream.lte(1)
      || !gross.minus(payable).eq(profit) || new Decimal(entry.quota_per_unit).lte(0)
      || !usedQuota.isFinite() || !deltaQuota.isFinite() || !delta.isFinite() || usedQuota.lt(0) || usedQuota.minus(deltaQuota).lt(0)
      || !sameMoney(entry.used_usd, usd(usedQuota.div(entry.quota_per_unit)))
      || !sameMoney(entry.delta_usd, usd(deltaQuota.div(entry.quota_per_unit)))
      || !sameMoney(gross, usd(delta.mul(rate))) || !sameMoney(payable, usd(delta.mul(downstream)))) walletConflict();
  }
}

// One SQL snapshot checks all wallet sources, including legacy entries written
// before source guards existed. The user lock serializes balance-changing writes.
export async function assertWalletAccounting(db: DB, userId: string) {
  const [invalid] = await db.query(`SELECT 1 FROM (
    SELECT l.id FROM ledger l LEFT JOIN invoices i ON i.id=l.reference_id LEFT JOIN withdrawals w ON w.id=l.reference_id
      LEFT JOIN task_settlement_entries te ON te.id=l.reference_id LEFT JOIN settlement_adjustments sa ON sa.id=l.reference_id
    WHERE l.user_id=$1 AND (
      (l.kind='settlement' AND (i.id IS NULL OR i.state<>'confirmed' OR i.user_id<>l.user_id OR i.profit_usd<>l.amount_usd
        OR NOT EXISTS(SELECT 1 FROM invoice_items x WHERE x.invoice_id=i.id)
        OR EXISTS(SELECT 1 FROM invoice_items x JOIN earnings e ON e.id=x.earning_id JOIN usage_days d ON d.id=e.usage_id
          WHERE x.invoice_id=i.id AND (e.user_id<>i.user_id OR e.payer_id IS DISTINCT FROM i.payer_id OR d.state<>'final' OR d.day NOT BETWEEN i.date_from AND i.date_to))
        OR (i.gross_usd,i.downstream_usd,i.profit_usd) IS DISTINCT FROM
          (SELECT ROW(sum(e.gross_usd),sum(e.downstream_usd),sum(e.profit_usd)) FROM invoice_items x JOIN earnings e ON e.id=x.earning_id WHERE x.invoice_id=i.id)))
      OR (l.kind='withdrawal_hold' AND (w.id IS NULL OR w.user_id<>l.user_id OR l.amount_usd<>-(w.amount_usd-w.team_amount_usd)))
      OR (l.kind='withdrawal_release' AND (w.id IS NULL OR w.user_id<>l.user_id OR w.state<>'rejected' OR l.amount_usd<>w.amount_usd-w.team_amount_usd))
      OR (l.kind='settlement_adjustment' AND (sa.id IS NULL OR sa.user_id<>l.user_id OR sa.profit_usd<>l.amount_usd))
      OR (l.kind IN ('task_settlement','task_adjustment') AND (te.id IS NULL OR te.user_id<>l.user_id OR te.kind<>l.kind OR te.profit_usd<>l.amount_usd)))
    UNION ALL
    SELECT i.id FROM invoices i WHERE i.user_id=$1 AND i.state='confirmed'
      AND NOT EXISTS(SELECT 1 FROM ledger l WHERE l.kind='settlement' AND l.reference_id=i.id AND l.user_id=i.user_id AND l.amount_usd=i.profit_usd)
    UNION ALL
    SELECT w.id FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.user_id=$1 AND (
      w.payer_id IS DISTINCT FROM u.parent_id
      OR (((w.amount_usd-w.team_amount_usd)>0) IS DISTINCT FROM EXISTS(SELECT 1 FROM ledger l WHERE l.kind='withdrawal_hold'
        AND l.reference_id=w.id AND l.user_id=w.user_id AND l.amount_usd=-(w.amount_usd-w.team_amount_usd)))
      OR ((w.state='rejected' AND (w.amount_usd-w.team_amount_usd)>0) IS DISTINCT FROM EXISTS(SELECT 1 FROM ledger l
        WHERE l.kind='withdrawal_release' AND l.reference_id=w.id AND l.user_id=w.user_id AND l.amount_usd=w.amount_usd-w.team_amount_usd))
      OR ((w.team_amount_usd>0) IS DISTINCT FROM EXISTS(SELECT 1 FROM team_fund_ledger t WHERE t.kind='withdrawal_hold'
        AND t.reference_id=w.id AND t.user_id=w.user_id AND t.amount_usd=-w.team_amount_usd))
      OR ((w.state='rejected' AND w.team_amount_usd>0) IS DISTINCT FROM EXISTS(SELECT 1 FROM team_fund_ledger t
        WHERE t.kind='withdrawal_release' AND t.reference_id=w.id AND t.user_id=w.user_id AND t.amount_usd=w.team_amount_usd)))

    UNION ALL
    SELECT t.id FROM team_fund_ledger t LEFT JOIN invoices i ON i.id=t.reference_id
      LEFT JOIN withdrawals w ON w.id=t.reference_id LEFT JOIN settlement_adjustments sa ON sa.id=t.reference_id WHERE t.user_id=$1 AND (
      (t.kind='funding' AND (i.id IS NULL OR i.user_id<>t.user_id OR i.state<>'confirmed' OR i.downstream_usd<>t.amount_usd OR t.amount_usd<=0))
      OR (t.kind='funding_adjustment' AND (sa.id IS NULL OR sa.user_id<>t.user_id OR sa.downstream_usd<>t.amount_usd OR t.amount_usd>=0))
      OR (t.kind='withdrawal_hold' AND (w.id IS NULL OR w.user_id<>t.user_id OR w.team_amount_usd<=0 OR t.amount_usd<>-w.team_amount_usd))
      OR (t.kind='withdrawal_release' AND (w.id IS NULL OR w.user_id<>t.user_id OR w.state<>'rejected' OR t.amount_usd<>w.team_amount_usd)))

    UNION ALL
    SELECT i.id FROM invoices i WHERE i.user_id=$1 AND i.state='confirmed' AND i.downstream_usd>0
      AND NOT EXISTS(SELECT 1 FROM team_fund_ledger t WHERE t.kind='funding' AND t.reference_id=i.id
        AND t.user_id=i.user_id AND t.amount_usd=i.downstream_usd)

    UNION ALL
    SELECT e.id FROM task_settlement_entries e WHERE e.user_id=$1
      AND NOT EXISTS(SELECT 1 FROM ledger l WHERE l.kind=e.kind AND l.reference_id=e.id AND l.user_id=e.user_id AND l.amount_usd=e.profit_usd)

    UNION ALL
    SELECT a.id FROM settlement_adjustments a LEFT JOIN invoices ai ON ai.id=a.invoice_id WHERE a.user_id=$1 AND (
      ai.id IS NULL OR ai.user_id<>a.user_id OR ai.state<>'confirmed'
      OR (a.gross_usd,a.downstream_usd,a.profit_usd) IS DISTINCT FROM (
        SELECT ROW(-COALESCE(sum(e.gross_usd),0),-COALESCE(sum(e.downstream_usd),0),-COALESCE(sum(e.profit_usd),0))
        FROM invoice_items x JOIN earnings e ON e.id=x.earning_id WHERE x.invoice_id=a.invoice_id
          AND e.usage_id IN (SELECT jsonb_array_elements_text(CASE
            WHEN jsonb_typeof(a.evidence->'usageIds')='array' THEN a.evidence->'usageIds' ELSE '[]'::jsonb END)))
      OR
      (a.profit_usd<>0 AND NOT EXISTS(SELECT 1 FROM ledger l WHERE l.kind='settlement_adjustment' AND l.reference_id=a.id
        AND l.user_id=a.user_id AND l.amount_usd=a.profit_usd))
      OR (a.downstream_usd<0 AND NOT EXISTS(SELECT 1 FROM team_fund_ledger t WHERE t.kind='funding_adjustment'
        AND t.reference_id=a.id AND t.user_id=a.user_id AND t.amount_usd=a.downstream_usd)))
  ) problems LIMIT 1`, [userId]);
  if (invalid) walletConflict();
  const usages = await db.query(`SELECT DISTINCT e.usage_id FROM ledger l JOIN invoices i ON i.id=l.reference_id
    JOIN invoice_items x ON x.invoice_id=i.id JOIN earnings e ON e.id=x.earning_id WHERE l.user_id=$1 AND l.kind='settlement'`, [userId]);
  await assertUsageAccounting(db, usages.map(row => row.usage_id));
  await assertFundingAccounting(db, usages.map(row => row.usage_id), userId);
  await assertTaskSettlementAccounting(db, userId);
}
