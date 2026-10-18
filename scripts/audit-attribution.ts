import 'dotenv/config';
import { openDB } from '../server/db.js';
import { auditAttribution } from '../server/attribution-audit.js';

if(!process.env.DATABASE_URL)throw new Error('Set DATABASE_URL to the PostgreSQL database to audit. No migrations or data changes are performed.');
const db=await openDB(process.env.DATABASE_URL);
try {
  const report=await db.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return auditAttribution(tx);
  });
  console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
}finally{await db.close();}
