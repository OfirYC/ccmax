import { openDB, type DB } from './db.js';
import { randomUUID } from 'node:crypto';

// Each PostgreSQL test gets its own schema. Never migrate or truncate the
// caller's existing tables. Without TEST_DATABASE_URL use disposable PGlite.
export async function openTestDB():Promise<DB> {
  if(!process.env.TEST_DATABASE_URL)return openDB();
  const admin=await openDB(process.env.TEST_DATABASE_URL),schema='ccmax_test_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options',`-c search_path=${schema}`);
  const db=await openDB(url.toString());
  return {...db,async close(){await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();}};
}
