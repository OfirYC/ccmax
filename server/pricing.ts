import Decimal from 'decimal.js';
import type { DB, Row } from './db.js';
import { AppError, dayString, nextDay, today } from './core.js';
import { PROVIDER_KEYS, type ProviderKey } from './providers.js';

type Point = { day: string; rate: Decimal };
const at = (points: Point[], day: string) => points.findLast(point => point.day <= day)?.rate;
const pointsFor = (rows: Row[], field: string) => {
  const result = new Map<string, Point[]>();
  for (const row of rows) {
    const points = result.get(row[field]) || [];
    points.push({ day: dayString(row.effective_date), rate: new Decimal(row.rate) });
    result.set(row[field], points);
  }
  return result;
};
const minimum = (values: Decimal[]) => Decimal.min(...values);

// All price mutations for a platform take this lock before locking users or
// connections, including concurrent parent/child changes from API clients.
export async function lockPricing(tx: DB, provider: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ccmax:pricing:${provider}`]);
}

async function loadPricing(db: DB, provider: ProviderKey) {
  const users = await db.query('SELECT id,parent_id,role FROM users');
  const rates = pointsFor(await db.query('SELECT user_id,rate,effective_date FROM rates WHERE provider=$1 ORDER BY effective_date', [provider]), 'user_id');
  const connections = await db.query('SELECT id FROM connections WHERE provider=$1', [provider]);
  const upstream = pointsFor(await db.query(`SELECT r.connection_id,r.rate,r.effective_date FROM connection_rates r
    JOIN connections c ON c.id=r.connection_id WHERE c.provider=$1 ORDER BY r.effective_date`, [provider]), 'connection_id');
  const rootPoints = [...upstream.values()].flat();
  function price(userId: string, day: string): Decimal | undefined {
    const user = users.find(user => user.id === userId);
    if (!user) return;
    if (user.role !== 'owner') return at(rates.get(userId) || [], day);
    // The owner may prepare prices before connecting a platform. Once a
    // connection exists, every connection's dated contract is a hard ceiling.
    if (!connections.length) return new Decimal(1);
    const values = connections.map(connection => at(upstream.get(connection.id) || [], day));
    return values.every(value => value !== undefined) ? minimum(values as Decimal[]) : undefined;
  }
  function points(userId: string) {
    return users.find(user => user.id === userId)?.role === 'owner' ? rootPoints : rates.get(userId) || [];
  }
  function dates(ids: string[], from: string, until?: string) {
    return [...new Set([from, ...ids.flatMap(id => points(id).map(point => point.day))])]
      .filter(day => day >= from && (!until || day < until)).sort();
  }
  function ceiling(userId: string, from: string, until?: string): Decimal | undefined {
    const chain: string[] = [];
    let user = users.find(user => user.id === userId);
    while (user) { chain.push(user.id); user = users.find(parent => parent.id === user!.parent_id); }
    if (!chain.length) return;
    const values: Decimal[] = [];
    for (const day of dates(chain, from, until)) {
      for (const id of chain) {
        const rate = price(id, day);
        if (rate === undefined) return;
        values.push(rate);
      }
    }
    return minimum(values);
  }
  function childFloor(userId: string, from: string, until?: string) {
    const children = users.filter(user => user.parent_id === userId).map(user => user.id);
    const values = dates(children, from, until).flatMap(day => children.map(id => price(id, day)).filter((rate): rate is Decimal => rate !== undefined));
    return values.length ? Decimal.max(...values) : new Decimal(0);
  }
  return { users, rates, upstream, price, dates, ceiling, childFloor };
}

export async function assertUserPricing(tx: DB, userId: string, provider: ProviderKey, effective: string) {
  const state = await loadPricing(tx, provider);
  const user = state.users.find(user => user.id === userId)!;
  const rate = state.price(userId, effective)!;
  const until = state.rates.get(userId)?.find(point => point.day > effective)?.day;
  const cap = state.ceiling(user.parent_id, effective, until);
  if (cap === undefined) throw new AppError(400, '该平台在报价生效期间没有完整的上级价格，请先补齐上级定价', 'UPSTREAM_RATE_MISSING');
  if (rate.gt(cap)) throw new AppError(400, `下级折扣不能高于生效期间的上级上限 ${cap.toFixed(4)}`, 'RATE_CAP_EXCEEDED');
  const floor = state.childFloor(userId, effective, until);
  if (rate.lt(floor)) throw new AppError(400, `折扣不能低于已约定的下级折扣 ${floor.toFixed(4)}，请先调整下级价格`, 'RATE_FLOOR_VIOLATION');
}

export async function assertConnectionPricing(tx: DB, connectionId: string, provider: ProviderKey, effective: string) {
  const state = await loadPricing(tx, provider);
  const owner = state.users.find(user => user.role === 'owner')!;
  const until = state.upstream.get(connectionId)?.find(point => point.day > effective)?.day;
  const children = state.users.filter(user => user.parent_id === owner.id).map(user => user.id);
  for (const day of state.dates([owner.id, ...children], effective, until)) {
    const cap = state.price(owner.id, day), floor = state.childFloor(owner.id, day, nextDay(day));
    if (children.some(id => state.price(id,day)!==undefined) && (cap === undefined || cap.lt(floor))) {
      throw new AppError(400, `上游折扣不能低于已约定的直属代理折扣 ${floor.toFixed(4)}，请先调整代理价格`, 'RATE_FLOOR_VIOLATION');
    }
  }
}

export async function pricingSummary(db: DB, userId: string, visibleIds: string[]) {
  const limits: Record<string, { create: string | null; change: string | null }> = {};
  const issues: { userId: string; provider: string; effectiveDate: string }[] = [];
  const current = today();
  for (const provider of PROVIDER_KEYS) {
    const state = await loadPricing(db, provider);
    limits[provider] = { create: state.ceiling(userId, current)?.toFixed(4) ?? null, change: state.ceiling(userId, nextDay())?.toFixed(4) ?? null };
    for (const user of state.users.filter(user => visibleIds.includes(user.id) && user.parent_id)) {
      const invalidDay = state.dates([user.id, user.parent_id], current).find(day => {
        const rate = state.price(user.id, day), parent = state.price(user.parent_id, day);
        return rate !== undefined && (parent === undefined || rate.gt(parent));
      });
      if (invalidDay) issues.push({ userId: user.id, provider, effectiveDate: invalidDay });
    }
  }
  return { limits, issues };
}
