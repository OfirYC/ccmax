import 'dotenv/config';
import { openDB } from '../server/db.js';
import { auditFinance } from '../server/finance-audit.js';

// Explicit PostgreSQL target; no migrations, bootstrap, price corrections,
// status transitions, credentials or external transfers occur in this audit.
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the PostgreSQL database to reconcile. This command runs a read-only audit.');
const db = await openDB(process.env.DATABASE_URL);
try {
  const report = await db.transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return auditFinance(tx);
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally { await db.close(); }
