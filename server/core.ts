import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import Decimal from 'decimal.js';
import type { DB, Row } from './db.js';

const scrypt = promisify(scryptCb);
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export const id = () => randomUUID();
export const usd = (value: Decimal.Value) => new Decimal(value).toFixed(8);
export const sum = (values: Decimal.Value[]) => values.reduce<Decimal>((a,b) => a.plus(b), new Decimal(0));
export const today = () => new Date(Date.now()+8*3600000).toISOString().slice(0,10);
export const nextDay = (day = today()) => new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10);
export const dayString = (v: unknown) => v instanceof Date ? v.toISOString().slice(0,10) : String(v).slice(0,10);
export class AppError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
export function assert(ok: unknown, message: string, code=400): asserts ok { if (!ok) throw new AppError(code,message); }
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password,salt,64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [salt, hash] = encoded.split(':');
  if (!salt || !hash) return false;
  const key = await scrypt(password,salt,64) as Buffer;
  const expected = Buffer.from(hash,'hex');
  return expected.length===key.length && timingSafeEqual(expected,key);
}
export function secretBox(keyHex: string) {
  assert(/^[a-f\d]{64}$/i.test(keyHex),'ENCRYPTION_KEY 必须是 32 字节十六进制密钥',500);
  const key = Buffer.from(keyHex,'hex');
  return {
    encrypt(value: unknown) {
      const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
      const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
      return [iv,cipher.getAuthTag(),data].map(b=>b.toString('base64url')).join('.');
    },
    decrypt<T=any>(value: string): T {
      const [iv,tag,data]=value.split('.').map(b=>Buffer.from(b,'base64url'));
      const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'));
    },
  };
}
export type SecretBox = ReturnType<typeof secretBox>;
export async function audit(db: DB, actor: string | null, action: string, target?: string, details: object={}) {
  await db.query('INSERT INTO audits(id,actor_id,action,target_id,details) VALUES($1,$2,$3,$4,$5)',[id(),actor,action,target??null,JSON.stringify(details)]);
}
export async function subtree(db: DB, userId: string): Promise<string[]> {
  const rows=await db.query('WITH RECURSIVE tree AS (SELECT id FROM users WHERE id=$1 UNION ALL SELECT u.id FROM users u JOIN tree t ON u.parent_id=t.id) SELECT id FROM tree',[userId]);
  return rows.map(r=>r.id);
}
export async function ancestry(db: DB, userId: string): Promise<Row[]> {
  return db.query('WITH RECURSIVE chain AS (SELECT *,0 AS depth FROM users WHERE id=$1 UNION ALL SELECT u.*,c.depth+1 FROM users u JOIN chain c ON c.parent_id=u.id) SELECT * FROM chain ORDER BY depth DESC',[userId]);
}
export async function requireOwner(user: Row) { assert(user.role==='owner','仅平台管理员可操作',403); }
export async function requireDirect(db: DB, actor: Row, userId: string) {
  const [user]=await db.query('SELECT id,parent_id FROM users WHERE id=$1',[userId]);
  assert(user && user.parent_id===actor.id,'只能管理直属下级',403);
  return user;
}
export async function bootstrap(db: DB, env: Record<string,string|undefined>) {
  const [row]=await db.query('SELECT id FROM users WHERE role=\'owner\'');
  if (row) return;
  assert(env.ADMIN_EMAIL && env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length>=12,'首次启动必须设置 ADMIN_EMAIL 和至少 12 位的 ADMIN_PASSWORD',500);
  const hash=await hashPassword(env.ADMIN_PASSWORD);
  await db.query('INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,\'owner\') ON CONFLICT DO NOTHING',[id(),env.ADMIN_EMAIL.toLowerCase(),env.ADMIN_NAME||'平台管理员',hash]);
}
