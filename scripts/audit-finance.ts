import 'dotenv/config';
import { openDB } from '../server/db.js';
import { AppError } from '../server/core.js';
import { assertInvoiceAccounting, assertUsageAccounting, assertWalletAccounting } from '../server/financial-integrity.js';

// Explicit PostgreSQL target; no migrations, bootstrap, price corrections,
// status transitions, credentials or external transfers occur in this audit.
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the PostgreSQL database to reconcile. This command runs a read-only audit.');
const db = await openDB(process.env.DATABASE_URL);
try {
  const report = await db.transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const findings: { entity: string; ids: string[]; code: string; message: string }[] = [];
    async function check(entity: string, ids: string[], action: () => Promise<void>) {
      try { await action(); }
      catch (error) {
        if (!(error instanceof AppError)) throw error;
        findings.push({ entity, ids, code: error.code || 'ACCOUNTING_CONFLICT', message: error.message });
      }
    }
    const users = await tx.query('SELECT id FROM users ORDER BY id');
    for (const user of users) await check('wallet', [user.id], () => assertWalletAccounting(tx, user.id));
    const pending = await tx.query("SELECT * FROM invoices WHERE state='pending' ORDER BY id");
    for (const invoice of pending) await check('invoice', [invoice.id], () => assertInvoiceAccounting(tx, invoice));
    const usages = await tx.query("SELECT id FROM usage_days WHERE state='final' ORDER BY id");
    for (let start = 0; start < usages.length; start += 1000) {
      const ids = usages.slice(start, start + 1000).map(row => row.id);
      await check('usage_batch', ids, () => assertUsageAccounting(tx, ids));
    }
    const [totals] = await tx.query(`SELECT
      (SELECT COALESCE(sum(amount_usd),0) FROM ledger) AS available_profit_usd,
      (SELECT COALESCE(sum(amount_usd),0) FROM withdrawals WHERE state='pending') AS pending_withdrawal_usd`);
    return { ok: findings.length === 0, checkedAt: new Date().toISOString(), checked: { wallets: users.length, pendingInvoices: pending.length, finalizedUsageDays: usages.length }, totals, findings };
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally { await db.close(); }
