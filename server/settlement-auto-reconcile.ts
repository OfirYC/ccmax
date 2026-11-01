import Decimal from 'decimal.js';
import type { DB, Row } from './db.js';
import { assert, audit, id, sum, usd } from './core.js';
import { confirmInvoiceInTransaction, ingestUsage } from './billing.js';
import { assertInvoiceAccounting, assertUsageAccounting, assertWalletAccounting } from './financial-integrity.js';

const JADEN='1cf8308f-6e34-4aa8-acd7-b45a9c9cf6f5';
const THANA='5f4dc270-335a-450f-a74f-8a33b1ad1f24';
const REFERENCE='automatic settlement reconciliation 2026-10-31';
const TARGETS=[
  {id:'72761ba0-b790-42cc-a7fd-21a8fb1dc44e',email:'dev3@sartel.ai',provider:'maxchat',day:'2026-10-29',raw:'204.63112100',profit:'40.92622420'},
  {id:'94cbbdea-38d1-46f2-8060-0f7a78348843',email:'dev3@sartel.ai',provider:'gatelink',day:'2026-10-29',raw:'115.39451800',profit:'33.46441022'},
  {id:'084662bf-95ff-47ce-a237-a55b33dad310',email:'dev4@sartel.ai',provider:'gatelink',day:'2026-10-29',raw:'130.55072400',profit:'37.85970996'},
  {id:'75d101df-832b-4f34-940b-112bd8c1739a',email:'dev4@sartel.ai',provider:'maxchat',day:'2026-10-29',raw:'60.16712520',profit:'12.03342504'},
  {id:'66d3eb3e-54b7-4719-a726-967f82f3c147',email:'junior3@sartel.ai',provider:'maxchat',day:'2026-10-29',raw:'5.51848000',profit:'1.10369600'},
  {id:'dcd5dfed-8cf2-4493-aacc-8534fa570509',email:'rhinasofi@hotmail.com',provider:'gatelink',day:'2026-10-31',raw:'115.54776200',profit:'33.50885098'},
] as const;
const REPEATED_SNAPSHOTS=[
  {id:'3391fced-4c58-4966-8eea-b1bc3bdf8f31',email:'talia0205lyt@gmail.com',day:'2026-10-29',raw:'706.24945800'},
  {id:'bf65cd68-1994-4fe0-8d43-ffa1ef8bbbde',email:'talia0205lyt@gmail.com',day:'2026-10-30',raw:'706.24945800'},
  {id:'c74cf186-7e43-4759-a4a5-69095d28efdb',email:'tongwu.de@gmail.com',day:'2026-10-30',raw:'22.15704600'},
  {id:'9ef08a4c-a9be-43bb-abb9-2cedff3ce12f',email:'talia0205lyt@gmail.com',day:'2026-10-31',raw:'706.24945800'},
  {id:'2f7a01c3-03f5-41df-af73-7b1ce45d0239',email:'tongwu.de@gmail.com',day:'2026-10-31',raw:'22.15704600'},
] as const;

