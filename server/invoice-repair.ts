import { createHash } from 'node:crypto';
import type { DB, Row } from './db.js';
import { AppError, assert, audit, dayString, id, requireOwner, sum, today, usd } from './core.js';
import { assertInvoiceAccounting } from './financial-integrity.js';
import { repeatedInvoiceSnapshots } from './invoice-snapshot-conflicts.js';

const totals = (items: Row[]) => ({
  count: items.length,
  gross_usd: usd(sum(items.map(item => item.gross_usd))),
  downstream_usd: usd(sum(items.map(item => item.downstream_usd))),
  profit_usd: usd(sum(items.map(item => item.profit_usd))),
});

async function preview(tx: DB, invoice: Row, lockPrevious = false) {
  assert(invoice.state === 'pending', '只能修复待处理账单', 409);
  await assertInvoiceAccounting(tx, invoice);
  const conflicts = await repeatedInvoiceSnapshots(tx, invoice.id, lockPrevious);
  assert(conflicts.length, '此账单没有可移除的重复快照', 409);
  const items = await tx.query(`SELECT e.* FROM invoice_items x JOIN earnings e ON e.id=x.earning_id
    WHERE x.invoice_id=$1 ORDER BY e.id`, [invoice.id]);
  const removedIds = new Set(conflicts.map(item => item.earning_id));
  const kept = items.filter(item => !removedIds.has(item.id));
  const previewToken = createHash('sha256').update(JSON.stringify([invoice.id, items, conflicts])).digest('hex');
  return {
    invoiceId: invoice.id, number: invoice.number, previewToken,
    original: totals(items), removed: totals(conflicts), remaining: totals(kept),
    items: conflicts.map(({ previous_id, previous_source, earning_id, ...item }) => ({
      ...item, day: dayString(item.day), previous_day: dayString(item.previous_day),
    })),
    discardedUsageIds: conflicts.map(item => item.usage_id), kept,
  };
}

export async function previewInvoiceRepair(db: DB, actor: Row, invoiceId: string) {
  await requireOwner(actor);
  return db.transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const [invoice] = await tx.query('SELECT * FROM invoices WHERE id=$1', [invoiceId]);
    assert(invoice, '账单不存在', 404);
    const { discardedUsageIds, kept, ...result } = await preview(tx, invoice);
    return result;
  });
}

export async function repairInvoice(db: DB, actor: Row, invoiceId: string, previewToken: string, reason: string) {
  await requireOwner(actor);
  assert(reason.trim().length >= 3 && reason.trim().length <= 500, '请填写 3–500 字的修复说明');
  return db.transaction(async tx => {
    const result = await repairInTransaction(tx, actor, invoiceId, previewToken, reason);
    assert(result, '此账单没有可移除的重复快照', 409);
    return result;
  });
}

