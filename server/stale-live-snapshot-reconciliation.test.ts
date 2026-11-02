import { expect,it } from 'vitest';
import { bootstrap,id } from './core.js';
import { ingestUsage } from './billing.js';
import { migrate } from './db.js';
import { openTestDB } from './test-db.js';

it('migration removes only uninvoiced repeated estimates from disabled Gatelink accounts',async()=>{
  const db=await openTestDB();
  try {
    await migrate(db);await bootstrap(db,{ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'migration-password'});
    const [owner]=await db.query("SELECT * FROM users WHERE role='owner'");
    const connection=id();await db.query("INSERT INTO connections(id,provider,name,credentials,payout_rate) VALUES($1,'gatelink','Platform A','encrypted',0.5)",[connection]);
    await db.query("INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by) VALUES($1,$2,0.5,'1970-01-01',$3)",[id(),connection,owner.id]);
    const add=async(status:string,email:string)=>{
      const account=id(),binding=id();
      await db.query('INSERT INTO accounts(id,owner_id,email,ownership_verified) VALUES($1,$2,$3,true)',[account,owner.id,email]);
      await db.query('INSERT INTO bindings(id,account_id,connection_id,external_id,status) VALUES($1,$2,$3,$1,$4)',[binding,account,connection,status]);
      for(const day of ['2026-10-31','2026-11-01'])await db.transaction(tx=>ingestUsage(tx,{bindingId:binding,day,rawUsd:'123.456789',final:false,source:'live_snapshot'}));
      return binding;
    };
    const disabled=await add('disabled','disabled@example.com');
    const active=await add('active','active@example.com');
    await db.query('DELETE FROM migrations WHERE version=29');
    await migrate(db);await migrate(db);
    expect(await db.query('SELECT day FROM usage_days WHERE binding_id=$1 ORDER BY day',[disabled])).toEqual([{day:'2026-10-31'}]);
    expect(await db.query('SELECT day FROM usage_days WHERE binding_id=$1 ORDER BY day',[active])).toEqual([{day:'2026-10-31'},{day:'2026-11-01'}]);
    expect((await db.query('SELECT count(*)::int AS count FROM earnings WHERE usage_id NOT IN (SELECT id FROM usage_days)'))[0].count).toBe(0);
    expect(await db.query("SELECT action FROM audits WHERE action='usage.stale_live_snapshot_reconcile'")).toHaveLength(1);
  } finally {await db.close();}
});