async function adjustmentSchema(tx:DB) {
  await tx.query('ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_state_check');
  await tx.query("ALTER TABLE invoices ADD CONSTRAINT invoices_state_check CHECK(state IN ('pending','confirmed','voided'))");
  await tx.query(`CREATE TABLE IF NOT EXISTS settlement_adjustments(
    id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),invoice_id text NOT NULL UNIQUE REFERENCES invoices(id),
    gross_usd numeric(24,8) NOT NULL,downstream_usd numeric(24,8) NOT NULL,profit_usd numeric(24,8) NOT NULL,
    reason text NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
    CHECK(gross_usd<0 AND downstream_usd<=0 AND profit_usd=gross_usd-downstream_usd))`);
  await tx.query('DROP TRIGGER IF EXISTS settlement_adjustments_append_only ON settlement_adjustments');
  await tx.query(`CREATE TRIGGER settlement_adjustments_append_only BEFORE UPDATE OR DELETE ON settlement_adjustments
    FOR EACH ROW EXECUTE FUNCTION ccmax_reject_change()`);
  await tx.query(`CREATE OR REPLACE FUNCTION ccmax_guard_settlement_adjustment_source() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE bill invoices%ROWTYPE; reversed record;
    BEGIN
      SELECT * INTO bill FROM invoices WHERE id=NEW.invoice_id;
      IF NOT FOUND OR bill.state<>'confirmed' OR bill.user_id<>NEW.user_id
        OR jsonb_typeof(NEW.evidence->'usageIds') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'CCMAX: settlement adjustment source mismatch' USING ERRCODE='23514';
      END IF;
      SELECT -COALESCE(sum(e.gross_usd),0) AS gross,-COALESCE(sum(e.downstream_usd),0) AS downstream,
        -COALESCE(sum(e.profit_usd),0) AS profit INTO reversed
        FROM invoice_items x JOIN earnings e ON e.id=x.earning_id WHERE x.invoice_id=bill.id
        AND e.usage_id IN (SELECT jsonb_array_elements_text(NEW.evidence->'usageIds'));
      IF (NEW.gross_usd,NEW.downstream_usd,NEW.profit_usd)
        IS DISTINCT FROM (reversed.gross,reversed.downstream,reversed.profit) THEN
        RAISE EXCEPTION 'CCMAX: settlement adjustment source mismatch' USING ERRCODE='23514';
      END IF; RETURN NEW;
    END $$`);
  await tx.query('DROP TRIGGER IF EXISTS settlement_adjustments_source ON settlement_adjustments');
  await tx.query(`CREATE TRIGGER settlement_adjustments_source BEFORE INSERT ON settlement_adjustments
    FOR EACH ROW EXECUTE FUNCTION ccmax_guard_settlement_adjustment_source()`);
  await tx.query('ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_kind_check');
  await tx.query("ALTER TABLE ledger ADD CONSTRAINT ledger_kind_check CHECK(kind IN ('settlement','settlement_adjustment','task_settlement','task_adjustment','withdrawal_hold','withdrawal_release'))");
  await tx.query('ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_direction');
  await tx.query(`ALTER TABLE ledger ADD CONSTRAINT ledger_direction CHECK(
    kind IN ('settlement','settlement_adjustment','task_settlement','task_adjustment') OR
    (kind='withdrawal_hold' AND amount_usd<0) OR (kind='withdrawal_release' AND amount_usd>0))`);
  await tx.query('ALTER TABLE team_fund_ledger DROP CONSTRAINT IF EXISTS team_fund_ledger_kind_check');
  await tx.query("ALTER TABLE team_fund_ledger ADD CONSTRAINT team_fund_ledger_kind_check CHECK(kind IN ('funding','funding_adjustment','withdrawal_hold','withdrawal_release'))");
  await tx.query('DROP TRIGGER IF EXISTS ledger_source ON ledger');
  await tx.query(`CREATE OR REPLACE FUNCTION ccmax_guard_ledger_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind='settlement' THEN
        IF NOT EXISTS(SELECT 1 FROM invoices i WHERE i.id=NEW.reference_id AND i.user_id=NEW.user_id
          AND i.state='confirmed' AND i.profit_usd=NEW.amount_usd) THEN RAISE EXCEPTION 'CCMAX: settlement ledger source mismatch' USING ERRCODE='23514'; END IF;
      ELSIF NEW.kind='settlement_adjustment' THEN
        IF NOT EXISTS(SELECT 1 FROM settlement_adjustments a WHERE a.id=NEW.reference_id AND a.user_id=NEW.user_id
          AND a.profit_usd=NEW.amount_usd) THEN RAISE EXCEPTION 'CCMAX: settlement adjustment source mismatch' USING ERRCODE='23514'; END IF;
      ELSIF NEW.kind IN ('task_settlement','task_adjustment') THEN
        IF NOT EXISTS(SELECT 1 FROM task_settlement_entries e WHERE e.id=NEW.reference_id AND e.user_id=NEW.user_id
          AND e.kind=NEW.kind AND e.profit_usd=NEW.amount_usd) THEN RAISE EXCEPTION 'CCMAX: task settlement ledger source mismatch' USING ERRCODE='23514'; END IF;
      ELSIF NEW.kind='withdrawal_hold' THEN
        IF NOT EXISTS(SELECT 1 FROM withdrawals w WHERE w.id=NEW.reference_id AND w.user_id=NEW.user_id
          AND w.amount_usd>w.team_amount_usd AND w.state='pending' AND -(w.amount_usd-w.team_amount_usd)=NEW.amount_usd)
          THEN RAISE EXCEPTION 'CCMAX: withdrawal hold source mismatch' USING ERRCODE='23514'; END IF;
      ELSIF NEW.kind='withdrawal_release' THEN
        IF NOT EXISTS(SELECT 1 FROM withdrawals w JOIN ledger h ON h.reference_id=w.id AND h.kind='withdrawal_hold'
          WHERE w.id=NEW.reference_id AND w.user_id=NEW.user_id AND w.state='rejected'
          AND w.amount_usd-w.team_amount_usd=NEW.amount_usd AND h.user_id=w.user_id AND h.amount_usd=-(w.amount_usd-w.team_amount_usd))
          THEN RAISE EXCEPTION 'CCMAX: withdrawal release source mismatch' USING ERRCODE='23514'; END IF;
      END IF; RETURN NEW;
    END $$`);
  await tx.query('CREATE TRIGGER ledger_source BEFORE INSERT ON ledger FOR EACH ROW EXECUTE FUNCTION ccmax_guard_ledger_source()');
  await tx.query('DROP TRIGGER IF EXISTS team_fund_source ON team_fund_ledger');
  await tx.query(`CREATE OR REPLACE FUNCTION ccmax_guard_team_fund_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind='funding' THEN
        IF NOT EXISTS(SELECT 1 FROM invoices i WHERE i.id=NEW.reference_id AND i.user_id=NEW.user_id
          AND i.state='confirmed' AND i.downstream_usd=NEW.amount_usd AND NEW.amount_usd>0)
          THEN RAISE EXCEPTION 'CCMAX: team funding source mismatch' USING ERRCODE='23514'; END IF;
      ELSIF NEW.kind='funding_adjustment' THEN
        IF NOT EXISTS(SELECT 1 FROM settlement_adjustments a WHERE a.id=NEW.reference_id AND a.user_id=NEW.user_id
          AND a.downstream_usd=NEW.amount_usd AND NEW.amount_usd<0)
          THEN RAISE EXCEPTION 'CCMAX: team funding adjustment source mismatch' USING ERRCODE='23514'; END IF;
      ELSIF NEW.kind='withdrawal_hold' THEN
        IF NOT EXISTS(SELECT 1 FROM withdrawals w WHERE w.id=NEW.reference_id AND w.user_id=NEW.user_id
          AND w.state='pending' AND w.team_amount_usd>0 AND -w.team_amount_usd=NEW.amount_usd)
          THEN RAISE EXCEPTION 'CCMAX: team funding hold source mismatch' USING ERRCODE='23514'; END IF;
      ELSIF NEW.kind='withdrawal_release' THEN
        IF NOT EXISTS(SELECT 1 FROM withdrawals w JOIN team_fund_ledger h ON h.reference_id=w.id AND h.kind='withdrawal_hold'
          WHERE w.id=NEW.reference_id AND w.user_id=NEW.user_id AND w.state='rejected' AND w.team_amount_usd=NEW.amount_usd
          AND h.user_id=w.user_id AND h.amount_usd=-w.team_amount_usd)
          THEN RAISE EXCEPTION 'CCMAX: team funding release source mismatch' USING ERRCODE='23514'; END IF;
      END IF; RETURN NEW;
    END $$`);
  await tx.query('CREATE TRIGGER team_fund_source BEFORE INSERT ON team_fund_ledger FOR EACH ROW EXECUTE FUNCTION ccmax_guard_team_fund_source()');
}

