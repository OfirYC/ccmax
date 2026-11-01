import type { DB } from './db.js';

export async function invoiceRepairMigration(tx: DB) {
  await tx.query(`CREATE TABLE invoice_repair_policy (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    enabled boolean NOT NULL DEFAULT false,
    updated_by text REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await tx.query('INSERT INTO invoice_repair_policy(singleton) VALUES(true)');
  // Fresh installations can skip the fingerprint-specific migration-27 repair;
  // give every database the same protection for voided historical invoices.
  await tx.query(`CREATE OR REPLACE FUNCTION ccmax_guard_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CCMAX: invoices cannot be deleted' USING ERRCODE='23514'; END IF;
      IF OLD.state<>'pending' OR (NEW.id,NEW.user_id,NEW.payer_id,NEW.gross_usd,NEW.downstream_usd,NEW.profit_usd,NEW.date_from,NEW.date_to)
        IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.payer_id,OLD.gross_usd,OLD.downstream_usd,OLD.profit_usd,OLD.date_from,OLD.date_to) THEN
        RAISE EXCEPTION 'CCMAX: invoice amount and processed records are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query(`CREATE TABLE invoice_repairs (
    id text PRIMARY KEY,
    invoice_id text NOT NULL UNIQUE REFERENCES invoices(id),
    replacement_id text UNIQUE REFERENCES invoices(id),
    discarded_usage_ids text[] NOT NULL CHECK(cardinality(discarded_usage_ids)>0),
    created_by text NOT NULL REFERENCES users(id),
    reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
    preview_token text NOT NULL CHECK(preview_token ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK(replacement_id IS DISTINCT FROM invoice_id)
  )`);
  await tx.query(`CREATE TRIGGER invoice_repairs_append_only BEFORE UPDATE OR DELETE ON invoice_repairs
    FOR EACH ROW EXECUTE FUNCTION ccmax_reject_change()`);
  // Validate the complete removal set and replacement before granting the
  // narrowly scoped right to move legitimate items. No runtime DDL is needed.
  await tx.query(`CREATE FUNCTION ccmax_guard_invoice_repair() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE original invoices%ROWTYPE; replacement invoices%ROWTYPE; conflicts text[];
      kept_count integer; kept_gross numeric; kept_downstream numeric; kept_profit numeric;
    BEGIN
      SELECT * INTO original FROM invoices WHERE id=NEW.invoice_id FOR UPDATE;
      SELECT array_agg(u.id ORDER BY u.id) INTO conflicts FROM invoice_items x
        JOIN earnings e ON e.id=x.earning_id JOIN usage_days u ON u.id=e.usage_id
        JOIN usage_days p ON p.binding_id=u.binding_id AND p.day=(u.day-interval '1 day')::date AND p.raw_usd=u.raw_usd
        WHERE x.invoice_id=NEW.invoice_id AND u.source='daily_snapshot' AND u.raw_usd>0
          AND p.source IN ('live_snapshot','daily_snapshot');
      IF original.id IS NULL OR original.state<>'pending' OR conflicts IS NULL
        OR NEW.discarded_usage_ids IS DISTINCT FROM conflicts
        OR NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.created_by AND role='owner' AND active) THEN
        RAISE EXCEPTION 'CCMAX: invoice repair source mismatch' USING ERRCODE='23514';
      END IF;
      SELECT count(*),COALESCE(sum(e.gross_usd),0),COALESCE(sum(e.downstream_usd),0),COALESCE(sum(e.profit_usd),0)
        INTO kept_count,kept_gross,kept_downstream,kept_profit FROM invoice_items x JOIN earnings e ON e.id=x.earning_id
        WHERE x.invoice_id=original.id AND NOT(e.usage_id=ANY(conflicts));
      IF kept_count=0 THEN
        IF NEW.replacement_id IS NOT NULL THEN RAISE EXCEPTION 'CCMAX: empty invoice replacement' USING ERRCODE='23514'; END IF;
      ELSE
        SELECT * INTO replacement FROM invoices WHERE id=NEW.replacement_id FOR UPDATE;
        IF replacement.id IS NULL OR replacement.state<>'pending'
          OR (replacement.user_id,replacement.payer_id,replacement.date_from,replacement.date_to,replacement.automatic)
            IS DISTINCT FROM (original.user_id,original.payer_id,original.date_from,original.date_to,original.automatic)
          OR (replacement.gross_usd,replacement.downstream_usd,replacement.profit_usd)
            IS DISTINCT FROM (kept_gross,kept_downstream,kept_profit)
          OR EXISTS(SELECT 1 FROM invoice_items WHERE invoice_id=replacement.id) THEN
          RAISE EXCEPTION 'CCMAX: invoice replacement source mismatch' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query(`CREATE TRIGGER invoice_repair_source BEFORE INSERT ON invoice_repairs
    FOR EACH ROW EXECUTE FUNCTION ccmax_guard_invoice_repair()`);
  await tx.query(`CREATE FUNCTION ccmax_guard_invoice_item_move() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CCMAX: append-only record' USING ERRCODE='23514'; END IF;
      IF NEW.earning_id<>OLD.earning_id OR NOT EXISTS(
        SELECT 1 FROM invoice_repairs r JOIN invoices old_bill ON old_bill.id=r.invoice_id
        JOIN invoices new_bill ON new_bill.id=r.replacement_id JOIN earnings e ON e.id=OLD.earning_id
        WHERE r.invoice_id=OLD.invoice_id AND r.replacement_id=NEW.invoice_id
          AND old_bill.state='voided' AND new_bill.state='pending'
          AND NOT(e.usage_id=ANY(r.discarded_usage_ids))) THEN
        RAISE EXCEPTION 'CCMAX: append-only record' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query('DROP TRIGGER invoice_items_append_only ON invoice_items');
  await tx.query(`CREATE TRIGGER invoice_items_append_only BEFORE UPDATE OR DELETE ON invoice_items
    FOR EACH ROW EXECUTE FUNCTION ccmax_guard_invoice_item_move()`);
  // Incomplete repairs roll back at COMMIT, even if a future caller forgets
  // to void the original or move all legitimate items.
  await tx.query(`CREATE FUNCTION ccmax_check_invoice_repair() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE original invoices%ROWTYPE; remaining_ids text[]; total_gross numeric; total_downstream numeric; total_profit numeric;
    BEGIN
      SELECT * INTO original FROM invoices WHERE id=NEW.invoice_id;
      SELECT array_agg(e.usage_id ORDER BY e.usage_id) INTO remaining_ids FROM invoice_items x
        JOIN earnings e ON e.id=x.earning_id WHERE x.invoice_id=NEW.invoice_id;
      SELECT sum(e.gross_usd),sum(e.downstream_usd),sum(e.profit_usd) INTO total_gross,total_downstream,total_profit
        FROM invoice_items x JOIN earnings e ON e.id=x.earning_id
        WHERE x.invoice_id=NEW.invoice_id OR x.invoice_id=NEW.replacement_id;
      IF original.state<>'voided' OR remaining_ids IS DISTINCT FROM NEW.discarded_usage_ids
        OR (original.gross_usd,original.downstream_usd,original.profit_usd)
          IS DISTINCT FROM (total_gross,total_downstream,total_profit) THEN
        RAISE EXCEPTION 'CCMAX: incomplete invoice repair' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query(`CREATE CONSTRAINT TRIGGER invoice_repair_complete AFTER INSERT ON invoice_repairs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ccmax_check_invoice_repair()`);
}
