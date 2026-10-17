import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir, readFile } from 'node:fs/promises';

export type Row = Record<string, any>;
export interface DB {
  query<T extends Row = Row>(sql: string, params?: any[]): Promise<T[]>;
  transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDB(url?: string, localPath?: string): Promise<DB> {
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const wrap = (client: pg.Pool | pg.PoolClient): DB => ({
      async query(sql, params = []) { return (await client.query(sql, params)).rows; },
      async transaction(fn) {
        if (!('connect' in client)) throw new Error('Nested transactions are not supported');
        const c = await pool.connect();
        try { await c.query('BEGIN'); const result = await fn(wrap(c)); await c.query('COMMIT'); return result; }
        catch (e) { await c.query('ROLLBACK'); throw e; }
        finally { c.release(); }
      },
      async close() { await pool.end(); },
    });
    return wrap(pool);
  }
  if (localPath) await mkdir(localPath, { recursive: true });
  const db = new PGlite(localPath);
  const wrap = (client: any): DB => ({
    async query(sql, params = []) { return (await client.query(sql, params)).rows; },
    async transaction(fn) { return client.transaction((tx: any) => fn(wrap(tx))); },
    async close() { await db.close(); },
  });
  await db.waitReady;
  return wrap(db);
}

export async function migrate(db: DB) {
  const schema = await readFile(new URL('../../server/schema.sql', import.meta.url).pathname, 'utf8')
    .catch(() => readFile('server/schema.sql', 'utf8'));
  await db.transaction(async tx => {
    // Transaction-scoped lock also serializes startup across Railway replicas.
    if (process.env.DATABASE_URL) await tx.query('SELECT pg_advisory_xact_lock(7164021)');
    await tx.query('CREATE TABLE IF NOT EXISTS migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = await tx.query('SELECT version FROM migrations ORDER BY version');
    if (!done.some(row=>Number(row.version)===1)) {
      // PostgreSQL accepts a migration batch, while PGlite intentionally rejects
      // multiple commands in one prepared statement. Execute each DDL statement
      // separately for the local development database.
      const statements = process.env.DATABASE_URL ? [schema] : schema.split(/;\s*\n/).map(s=>s.trim()).filter(Boolean).map(s=>s+';');
      for (const statement of statements) await tx.query(statement);
      await tx.query('INSERT INTO migrations(version) VALUES (1)');
    }
    if (!done.some(row=>Number(row.version)===2)) {
      // v1 deployments stored only the current connection payout rate. Preserve
      // that contract as a baseline so historical imports never silently use a
      // later edited value. New rows are scheduled through the API below.
      await tx.query(`CREATE TABLE IF NOT EXISTS connection_rates (
        id text PRIMARY KEY,
        connection_id text NOT NULL REFERENCES connections(id),
        rate numeric(5,4) NOT NULL CHECK(rate>=0 AND rate<=1),
        effective_date date NOT NULL,
        created_by text REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(connection_id,effective_date)
      )`);
      await tx.query('CREATE INDEX IF NOT EXISTS connection_rates_lookup ON connection_rates(connection_id,effective_date DESC)');
      await tx.query(`INSERT INTO connection_rates(id,connection_id,rate,effective_date,created_by)
        SELECT md5(c.id || ':baseline'),c.id,c.payout_rate,DATE '1970-01-01',u.id
        FROM connections c LEFT JOIN users u ON u.role='owner'
        ON CONFLICT(connection_id,effective_date) DO NOTHING`);
      await tx.query('INSERT INTO migrations(version) VALUES (2)');
    }
  });
}