async function reconcileRepeatedSnapshots(tx:DB,actor:Row) {
  const usageIds=REPEATED_SNAPSHOTS.map(target=>target.id);
  const rows=await tx.query(`SELECT u.id,u.day,u.raw_usd,u.state,u.source,a.email,a.owner_id,c.provider
    FROM usage_days u JOIN bindings b ON b.id=u.binding_id JOIN accounts a ON a.id=b.account_id
    JOIN connections c ON c.id=b.connection_id WHERE u.id=ANY($1::text[]) FOR UPDATE OF u`,[usageIds]);
  assert(rows.length===usageIds.length,'CCMAX repeated snapshot reconciliation fingerprint mismatch',409);
  for(const target of REPEATED_SNAPSHOTS) {
    const row=rows.find(candidate=>candidate.id===target.id);
    assert(row&&row.day===target.day&&row.email===target.email&&row.owner_id===THANA&&row.provider==='gatelink'
      &&row.state==='final'&&row.source==='daily_snapshot'&&new Decimal(row.raw_usd).eq(target.raw),
    'CCMAX repeated snapshot reconciliation fingerprint mismatch',409);
  }
  const affected=await tx.query(`SELECT i.*,u.role AS user_role FROM invoices i JOIN users u ON u.id=i.user_id WHERE i.id IN (
    SELECT x.invoice_id FROM invoice_items x JOIN earnings e ON e.id=x.earning_id WHERE e.usage_id=ANY($1::text[])
  ) ORDER BY i.id FOR UPDATE`,[usageIds]);
  assert(affected.length===9&&affected.filter(invoice=>invoice.state==='confirmed').length===4
    &&affected.filter(invoice=>invoice.state==='pending').length===5,
  'CCMAX repeated snapshot reconciliation invoice mismatch',409);
  const expected=[
    {user:JADEN,day:'2026-10-29',gross:'293.23151060',downstream:'131.11317072',profit:'162.11833988',state:'confirmed'},
    {user:THANA,day:'2026-10-29',gross:'131.11317072',downstream:'0',profit:'131.11317072',state:'pending'},
    {user:JADEN,day:'2026-10-30',gross:'540.05760110',downstream:'131.11317072',profit:'408.94443038',state:'confirmed'},
    {user:THANA,day:'2026-10-30',gross:'131.11317072',downstream:'0',profit:'131.11317072',state:'pending'},
    {user:JADEN,day:'2026-10-31',gross:'1402.39580632',downstream:'131.11317072',profit:'1271.28263560',state:'pending'},
    {user:THANA,day:'2026-10-31',gross:'131.11317072',downstream:'0',profit:'131.11317072',state:'pending'},
  ];
  for(const fingerprint of expected) {
    const invoice=affected.find(candidate=>candidate.user_id===fingerprint.user&&candidate.date_from===fingerprint.day&&candidate.date_to===fingerprint.day
      &&candidate.state===fingerprint.state&&new Decimal(candidate.gross_usd).eq(fingerprint.gross));
    assert(invoice&&new Decimal(invoice.downstream_usd).eq(fingerprint.downstream)&&new Decimal(invoice.profit_usd).eq(fingerprint.profit)
      &&invoice.automatic&&invoice.estimated,`CCMAX repeated snapshot reconciliation invoice fingerprint mismatch (${fingerprint.user} ${fingerprint.day}; ${JSON.stringify(affected.filter(candidate=>candidate.user_id===fingerprint.user&&candidate.date_from===fingerprint.day).map(candidate=>({gross:candidate.gross_usd,downstream:candidate.downstream_usd,profit:candidate.profit_usd,state:candidate.state,automatic:candidate.automatic,estimated:candidate.estimated})))})`,409);
  }
  const rootInvoices=affected.filter(invoice=>invoice.user_role==='owner');
  assert(rootInvoices.length===3&&rootInvoices.every(invoice=>!invoice.payer_id&&invoice.automatic&&invoice.estimated)
    &&rootInvoices.filter(invoice=>invoice.state==='confirmed').length===2&&rootInvoices.filter(invoice=>invoice.state==='pending').length===1,
  'CCMAX repeated snapshot reconciliation root invoice mismatch',409);
  for(const invoice of affected)await assertInvoiceAccounting(tx,invoice);
  await assertWalletAccounting(tx,actor.id);
  await assertWalletAccounting(tx,JADEN);
  const [preflight]=await tx.query(`SELECT
    (SELECT COALESCE(sum(gross_usd),0) FROM invoices WHERE payer_id=$1 AND state='pending') AS team_due,
    (SELECT COALESCE(sum(profit_usd),0) FROM invoices WHERE user_id=$1 AND state='pending') AS pending_profit`,[JADEN]);
  assert(new Decimal(preflight.team_due).eq('406.06890966')&&new Decimal(preflight.pending_profit).eq('1271.28263560'),
    'CCMAX repeated snapshot reconciliation balance fingerprint mismatch',409);

  for(const invoice of affected.filter(candidate=>candidate.state==='confirmed')) {
    const [amounts]=await tx.query(`SELECT sum(e.gross_usd) AS gross,sum(e.downstream_usd) AS downstream,sum(e.profit_usd) AS profit
      FROM invoice_items x JOIN earnings e ON e.id=x.earning_id
      WHERE x.invoice_id=$1 AND e.usage_id=ANY($2::text[])`,[invoice.id,usageIds]);
    const adjustmentId=id(),gross=usd(new Decimal(amounts.gross).neg()),downstream=usd(new Decimal(amounts.downstream).neg()),profit=usd(new Decimal(amounts.profit).neg());
    await tx.query(`INSERT INTO settlement_adjustments(id,user_id,invoice_id,gross_usd,downstream_usd,profit_usd,reason,evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[adjustmentId,invoice.user_id,invoice.id,gross,downstream,profit,REFERENCE,JSON.stringify({usageIds})]);
    if(!new Decimal(profit).isZero())await tx.query(`INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id)
      VALUES($1,$2,'settlement_adjustment',$3,$4)`,[id(),invoice.user_id,profit,adjustmentId]);
    if(new Decimal(downstream).lt(0))await tx.query(`INSERT INTO team_fund_ledger(id,user_id,kind,amount_usd,reference_id)
      VALUES($1,$2,'funding_adjustment',$3,$4)`,[id(),invoice.user_id,downstream,adjustmentId]);
    await audit(tx,actor.id,'invoice.adjust',invoice.id,{repair:REFERENCE,adjustmentId,usageIds,gross,downstream,profit});
  }

  // Pending invoices have no ledger entry yet, so correct the draft itself.
  // Temporarily lift append-only guards inside this exact-fingerprint migration;
  // confirmed records are never rewritten.
  await tx.query('DROP TRIGGER invoice_items_append_only ON invoice_items');
  await tx.query('DROP TRIGGER invoices_sealed ON invoices');
  for(const invoice of affected.filter(candidate=>candidate.state==='pending')) {
    const legitimate=await tx.query(`SELECT x.earning_id,e.gross_usd,e.downstream_usd,e.profit_usd FROM invoice_items x
      JOIN earnings e ON e.id=x.earning_id WHERE x.invoice_id=$1 AND NOT(e.usage_id=ANY($2::text[])) ORDER BY x.earning_id`,[invoice.id,usageIds]);
    await tx.query("UPDATE invoices SET state='voided',reference=$2 WHERE id=$1",[invoice.id,REFERENCE]);
    let replacementId:string|null=null;
    if(legitimate.length) {
      replacementId=id();
      const totals=['gross_usd','downstream_usd','profit_usd'].map(field=>usd(sum(legitimate.map(item=>item[field]))));
      await tx.query(`INSERT INTO invoices(id,number,user_id,payer_id,date_from,date_to,gross_usd,downstream_usd,profit_usd,
        state,reference,created_by,automatic,estimated) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13)`,
      [replacementId,`CC-RECONCILE-${replacementId.slice(0,8).toUpperCase()}`,invoice.user_id,invoice.payer_id,invoice.date_from,invoice.date_to,
        ...totals,REFERENCE,actor.id,invoice.automatic,invoice.estimated]);
      await tx.query('DELETE FROM invoice_items WHERE earning_id=ANY($1::text[])',[legitimate.map(item=>item.earning_id)]);
      for(const item of legitimate)await tx.query('INSERT INTO invoice_items(earning_id,invoice_id) VALUES($1,$2)',[item.earning_id,replacementId]);
    }
    await audit(tx,actor.id,'invoice.reconcile',invoice.id,{repair:REFERENCE,voided:true,replacementId,excludedUsageIds:usageIds});
  }
  await tx.query(`CREATE TRIGGER invoice_items_append_only BEFORE UPDATE OR DELETE ON invoice_items
    FOR EACH ROW EXECUTE FUNCTION ccmax_reject_change()`);
  await tx.query(`CREATE OR REPLACE FUNCTION ccmax_guard_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CCMAX: invoices cannot be deleted' USING ERRCODE='23514'; END IF;
      IF OLD.state<>'pending' OR (NEW.id,NEW.user_id,NEW.payer_id,NEW.gross_usd,NEW.downstream_usd,NEW.profit_usd,NEW.date_from,NEW.date_to)
        IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.payer_id,OLD.gross_usd,OLD.downstream_usd,OLD.profit_usd,OLD.date_from,OLD.date_to) THEN
        RAISE EXCEPTION 'CCMAX: invoice amount and processed records are immutable' USING ERRCODE='23514';
      END IF; RETURN NEW;
    END $$`);
  await tx.query('CREATE TRIGGER invoices_sealed BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION ccmax_guard_invoice()');

  const [jadenAdjust]=await tx.query(`SELECT COALESCE(sum(a.gross_usd),0) AS gross,COALESCE(sum(a.downstream_usd),0) AS downstream,
    COALESCE(sum(a.profit_usd),0) AS profit FROM settlement_adjustments a WHERE a.user_id=$1 AND a.reason=$2`,[JADEN,REFERENCE]);
  assert(new Decimal(jadenAdjust.gross).eq('-416.05022898')&&new Decimal(jadenAdjust.downstream).eq('-258.23807316')
    &&new Decimal(jadenAdjust.profit).eq('-157.81215582'),'CCMAX repeated snapshot adjustment amount mismatch',409);
  const [postflight]=await tx.query(`SELECT
    (SELECT COALESCE(sum(gross_usd),0) FROM invoices WHERE payer_id=$1 AND state='pending') AS team_due,
    (SELECT COALESCE(sum(profit_usd),0) FROM invoices WHERE user_id=$1 AND state='pending') AS pending_profit,
    (SELECT count(*) FROM earnings e LEFT JOIN invoice_items x ON x.earning_id=e.id
      WHERE e.usage_id=ANY($2::text[]) AND x.earning_id IS NULL) AS unlinked`,[JADEN,usageIds]);
  assert(new Decimal(postflight.team_due).eq('16.71766578')&&new Decimal(postflight.pending_profit).eq('1191.15792016')
    &&Number(postflight.unlinked)===0,'CCMAX repeated snapshot reconciliation postflight mismatch',409);
  await assertWalletAccounting(tx,actor.id);
  await assertWalletAccounting(tx,JADEN);
}

async function exactInvoice(tx:DB,actor:Row,user:Row,usageIds:string[]) {
  const items=await tx.query(`SELECT e.* FROM earnings e JOIN usage_days u ON u.id=e.usage_id
    LEFT JOIN invoice_items ii ON ii.earning_id=e.id
    WHERE e.user_id=$1 AND e.usage_id=ANY($2::text[]) AND u.state='final' AND ii.earning_id IS NULL ORDER BY e.id`,[user.id,usageIds]);
  assert(items.length===usageIds.length,'CCMAX automatic reconciliation invoice item mismatch',409);
  await assertUsageAccounting(tx,usageIds);
  const totals=['gross_usd','downstream_usd','profit_usd'].map(field=>usd(sum(items.map(item=>item[field]))));
  const invoiceId=id(),days=TARGETS.filter(target=>usageIds.includes(target.id)).map(target=>target.day).sort();
  const [invoice]=await tx.query(`INSERT INTO invoices(id,number,user_id,payer_id,date_from,date_to,gross_usd,downstream_usd,profit_usd,created_by,automatic,estimated)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,false) RETURNING *`,[invoiceId,`CC-RECONCILE-${invoiceId.slice(0,8).toUpperCase()}`,
    user.id,user.parent_id,days[0],days.at(-1),...totals,actor.id]);
  for(const item of items) await tx.query('INSERT INTO invoice_items(earning_id,invoice_id) VALUES($1,$2)',[item.id,invoiceId]);
  await audit(tx,actor.id,'invoice.create',invoiceId,{repair:REFERENCE,usageIds});
  return invoice;
}

// Exact production fingerprints make this deploy-time repair safe to rerun and
// fail closed if the source data changes before deployment.
export async function applySettlementAutoReconciliation(tx:DB) {
  const [jaden]=await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[JADEN]);
  if(!jaden)return;
  const [owner]=await tx.query("SELECT * FROM users WHERE role='owner' FOR UPDATE");
  assert(owner&&jaden.parent_id===owner.id,'CCMAX automatic reconciliation hierarchy mismatch',409);
  const rows=await tx.query(`SELECT u.*,b.id AS binding_id,a.email,a.owner_id,a.ownership_verified,c.provider
    FROM usage_days u JOIN bindings b ON b.id=u.binding_id JOIN accounts a ON a.id=b.account_id
    JOIN connections c ON c.id=b.connection_id WHERE u.id=ANY($1::text[]) FOR UPDATE OF u`,[TARGETS.map(target=>target.id)]);
  assert(rows.length===TARGETS.length,'CCMAX automatic reconciliation fingerprint mismatch',409);
  for(const target of TARGETS) {
    const row=rows.find(candidate=>candidate.id===target.id);
    assert(row&&row.email===target.email&&row.provider===target.provider&&row.day===target.day
      &&new Decimal(row.raw_usd).eq(target.raw)&&row.owner_id===JADEN&&row.ownership_verified,
    'CCMAX automatic reconciliation fingerprint mismatch',409);
  }
  const linked=await tx.query(`SELECT e.usage_id,i.state,l.id AS ledger_id,l.amount_usd FROM earnings e
    JOIN invoice_items x ON x.earning_id=e.id JOIN invoices i ON i.id=x.invoice_id
    LEFT JOIN ledger l ON l.reference_id=i.id AND l.user_id=e.user_id AND l.kind='settlement'
    WHERE e.user_id=$1 AND e.usage_id=ANY($2::text[])`,[JADEN,TARGETS.map(target=>target.id)]);
  const unresolved=TARGETS.filter(target=>{
    const existing=linked.find(row=>row.usage_id===target.id);
    if(!existing)return true;
    assert(existing.state==='confirmed'&&existing.ledger_id&&new Decimal(existing.amount_usd).isFinite(),
      'CCMAX automatic reconciliation target has an incomplete invoice',409);
    return false;
  });
  if(!unresolved.length)return;
  assert(unresolved.every(target=>rows.find(row=>row.id===target.id)?.state==='provisional')
    &&linked.every(row=>!unresolved.some(target=>target.id===row.usage_id)),
  'CCMAX automatic reconciliation target is not safely repairable',409);
  for(const target of unresolved) {
    const row=rows.find(candidate=>candidate.id===target.id)!;
    await ingestUsage(tx,{bindingId:row.binding_id,day:target.day,rawUsd:target.raw,final:true,source:'reviewed_statement',evidence:REFERENCE});
  }
  const usageIds=unresolved.map(target=>target.id);
  const earnings=await tx.query('SELECT usage_id,profit_usd FROM earnings WHERE user_id=$1 AND usage_id=ANY($2::text[])',[JADEN,usageIds]);
  assert(earnings.length===unresolved.length&&unresolved.every(target=>new Decimal(earnings.find(row=>row.usage_id===target.id)?.profit_usd).eq(target.profit)),
    'CCMAX automatic reconciliation amount mismatch',409);
  const rootInvoice=await exactInvoice(tx,owner,owner,usageIds);
  await confirmInvoiceInTransaction(tx,owner,rootInvoice.id,REFERENCE);
  const jadenInvoice=await exactInvoice(tx,owner,jaden,usageIds);
  await confirmInvoiceInTransaction(tx,owner,jadenInvoice.id,REFERENCE);
}

export async function applyRepeatedSnapshotReconciliation(tx:DB) {
  await adjustmentSchema(tx);
  const [jaden]=await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[JADEN]);
  if(!jaden)return;
  const [owner]=await tx.query("SELECT * FROM users WHERE role='owner' FOR UPDATE");
  assert(owner&&jaden.parent_id===owner.id,'CCMAX repeated snapshot reconciliation hierarchy mismatch',409);
  await reconcileRepeatedSnapshots(tx,owner);
}