async function repairInTransaction(tx: DB, actor: Row, invoiceId: string, previewToken: string | undefined, reason: string, automatic = false) {
  const [invoice] = await tx.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [invoiceId]);
  assert(invoice, '账单不存在', 404);
  if (automatic && (invoice.state !== 'pending' || !(await repeatedInvoiceSnapshots(tx, invoiceId)).length)) return null;
  const [existing] = await tx.query('SELECT * FROM invoice_repairs WHERE invoice_id=$1', [invoiceId]);
  if (existing) {
    assert(existing.preview_token === previewToken, '此账单已修复，请刷新账单列表', 409);
    const [replacement] = existing.replacement_id ? await tx.query('SELECT * FROM invoices WHERE id=$1', [existing.replacement_id]) : [];
    return { invoiceId, replacement: replacement ?? null, alreadyRepaired: true };
  }
  const result = await preview(tx, invoice, true);
  assert(automatic || result.previewToken === previewToken, '重复明细已变化，请重新预览后确认', 409);
  previewToken = result.previewToken;
  await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [invoice.user_id]);
  let replacement: Row | null = null;
  if (result.kept.length) {
    const replacementId = id();
    const [estimated] = await tx.query(`SELECT EXISTS(SELECT 1 FROM usage_days
      WHERE id=ANY($1::text[]) AND source='daily_snapshot') AS value`, [result.kept.map(item => item.usage_id)]);
    [replacement] = await tx.query(`INSERT INTO invoices(id,number,user_id,payer_id,date_from,date_to,gross_usd,
      downstream_usd,profit_usd,created_by,automatic,estimated,reference)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [replacementId, `CC-${today().replaceAll('-', '')}-${replacementId.slice(0,8).toUpperCase()}`,
      invoice.user_id, invoice.payer_id, invoice.date_from, invoice.date_to,
      result.remaining.gross_usd, result.remaining.downstream_usd, result.remaining.profit_usd,
      actor.id, invoice.automatic, estimated.value, `修复自 ${invoice.number}`]);
  }
  const repairId = id();
  await tx.query(`INSERT INTO invoice_repairs(id,invoice_id,replacement_id,discarded_usage_ids,created_by,reason,preview_token)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [repairId, invoiceId, replacement?.id ?? null, result.discardedUsageIds, actor.id, reason.trim(), previewToken]);
  await tx.query("UPDATE invoices SET state='voided',reference=$2 WHERE id=$1", [invoiceId, reason.trim()]);
  if (replacement) {
    await tx.query('UPDATE invoice_items SET invoice_id=$2 WHERE earning_id=ANY($1::text[])', [result.kept.map(item => item.id), replacement.id]);
    await assertInvoiceAccounting(tx, replacement);
  }
  await audit(tx, actor.id, 'invoice.repair_duplicates', invoiceId, {
    repairId, automatic, reason: reason.trim(), replacementId: replacement?.id ?? null,
    discardedUsageIds: result.discardedUsageIds, removed: result.removed, remaining: result.remaining,
  });
  return { invoiceId, replacement, alreadyRepaired: false };
}

export async function invoiceRepairPolicy(db: DB) {
  const [policy] = await db.query('SELECT enabled,updated_by,updated_at FROM invoice_repair_policy WHERE singleton=true');
  return policy;
}

export async function setInvoiceRepairPolicy(db: DB, actor: Row, enabled: boolean) {
  await requireOwner(actor);
  await db.transaction(async tx => {
    const [previous] = await tx.query('SELECT enabled FROM invoice_repair_policy WHERE singleton=true FOR UPDATE');
    if (previous.enabled === enabled) return;
    await tx.query('UPDATE invoice_repair_policy SET enabled=$1,updated_by=$2,updated_at=now() WHERE singleton=true', [enabled, actor.id]);
    await audit(tx, actor.id, 'invoice.repair_policy', undefined, { enabled });
  });
  return invoiceRepairPolicy(db);
}

// The persisted opt-in authorizes background removal, never confirmation or
// crediting. Lock the setting for each repair so disabling stops the next one.
export async function autoRepairInvoices(db: DB) {
  const result = { repaired: 0, issues: [] as { invoiceId: string; message: string }[] };
  if (!(await invoiceRepairPolicy(db)).enabled) return result;
  const [owner] = await db.query("SELECT * FROM users WHERE role='owner' AND active=true");
  if (!owner) return result;
  const candidates = await db.query(`SELECT i.id FROM invoices i WHERE i.state='pending' AND EXISTS(
    SELECT 1 FROM invoice_items x JOIN earnings e ON e.id=x.earning_id JOIN usage_days u ON u.id=e.usage_id
    JOIN usage_days p ON p.binding_id=u.binding_id AND p.day=(u.day-interval '1 day')::date AND p.raw_usd=u.raw_usd
    WHERE x.invoice_id=i.id AND u.source='daily_snapshot' AND u.raw_usd>0 AND p.source IN ('live_snapshot','daily_snapshot'))
    ORDER BY i.created_at,i.id LIMIT 100`);
  for (const candidate of candidates) {
    try {
      const repaired = await db.transaction(async tx => {
        const [policy] = await tx.query('SELECT enabled FROM invoice_repair_policy WHERE singleton=true FOR SHARE');
        if (!policy.enabled) return null;
        return repairInTransaction(tx, owner, candidate.id, undefined, '自动修复：按管理员设置移除重复快照', true);
      });
      if (repaired && !repaired.alreadyRepaired) result.repaired++;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      result.issues.push({ invoiceId: candidate.id, message: error.message });
    }
  }
  return result;
}
