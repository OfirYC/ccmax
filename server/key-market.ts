import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB, Row } from './db.js';
import { AppError, ancestry, assert, audit, id, nextDay, requireDirect, requireOwner, secretBox, subtree, today, usd, type SecretBox } from './core.js';
import { NewApiClient, decryptNewApiCredentials, type NewApiCredentials } from './new-api.js';
import { KeyManClient, type KeyManCredentials, type KeyManChannelInput } from './keyman-newapi.js';

const identifier = z.string().uuid();
const rate = z.coerce.number().min(0).max(1).multipleOf(0.0001);
const taskState = z.enum(['draft', 'published', 'paused', 'closed']);
const authType = z.enum(['password', 'access_token']);
const adapterType = z.enum(['standard_new_api', 'keyman_newapi']);
const templateType = adapterType;
const keyValue = z.string().trim().min(8).max(1000);

function masked(value: string) {
  if (value.length <= 8) return `${value.slice(0, 2)}****${value.slice(-2)}`;
  return `${value.slice(0, 4)}**********${value.slice(-4)}`;
}

function fingerprint(value: string) { return createHash('sha256').update(value).digest('hex'); }

function normalizeConnection(row: Row) {
  return { id: row.id, name: row.name, base_url: row.base_url, auth_type: row.auth_type, status: row.status,
    adapter_type: row.adapter_type || 'standard_new_api', tenant_id: row.tenant_id || '1', quota_per_unit: row.quota_per_unit,
    last_sync_at: row.last_sync_at, last_error: row.last_error, created_at: row.created_at };
}

export async function initializeKeyMarket(db: DB) {
  const [owner] = await db.query('SELECT id FROM users WHERE role=\'owner\' ORDER BY created_at LIMIT 1');
  if (!owner) return;
  await db.query(`INSERT INTO workspaces(id,kind,name) VALUES($1,'earnings','CCMAX 主工作空间') ON CONFLICT(kind) DO NOTHING`, [id()]);
  await db.query(`INSERT INTO workspaces(id,kind,name) VALUES($1,'key_market','Key 供货工作空间') ON CONFLICT(kind) DO NOTHING`, [id()]);
  const [earnings] = await db.query("SELECT id FROM workspaces WHERE kind='earnings'");
  const [market] = await db.query("SELECT id FROM workspaces WHERE kind='key_market'");
  const users = await db.query('SELECT id,role FROM users WHERE active=true');
  for (const user of users) {
    const role = user.role === 'owner' ? 'owner' : 'supplier';
    await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET active=true,role=EXCLUDED.role`, [earnings.id, user.id, role === 'owner' ? 'owner' : 'agent']);
    await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET active=true`, [market.id, user.id, role]);
  }
}

async function marketWorkspace(db: DB) {
  const [workspace] = await db.query("SELECT * FROM workspaces WHERE kind='key_market'");
  assert(workspace, 'Key 工作空间尚未初始化', 500);
  return workspace;
}

async function assertMember(db: DB, user: Row) {
  // Team members can be created after process startup.  Refresh the small
  // membership projection lazily so they can enter the Key workspace without
  // an administrator restart or a separate invitation flow.
  await initializeKeyMarket(db);
  const workspace = await marketWorkspace(db);
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET active=true`, [workspace.id, user.id, user.role === 'owner' ? 'owner' : 'supplier']);
  const [member] = await db.query('SELECT * FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND active=true', [workspace.id, user.id]);
  assert(member, '你没有 Key 工作空间权限', 403);
  return { workspace, member };
}

async function getConnection(db: DB, idValue: string, workspaceId: string) {
  const [connection] = await db.query('SELECT * FROM new_api_connections WHERE id=$1 AND workspace_id=$2', [idValue, workspaceId]);
  assert(connection, 'New API 连接不存在', 404);
  return connection;
}

async function getTask(db: DB, taskId: string, workspaceId?: string) {
  const [task] = await db.query(`SELECT t.*,c.base_url,c.status AS connection_status,c.last_sync_at,c.last_error,c.quota_per_unit
    FROM key_tasks t JOIN new_api_connections c ON c.id=t.new_api_connection_id WHERE t.id=$1 ${workspaceId ? 'AND t.workspace_id=$2' : ''}`,
    workspaceId ? [taskId, workspaceId] : [taskId]);
  assert(task, 'Key 任务不存在', 404);
  return task;
}

async function taskRate(db: DB, task: Row, userId: string, day = today()): Promise<string | null> {
  const [user] = await db.query('SELECT role FROM users WHERE id=$1', [userId]);
  if (user?.role === 'owner') return String(task.root_rate);
  const [quote] = await db.query(`SELECT rate FROM task_rates WHERE task_id=$1 AND user_id=$2 AND effective_date<=$3
    ORDER BY effective_date DESC LIMIT 1`, [task.id, userId, day]);
  return quote ? String(quote.rate) : null;
}

async function visibleTask(db: DB, task: Row, user: Row) {
  if (user.role === 'owner') return true;
  if (!['published', 'paused'].includes(task.state)) return false;
  return true;
}

async function canSubmitTask(db: DB, task: Row, user: Row) {
  if (user.role === 'owner') return true;
  if (!['published', 'paused'].includes(task.state)) return false;
  return (await taskRate(db, task, user.id)) !== null;
}

type MarketClient = NewApiClient | KeyManClient;

function decryptKeyManCredentials(box: SecretBox, encrypted: string): KeyManCredentials {
  const value = box.decrypt<KeyManCredentials>(encrypted);
  assert(value && (value.kind === 'access_token' || value.kind === 'password'), 'KeyMan 凭据格式无效', 500);
  return value;
}

function connectionClient(box: SecretBox, connection: Row): MarketClient {
  if ((connection.adapter_type || 'standard_new_api') === 'keyman_newapi') {
    const credentials = decryptKeyManCredentials(box, connection.credentials);
    return new KeyManClient(connection.base_url, { ...credentials, tenantId: connection.tenant_id || credentials.tenantId || '1' });
  }
  return new NewApiClient(connection.base_url, decryptNewApiCredentials(box, connection.credentials));
}

function isKeyMan(connection: Row | undefined) { return (connection?.adapter_type || 'standard_new_api') === 'keyman_newapi'; }

function parseJsonText(value: unknown, label: string, fallback: any = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw new AppError(400, `${label}必须是合法 JSON`, 'VALIDATION_ERROR'); }
}

function parseCredentials(body: any): NewApiCredentials {
  if (body.authType === 'access_token') {
    assert(typeof body.accessToken === 'string' && body.accessToken.trim().length >= 10, '请填写 New API 管理访问 Key');
    return { kind: 'access_token', token: body.accessToken.trim() };
  }
  assert(typeof body.username === 'string' && body.username.trim() && typeof body.password === 'string' && body.password.length >= 1, '请填写 New API 管理员账号和密码');
  return { kind: 'password', username: body.username.trim(), password: body.password };
}

function parseKeyManCredentials(body: any, tenantId = '1'): KeyManCredentials {
  if (body.authType === 'access_token') {
    assert(typeof body.accessToken === 'string' && body.accessToken.trim().length >= 10, '请填写 KeyMan 管理访问令牌');
    return { kind: 'access_token', token: body.accessToken.trim(), tenantId };
  }
  assert(typeof body.username === 'string' && body.username.trim() && typeof body.password === 'string' && body.password.length >= 1, '请填写 KeyMan 管理员账号和密码');
  return { kind: 'password', username: body.username.trim(), password: body.password, tenantId, captchaVerification: body.captchaVerification?.trim() || undefined };
}

async function taskSummary(db: DB, task: Row, user: Row) {
  const ids = user.role === 'owner' ? await subtree(db, user.id) : await subtree(db, user.id);
  const [stats] = await db.query(`SELECT count(*)::int AS channels,COALESCE(sum(used_usd),0) AS used_usd,
    count(*) FILTER(WHERE status='active')::int AS active_channels
    FROM task_channels WHERE task_id=$1 AND supplier_user_id=ANY($2::text[]) AND status<>'deleted'`, [task.id, ids]);
  const [settlement] = await db.query(`SELECT COALESCE(sum(profit_usd),0) AS profit_usd,
    COALESCE(sum(profit_usd) FILTER(WHERE kind='task_settlement'),0) AS settled_usd,
    COALESCE(sum(profit_usd) FILTER(WHERE kind='task_adjustment'),0) AS adjustment_usd FROM task_settlement_entries
    WHERE user_id=$3 AND snapshot_id IN (SELECT s.id FROM task_usage_snapshots s JOIN task_channels c ON c.id=s.channel_id WHERE c.task_id=$1 AND c.supplier_user_id=ANY($2::text[]))`, [task.id, ids, user.id]);
  return { ...task, models: task.models || [], rate: await taskRate(db, task, user.id), channels: Number(stats.channels), active_channels: Number(stats.active_channels), used_usd: stats.used_usd, total_usd: stats.used_usd, profit_usd: settlement.profit_usd, settled_usd: settlement.settled_usd, adjustment_usd: settlement.adjustment_usd, settling_usd: '0', pending_usd: '0' };
}

export async function syncKeyTask(db: DB, box: SecretBox, taskId: string) {
  const [task] = await db.query(`SELECT t.*,c.base_url,c.credentials,c.adapter_type,c.tenant_id,c.quota_per_unit AS connection_quota,c.id AS connection_id FROM key_tasks t
    JOIN new_api_connections c ON c.id=t.new_api_connection_id WHERE t.id=$1 AND t.state IN ('published','paused')`, [taskId]);
  assert(task, 'Key 任务不存在或未发布', 404);
  const client = connectionClient(box, task);
  let status: { quotaPerUnit: number; raw: any }, remoteChannels: Awaited<ReturnType<NewApiClient['listChannels']>>;
  try {
    // Password-authenticated New API instances issue a session cookie during
    // login; access-token instances simply validate their bearer key here.
    await client.authenticate();
    if (isKeyMan(task)) {
      status = await (client as KeyManClient).status(task.connection_quota ? Number(task.connection_quota) : undefined);
      assert(task.gateway_id, 'KeyMan 任务未绑定网关', 409);
      remoteChannels = await (client as KeyManClient).listChannels(String(task.gateway_id));
    } else {
      status = await (client as NewApiClient).status();
      remoteChannels = await (client as NewApiClient).listChannels();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'New API 同步失败';
    await db.query('UPDATE new_api_connections SET status=\'error\',last_error=$2 WHERE id=$1', [task.connection_id, message]);
    throw error;
  }
  const remoteById = new Map(remoteChannels.map(channel => [String(channel.id), channel]));
  const localChannels = await db.query('SELECT * FROM task_channels WHERE task_id=$1 AND status<>\'deleted\'', [task.id]);
  let credited = 0, adjusted = 0, issues = 0;
  for (const local of localChannels) {
    if (!local.external_channel_id) continue;
    let remote = remoteById.get(String(local.external_channel_id));
    if (!remote) {
      issues++;
      await db.query('UPDATE task_channels SET status=\'error\',last_error=$2,last_sync_at=now() WHERE id=$1', [local.id, 'New API 中找不到对应渠道']);
      continue;
    }
    if (remote.usedQuota === null || !Number.isFinite(remote.usedQuota)) {
      // Some New API builds expose used_quota only after their explicit
      // update_balance endpoint is called.  Refresh that channel once before
      // treating the observation as unavailable.
      try {
        remote = isKeyMan(task)
          ? await (client as KeyManClient).syncChannelBalance(String(task.gateway_id), local.external_channel_id) || undefined
          : await (client as NewApiClient).syncChannelBalance(local.external_channel_id) || undefined;
      } catch { remote = undefined; }
    }
    if (!remote || remote.usedQuota === null || !Number.isFinite(remote.usedQuota)) {
      issues++;
      await db.query('UPDATE task_channels SET status=\'error\',last_error=$2,last_sync_at=now() WHERE id=$1', [local.id, 'New API 未返回 used_quota，已保留上次用量']);
      continue;
    }
    const usedQuota = Math.max(0, Math.trunc(remote.usedQuota));
    const usedUsd = new Decimal(usedQuota).div(status.quotaPerUnit);
    await db.transaction(async tx => {
      const [locked] = await tx.query('SELECT * FROM task_channels WHERE id=$1 FOR UPDATE', [local.id]);
      assert(locked, 'Key 渠道不存在', 404);
      const previousQuota = Number(locked.used_quota || 0);
      const delta = usedQuota - previousQuota;
      // A zero-delta observation is deterministic, so retries do not create
      // an unbounded stream of identical snapshots.  A changed cumulative
      // value receives a fresh event id: after a counter rollback the same
      // value can legitimately be observed again and must remain auditable.
      const sourceHash = delta === 0 ? `${local.external_channel_id}:${usedQuota}:unchanged` : `${local.external_channel_id}:${previousQuota}->${usedQuota}:${id()}`;
      const deltaUsd = usd(new Decimal(delta).div(status.quotaPerUnit));
      const [snapshot] = await tx.query(`INSERT INTO task_usage_snapshots(id,channel_id,external_channel_id,used_quota,quota_per_unit,used_usd,delta_quota,delta_usd,observed_at,source_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9) ON CONFLICT(channel_id,source_hash) DO NOTHING RETURNING *`,
        [id(), local.id, local.external_channel_id, usedQuota, status.quotaPerUnit, usd(usedUsd), delta, deltaUsd, sourceHash]);
      const remoteStatus = remote.status === 1 ? 'active' : 'auto_disabled';
      const remoteError = remoteStatus === 'auto_disabled' ? `New API 渠道状态 ${remote.status}，已自动封禁` : null;
      await tx.query(`UPDATE task_channels SET used_quota=$2,used_usd=$3,last_sync_at=now(),last_error=$5,status=$4 WHERE id=$1`,
        [local.id, usedQuota, usd(usedUsd), remoteStatus, remoteError]);
      await tx.query('UPDATE new_api_connections SET quota_per_unit=$2,status=\'connected\',last_sync_at=now(),last_error=NULL WHERE id=$1', [task.connection_id, status.quotaPerUnit]);
      if (!snapshot || delta === 0) return;
      const chain = await ancestry(tx, local.supplier_user_id);
      const rates: Decimal[] = [];
      for (const member of chain) {
        const value = await taskRate(tx, task, member.id);
        assert(value !== null, `${member.name} 尚未设置此任务价格`, 409);
        rates.push(new Decimal(value));
      }
      const raw = new Decimal(delta).div(status.quotaPerUnit);
      const kind = delta < 0 ? 'task_adjustment' : 'task_settlement';
      for (let index = 0; index < chain.length; index++) {
        const current = rates[index], downstream = rates[index + 1] || new Decimal(0);
        const gross = raw.mul(current), payable = raw.mul(downstream), profit = gross.minus(payable);
        const [entry] = await tx.query(`INSERT INTO task_settlement_entries(id,snapshot_id,user_id,payer_id,next_user_id,rate,downstream_rate,gross_usd,downstream_usd,profit_usd,kind)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(snapshot_id,user_id,kind) DO NOTHING RETURNING *`,
          [id(), snapshot.id, chain[index].id, chain[index - 1]?.id ?? null, chain[index + 1]?.id ?? null,
            current.toFixed(4), downstream.toFixed(4), usd(gross), usd(payable), usd(profit), kind]);
        if (entry) await tx.query('INSERT INTO ledger(id,user_id,kind,amount_usd,reference_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,reference_id) DO NOTHING',
          [id(), entry.user_id, kind, entry.profit_usd, entry.id]);
      }
      if (delta > 0) credited += 1; else adjusted += 1;
    }).catch(async error => {
      issues++;
      await db.query('UPDATE task_channels SET last_error=$2,last_sync_at=now() WHERE id=$1', [local.id, error instanceof Error ? error.message : '任务结算失败']);
    });
  }
  await db.query('UPDATE new_api_connections SET quota_per_unit=$2,status=$3,last_sync_at=now(),last_error=$4 WHERE id=$1',
    [task.connection_id, status.quotaPerUnit, issues ? 'error' : 'connected', issues ? `${issues} 个渠道同步或结算失败` : null]);
  return { taskId: task.id, channels: localChannels.length, credited, adjusted, issues, quotaPerUnit: status.quotaPerUnit };
}

export async function syncPublishedKeyTasks(db: DB, box: SecretBox) {
  const tasks = await db.query("SELECT id FROM key_tasks WHERE state IN ('published','paused') ORDER BY created_at");
  const results = [];
  for (const task of tasks) {
    try { results.push(await syncKeyTask(db, box, task.id)); }
    catch (error) { results.push({ taskId: task.id, error: error instanceof Error ? error.message : '同步失败' }); }
  }
  return results;
}

export function registerKeyMarket(app: FastifyInstance, db: DB, box: SecretBox) {
  app.get('/api/workspaces', async req => {
    await initializeKeyMarket(db);
    return { workspaces: await db.query(`SELECT w.id,w.kind,w.name,wm.role,wm.active FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id=w.id WHERE wm.user_id=$1 AND wm.active=true ORDER BY w.kind`, [req.user.id]) };
  });

  app.get('/api/new-api-connections', async req => {
    const { workspace } = await assertMember(db, req.user);
    const rows = (await db.query('SELECT * FROM new_api_connections WHERE workspace_id=$1 ORDER BY created_at DESC', [workspace.id])).map(normalizeConnection);
    return { connections: req.user.role === 'owner' ? rows : rows.map(({ id, name, status, quota_per_unit, last_sync_at, last_error }) => ({ id, name, status, quota_per_unit, last_sync_at, last_error })) };
  });
  app.get('/api/new-api-connections/:id/gateways', async req => {
    const { workspace } = await assertMember(db, req.user);
    const connection = await getConnection(db, identifier.parse((req.params as Row).id), workspace.id);
    const client = connectionClient(box, connection);
    await client.authenticate();
    if (!isKeyMan(connection)) return { gateways: [] };
    return { gateways: await (client as KeyManClient).listGateways() };
  });
  app.post('/api/new-api-connections', async req => {
    await requireOwner(req.user); const { workspace } = await assertMember(db, req.user);
    const body = z.object({ name: z.string().trim().min(1).max(100), baseUrl: z.string().url().max(500), authType: authType,
      adapterType: adapterType.default('standard_new_api'), tenantId: z.string().regex(/^\d+$/).default('1'), quotaPerUnit: z.coerce.number().positive().optional(), captchaVerification: z.string().max(2000).optional(),
      username: z.string().max(200).optional(), password: z.string().max(500).optional(), accessToken: z.string().max(500).optional() }).strict().parse(req.body);
    const credentials = body.adapterType === 'keyman_newapi' ? parseKeyManCredentials(body, body.tenantId) : parseCredentials(body);
    const client = body.adapterType === 'keyman_newapi' ? new KeyManClient(body.baseUrl, credentials as KeyManCredentials) : new NewApiClient(body.baseUrl, credentials as NewApiCredentials);
    await client.authenticate(); const status = body.adapterType === 'keyman_newapi'
      ? await (client as KeyManClient).status(body.quotaPerUnit)
      : await (client as NewApiClient).status();
    const connectionId = id();
    const [connection] = await db.query(`INSERT INTO new_api_connections(id,workspace_id,name,base_url,auth_type,credentials,adapter_type,tenant_id,status,quota_per_unit,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'connected',$9,$10) RETURNING *`, [connectionId, workspace.id, body.name, body.baseUrl.trim().replace(/\/+$/, ''), body.authType, box.encrypt(credentials), body.adapterType, body.tenantId, status.quotaPerUnit, req.user.id]);
    await audit(db, req.user.id, 'key.new_api_connection.create', connectionId, { name: body.name, baseUrl: body.baseUrl, authType: body.authType, adapterType: body.adapterType });
    return { connection: normalizeConnection(connection) };
  });
  app.post('/api/new-api-connections/:id/test', async req => {
    await requireOwner(req.user); const { workspace } = await assertMember(db, req.user);
    const connection = await getConnection(db, identifier.parse((req.params as Row).id), workspace.id);
    try {
      const client = connectionClient(box, connection); await client.authenticate(); const status = isKeyMan(connection)
        ? await (client as KeyManClient).status(connection.quota_per_unit ? Number(connection.quota_per_unit) : undefined)
        : await (client as NewApiClient).status();
      await db.query('UPDATE new_api_connections SET status=\'connected\',quota_per_unit=$2,last_sync_at=now(),last_error=NULL WHERE id=$1', [connection.id, status.quotaPerUnit]);
      return { ok: true, quotaPerUnit: status.quotaPerUnit };
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接失败'; await db.query('UPDATE new_api_connections SET status=\'error\',last_error=$2 WHERE id=$1', [connection.id, message]); throw error;
    }
  });
  app.patch('/api/new-api-connections/:id', async req => {
    await requireOwner(req.user); const { workspace } = await assertMember(db, req.user);
    const connection = await getConnection(db, identifier.parse((req.params as Row).id), workspace.id);
    const body = z.object({ name: z.string().trim().min(1).max(100).optional(), baseUrl: z.string().url().max(500).optional(), authType: authType.optional(), adapterType: adapterType.optional(), tenantId: z.string().regex(/^\d+$/).optional(), quotaPerUnit: z.coerce.number().positive().optional(), captchaVerification: z.string().max(2000).optional(), username: z.string().max(200).optional(), password: z.string().max(500).optional(), accessToken: z.string().max(500).optional(), status: z.enum(['connected', 'disabled']).optional() }).strict().parse(req.body);
    assert(Object.keys(body).length > 0, '请至少填写一项修改内容', 400);
    const nextBaseUrl = body.baseUrl?.trim().replace(/\/+$/, '') || connection.base_url;
    let credentials: NewApiCredentials | KeyManCredentials = isKeyMan(connection) ? decryptKeyManCredentials(box, connection.credentials) : decryptNewApiCredentials(box, connection.credentials);
    const nextAuth = body.authType || connection.auth_type;
    const nextAdapter = body.adapterType || connection.adapter_type || 'standard_new_api';
    const nextTenant = body.tenantId || connection.tenant_id || '1';
    if (body.authType || body.username !== undefined || body.password !== undefined || body.accessToken !== undefined || body.captchaVerification !== undefined) {
      credentials = nextAdapter === 'keyman_newapi'
        ? parseKeyManCredentials({ ...body, authType: nextAuth, tenantId: nextTenant, username: body.username ?? (credentials.kind === 'password' ? credentials.username : undefined), password: body.password ?? (credentials.kind === 'password' ? credentials.password : undefined), accessToken: body.accessToken ?? (credentials.kind === 'access_token' ? credentials.token : undefined), captchaVerification: body.captchaVerification ?? (credentials.kind === 'password' && 'captchaVerification' in credentials ? credentials.captchaVerification : undefined) }, nextTenant)
        : parseCredentials({ ...body, authType: nextAuth, username: body.username ?? (credentials.kind === 'password' ? credentials.username : undefined), password: body.password ?? (credentials.kind === 'password' ? credentials.password : undefined), accessToken: body.accessToken ?? (credentials.kind === 'access_token' ? credentials.token : undefined) });
    }
    let nextStatus = body.status || connection.status, quota = body.quotaPerUnit ?? connection.quota_per_unit;
    if (body.baseUrl || body.authType || body.adapterType || body.tenantId || body.username !== undefined || body.password !== undefined || body.accessToken !== undefined || body.captchaVerification !== undefined || body.quotaPerUnit !== undefined) {
      const client = nextAdapter === 'keyman_newapi' ? new KeyManClient(nextBaseUrl, credentials as KeyManCredentials) : new NewApiClient(nextBaseUrl, credentials as NewApiCredentials);
      await client.authenticate(); const current = nextAdapter === 'keyman_newapi' ? await (client as KeyManClient).status(quota ? Number(quota) : undefined) : await (client as NewApiClient).status(); quota = current.quotaPerUnit; nextStatus = 'connected';
    }
    const [updated] = await db.query(`UPDATE new_api_connections SET name=COALESCE($2,name),base_url=$3,auth_type=$4,credentials=$5,adapter_type=$6,tenant_id=$7,status=$8,quota_per_unit=$9,last_error=NULL WHERE id=$1 RETURNING *`, [connection.id, body.name ?? null, nextBaseUrl, nextAuth, box.encrypt(credentials), nextAdapter, nextTenant, nextStatus, quota]);
    await audit(db, req.user.id, 'key.new_api_connection.update', connection.id, { name: body.name, baseUrl: nextBaseUrl, authType: nextAuth, adapterType: nextAdapter, status: nextStatus });
    return { connection: normalizeConnection(updated) };
  });

  app.get('/api/key-tasks', async req => {
    const { workspace } = await assertMember(db, req.user); const rows = await db.query('SELECT * FROM key_tasks WHERE workspace_id=$1 ORDER BY created_at DESC', [workspace.id]);
    const visible = []; for (const task of rows) if (await visibleTask(db, task, req.user)) visible.push(await taskSummary(db, task, req.user));
    return { tasks: visible };
  });
  app.post('/api/key-tasks', async req => {
    await requireOwner(req.user); const { workspace } = await assertMember(db, req.user);
    const body = z.object({ connectionId: identifier, templateType: templateType.optional(), gatewayId: z.string().max(120).optional(), templateConfig: z.record(z.string(), z.unknown()).default({}), name: z.string().trim().min(1).max(120), resourceType: z.string().trim().min(1).max(80), provider: z.string().trim().min(1).max(80), models: z.array(z.string().trim().min(1).max(120)).min(1).max(100), description: z.string().max(2000).default(''), rootRate: rate.default(1) }).strict().parse(req.body);
    const connection = await getConnection(db, body.connectionId, workspace.id);
    const selectedTemplate = body.templateType || connection.adapter_type || 'standard_new_api';
    assert(selectedTemplate === (connection.adapter_type || 'standard_new_api'), '任务模板与连接适配器不匹配', 409);
    if (selectedTemplate === 'keyman_newapi') assert(body.gatewayId, 'KeyMan 任务必须选择网关', 400);
    const taskId = id(); const [task] = await db.query(`INSERT INTO key_tasks(id,workspace_id,new_api_connection_id,name,resource_type,provider,models,description,root_rate,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [taskId, workspace.id, body.connectionId, body.name, body.resourceType, body.provider, body.models, body.description, body.rootRate, req.user.id]);
    await db.query('UPDATE key_tasks SET template_type=$2,gateway_id=$3,template_config=$4 WHERE id=$1', [taskId, selectedTemplate, body.gatewayId ?? null, JSON.stringify(body.templateConfig)]);
    const [updated] = await db.query('SELECT * FROM key_tasks WHERE id=$1', [taskId]);
    await audit(db, req.user.id, 'key.task.create', taskId, { name: body.name, provider: body.provider, templateType: selectedTemplate }); return { task: updated || task };
  });
  app.patch('/api/key-tasks/:id', async req => {
    await requireOwner(req.user); const { workspace } = await assertMember(db, req.user); const task = await getTask(db, identifier.parse((req.params as Row).id), workspace.id);
    const body = z.object({ state: taskState.optional(), name: z.string().trim().min(1).max(120).optional(), description: z.string().max(2000).optional(), rootRate: rate.optional() }).strict().parse(req.body);
    const next = body.state ?? task.state;
    assert(body.rootRate === undefined || task.state === 'draft', '任务发布后管理员价格按任务价格记录冻结', 409);
    if (next === 'closed' && task.state !== 'closed' && ['published', 'paused'].includes(task.state)) await syncKeyTask(db, box, task.id);
    const [updated] = await db.query(`UPDATE key_tasks SET state=$2,name=COALESCE($3,name),description=COALESCE($4,description),root_rate=COALESCE($5,root_rate),
      published_at=CASE WHEN $2='published' AND published_at IS NULL THEN now() ELSE published_at END,
      closed_at=CASE WHEN $2='closed' THEN COALESCE(closed_at,now()) ELSE closed_at END,updated_at=now() WHERE id=$1 RETURNING *`, [task.id, next, body.name ?? null, body.description ?? null, body.rootRate ?? null]);
    await audit(db, req.user.id, 'key.task.update', task.id, { state: next }); return { task: updated };
  });
  app.post('/api/key-tasks/:id/rates', async req => {
    const { workspace } = await assertMember(db, req.user); const task = await getTask(db, identifier.parse((req.params as Row).id), workspace.id);
    const body = z.object({ userId: identifier, rate, effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict().parse(req.body);
    assert(task.state !== 'closed', '已关闭任务不能调整价格', 409);
    // The hierarchy check is the permission boundary: every supervisor may
    // price only a direct child, while the platform owner can price direct
    // members of the root team.
    await requireDirect(db, req.user, body.userId);
    const currentDay = today();
    const [current] = await db.query('SELECT id FROM task_rates WHERE task_id=$1 AND user_id=$2 AND effective_date<=$3 ORDER BY effective_date DESC LIMIT 1', [task.id, body.userId, currentDay]);
    const effectiveDate = body.effectiveDate ?? (current ? nextDay(currentDay) : currentDay);
    assert(effectiveDate >= currentDay, '任务价格生效日不能早于今天', 400);
    const [existing] = await db.query('SELECT id FROM task_rates WHERE task_id=$1 AND user_id=$2 AND effective_date=$3', [task.id, body.userId, effectiveDate]);
    assert(!existing || effectiveDate > currentDay, '已生效的任务价格不可修改，请从次日重新定价', 409);
    await db.query(`INSERT INTO task_rates(id,task_id,user_id,rate,effective_date,created_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(task_id,user_id,effective_date) DO UPDATE SET rate=EXCLUDED.rate,created_by=EXCLUDED.created_by,created_at=now()`, [id(), task.id, body.userId, body.rate, effectiveDate, req.user.id]);
    await audit(db, req.user.id, 'key.task_rate.update', task.id, { userId: body.userId, rate: body.rate, effectiveDate }); return { ok: true, effectiveDate };
  });
  app.get('/api/key-tasks/:id/rates', async req => {
    const { workspace } = await assertMember(db, req.user); const task = await getTask(db, identifier.parse((req.params as Row).id), workspace.id);
    assert(req.user.role === 'owner' || await canSubmitTask(db, task, req.user), '请先完成此任务报价', 403);
    const ids = req.user.role === 'owner' ? null : await subtree(db, req.user.id);
    return { rates: await db.query(`SELECT r.*,u.name AS user_name FROM task_rates r JOIN users u ON u.id=r.user_id WHERE r.task_id=$1 ${ids ? 'AND r.user_id=ANY($2::text[])' : ''} ORDER BY r.effective_date DESC,u.name`, ids ? [task.id, ids] : [task.id]) };
  });

  app.get('/api/key-tasks/:id/channels', async req => {
    const { workspace } = await assertMember(db, req.user); const task = await getTask(db, identifier.parse((req.params as Row).id), workspace.id);
    assert(req.user.role === 'owner' || await canSubmitTask(db, task, req.user), '请先完成此任务报价', 403);
    const ids = await subtree(db, req.user.id);
    const rows = await db.query(`SELECT c.id,c.task_id,c.supplier_user_id,u.name AS supplier_name,c.external_channel_id,c.token_masked,c.name,c.site,c.resource_type,c.models,c.status,c.used_quota,c.used_usd,c.last_sync_at,c.last_error,c.created_at,c.channel_type,c.base_url,c.groups,c.model_mapping,c.openai_organization,c.test_model,c.remark,c.socks5_proxy_level,c.auto_ban,c.settings,c.setting,c.param_override,c.other,c.status_code_mapping,c.multi_key_mode,c.key_mode
      FROM task_channels c JOIN users u ON u.id=c.supplier_user_id WHERE c.task_id=$1 AND c.supplier_user_id=ANY($2::text[]) ORDER BY c.created_at DESC`, [task.id, ids]);
    return { channels: rows };
  });
  app.post('/api/key-tasks/:id/models', async req => {
    const { workspace } = await assertMember(db, req.user); const task = await getTask(db, identifier.parse((req.params as Row).id), workspace.id);
    assert(await canSubmitTask(db, task, req.user), '请先完成此任务报价', 403);
    const body = z.object({ secret: keyValue, channelType: z.coerce.number().int().min(0).max(100).default(1), baseUrl: z.string().trim().max(500).optional() }).strict().parse(req.body);
    const connection = await getConnection(db, task.new_api_connection_id, workspace.id);
    assert(isKeyMan(connection), '只有 KeyMan 定制任务支持从上游拉取模型', 409);
    assert(task.gateway_id, 'KeyMan 任务未绑定网关', 409);
    const client = connectionClient(box, connection) as KeyManClient;
    await client.authenticate();
    const models = await client.fetchModels({ gatewayId: String(task.gateway_id || ''), type: body.channelType, key: body.secret, baseUrl: body.baseUrl });
    return { models };
  });
  app.post('/api/key-tasks/:id/channels', async req => {
    const { workspace } = await assertMember(db, req.user); const task = await getTask(db, identifier.parse((req.params as Row).id), workspace.id);
    assert(task.state === 'published', '此任务当前不接受 Key', 409); assert(await canSubmitTask(db, task, req.user), '请先完成此任务报价', 403);
    const body = z.object({
      secret: keyValue.optional(), secrets: z.array(keyValue).max(100).optional(), keys: z.array(keyValue).max(100).optional(),
      name: z.string().trim().max(120).default(''), site: z.string().trim().max(120).default(''), models: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
      channelType: z.coerce.number().int().min(0).max(100).default(1), baseUrl: z.string().trim().max(500).default(''), groups: z.array(z.string().trim().min(1).max(80)).max(50).default(['default']),
      modelMapping: z.record(z.string(), z.string()).default({}), openaiOrganization: z.string().max(200).default(''), testModel: z.string().max(200).default(''), remark: z.string().max(1000).default(''),
      socks5ProxyLevel: z.enum(['low','medium','high']).default('medium'), autoBan: z.boolean().default(true), settings: z.union([z.string(), z.record(z.string(), z.unknown())]).default({}), setting: z.union([z.string(), z.record(z.string(), z.unknown())]).default({}),
      paramOverride: z.string().max(10000).default(''), other: z.string().max(10000).default(''), statusCodeMapping: z.string().max(10000).default(''), multiKeyMode: z.string().max(40).optional(), keyMode: z.string().max(40).optional(),
      idempotencyKey: identifier.optional()
    }).strict().parse(req.body);
    const submitted = [body.secret, ...(body.secrets || []), ...(body.keys || [])].filter((value): value is string => !!value);
    assert(submitted.length > 0, '请至少填写一个 API Key', 400);
    assert(submitted.length <= 100, '单次最多提交 100 个 API Key', 400);
    const connection = await getConnection(db, task.new_api_connection_id, workspace.id); const client = connectionClient(box, connection);
    const keyman = isKeyMan(connection);
    if (keyman) assert(task.gateway_id, 'KeyMan 任务未绑定网关', 409);
    const models = body.models.length ? body.models : task.models;
    const config: KeyManChannelInput = { gatewayId: String(task.gateway_id || ''), key: '', name: '', type: body.channelType, baseUrl: body.baseUrl, models, groups: body.groups, modelMapping: body.modelMapping, openaiOrganization: body.openaiOrganization, testModel: body.testModel, remark: body.remark, autoBan: body.autoBan, settings: body.settings, setting: body.setting, paramOverride: body.paramOverride, other: body.other, statusCodeMapping: body.statusCodeMapping, multiKeyMode: body.multiKeyMode, keyMode: body.keyMode };
    const channels = [];
    for (let index = 0; index < submitted.length; index++) {
      const secret = submitted[index]; const fp = fingerprint(secret); const requestKey = body.idempotencyKey ? `${body.idempotencyKey}:${index}` : undefined;
      if (requestKey) {
        const [sameRequest] = await db.query(`SELECT id,task_id,supplier_user_id,external_channel_id,token_masked,name,site,resource_type,models,status,used_quota,used_usd,last_sync_at,last_error,created_at,fingerprint FROM task_channels WHERE task_id=$1 AND supplier_user_id=$2 AND idempotency_key=$3`, [task.id, req.user.id, requestKey]);
        if (sameRequest) { assert(sameRequest.fingerprint === fp, '此请求编号已用于另一笔 Key 提交', 409); const { fingerprint: _fingerprint, ...channel } = sameRequest; channels.push(channel); continue; }
      }
      const [existing] = await db.query('SELECT id FROM task_channels WHERE task_id=$1 AND fingerprint=$2 AND status<>\'deleted\'', [task.id, fp]); assert(!existing, '此 Key 已提交到当前任务', 409);
      const name = body.name || `${task.name} · ${req.user.name}${submitted.length > 1 ? ` · ${index + 1}` : ''}`;
      const remote = keyman
        ? await (client as KeyManClient).createChannel({ ...config, key: secret, name })
        : await (client as NewApiClient).createChannel({ key: secret, name, models, baseUrl: body.baseUrl || undefined, group: body.groups[0] });
      const channelId = id(); const [channel] = await db.query(`INSERT INTO task_channels(id,task_id,supplier_user_id,secret,fingerprint,token_masked,external_channel_id,name,site,resource_type,models,status,idempotency_key,channel_type,base_url,groups,model_mapping,openai_organization,test_model,remark,socks5_proxy_level,auto_ban,settings,setting,param_override,other,status_code_mapping,multi_key_mode,key_mode)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING id,task_id,supplier_user_id,external_channel_id,token_masked,name,site,resource_type,models,status,used_quota,used_usd,last_sync_at,last_error,created_at,channel_type,base_url,groups,model_mapping,openai_organization,test_model,remark,socks5_proxy_level,auto_ban,settings,setting,param_override,other,status_code_mapping,multi_key_mode,key_mode`,
        [channelId, task.id, req.user.id, box.encrypt({ secret }), fp, masked(secret), remote.id, name, body.site, task.resource_type, models, requestKey ?? null, body.channelType, body.baseUrl, body.groups, JSON.stringify(body.modelMapping), body.openaiOrganization, body.testModel, body.remark, body.socks5ProxyLevel, body.autoBan, typeof body.settings === 'string' ? body.settings : JSON.stringify(body.settings), typeof body.setting === 'string' ? body.setting : JSON.stringify(body.setting), body.paramOverride, body.other, body.statusCodeMapping, body.multiKeyMode ?? null, body.keyMode ?? null]);
      await audit(db, req.user.id, 'key.channel.create', channelId, { taskId: task.id, externalChannelId: remote.id, adapterType: connection.adapter_type }); channels.push(channel);
    }
    return { channel: channels[0], channels };
  });
  app.patch('/api/key-channels/:id', async req => {
    const { workspace } = await assertMember(db, req.user); const channelId = identifier.parse((req.params as Row).id);
    const [channel] = await db.query(`SELECT c.*,t.workspace_id,t.new_api_connection_id,t.gateway_id,t.state AS task_state FROM task_channels c JOIN key_tasks t ON t.id=c.task_id WHERE c.id=$1 AND t.workspace_id=$2`, [channelId, workspace.id]);
    assert(channel, 'Key 渠道不存在', 404); assert(req.user.role === 'owner' || channel.supplier_user_id === req.user.id, '只能管理自己的 Key 渠道', 403);
    const body = z.object({ state: z.enum(['active','paused','deleted']).optional(), secret: keyValue.optional() }).strict().parse(req.body);
    const connection = await getConnection(db, channel.new_api_connection_id, workspace.id); const client = connectionClient(box, connection);
    if (body.secret && channel.external_channel_id) {
      const nextFingerprint = fingerprint(body.secret);
      const [duplicate] = await db.query('SELECT id FROM task_channels WHERE task_id=$1 AND fingerprint=$2 AND id<>$3 AND status<>\'deleted\'', [channel.task_id, nextFingerprint, channel.id]);
      assert(!duplicate, '此 Key 已提交到当前任务', 409);
      if (isKeyMan(connection)) await (client as KeyManClient).updateChannel(channel.external_channel_id, {
        id: channel.external_channel_id, gatewayId: channel.gateway_id || undefined, key: body.secret, type: channel.channel_type || 1,
        name: channel.name, baseUrl: channel.base_url, models: channel.models || [], groups: channel.groups || ['default'],
        modelMapping: parseJsonText(channel.model_mapping, '模型重定向'), openaiOrganization: channel.openai_organization,
        testModel: channel.test_model, remark: channel.remark, autoBan: channel.auto_ban, settings: channel.settings, setting: channel.setting,
        paramOverride: channel.param_override, other: channel.other, statusCodeMapping: channel.status_code_mapping,
      });
      else await (client as NewApiClient).updateChannel(channel.external_channel_id, { key: body.secret });
      await db.query('UPDATE task_channels SET secret=$2,fingerprint=$3,token_masked=$4 WHERE id=$1', [channel.id, box.encrypt({ secret: body.secret }), nextFingerprint, masked(body.secret)]);
    }
    if (body.state && channel.external_channel_id) {
      if (isKeyMan(connection)) {
        if (body.state === 'deleted') await (client as KeyManClient).deleteChannel(String(channel.gateway_id), channel.external_channel_id);
        else await (client as KeyManClient).setChannelStatus(String(channel.gateway_id), channel.external_channel_id, body.state === 'active' ? 1 : 2);
      } else if (body.state !== 'deleted') await (client as NewApiClient).setChannelStatus(channel.external_channel_id, body.state === 'active' ? 1 : 0);
    }
    const [updated] = await db.query(`UPDATE task_channels SET status=COALESCE($2,status),last_error=NULL WHERE id=$1 RETURNING id,task_id,supplier_user_id,external_channel_id,token_masked,name,site,resource_type,models,status,used_quota,used_usd,last_sync_at,last_error,created_at`, [channel.id, body.state ?? null]);
    await audit(db, req.user.id, 'key.channel.update', channel.id, { state: body.state, rotated: !!body.secret }); return { channel: updated };
  });

  app.post('/api/key-channels/:id/test', async req => {
    const { workspace } = await assertMember(db, req.user); const channelId = identifier.parse((req.params as Row).id);
    const [channel] = await db.query(`SELECT c.*,t.workspace_id,t.new_api_connection_id,t.gateway_id FROM task_channels c JOIN key_tasks t ON t.id=c.task_id WHERE c.id=$1 AND t.workspace_id=$2`, [channelId, workspace.id]);
    assert(channel, 'Key 渠道不存在', 404); assert(req.user.role === 'owner' || channel.supplier_user_id === req.user.id, '只能测试自己的 Key 渠道', 403);
    const connection = await getConnection(db, channel.new_api_connection_id, workspace.id); const client = connectionClient(box, connection);
    try {
      if (isKeyMan(connection)) await (client as KeyManClient).testChannel(String(channel.gateway_id), channel.external_channel_id, channel.test_model || undefined);
      else await (client as NewApiClient).testChannel(channel.external_channel_id);
      const [updated] = await db.query(`UPDATE task_channels SET status='active',last_error=NULL,last_sync_at=now() WHERE id=$1 RETURNING id,status,last_sync_at,last_error`, [channel.id]);
      return { ok: true, channel: updated };
    } catch (error) {
      const message = error instanceof Error ? error.message : '渠道测试失败';
      await db.query(`UPDATE task_channels SET status='error',last_error=$2,last_sync_at=now() WHERE id=$1`, [channel.id, message]);
      throw error;
    }
  });

  app.post('/api/key-tasks/:id/sync', async req => {
    await requireOwner(req.user); const { workspace } = await assertMember(db, req.user); const task = await getTask(db, identifier.parse((req.params as Row).id), workspace.id);
    return syncKeyTask(db, box, task.id);
  });
  app.get('/api/key-usage', async req => {
    const { workspace } = await assertMember(db, req.user); const q = z.object({ taskId: identifier.optional(), page: z.coerce.number().int().min(1).default(1) }).parse(req.query); const ids = await subtree(db, req.user.id);
    const params: any[] = [workspace.id, ids]; let taskFilter = '';
    if (q.taskId) { params.push(q.taskId); taskFilter += ` AND c.task_id=$${params.length}`; }
    if (req.user.role !== 'owner') {
      params.push(req.user.id, today());
      taskFilter += ` AND t.state IN ('published','paused') AND EXISTS(
        SELECT 1 FROM task_rates visible_rate WHERE visible_rate.task_id=t.id AND visible_rate.user_id=$${params.length - 1}
          AND visible_rate.effective_date<=$${params.length})`;
    }
    const rows = await db.query(`SELECT c.id AS channel_id,c.task_id,t.name AS task_name,c.token_masked,c.status,c.used_quota,c.used_usd,c.last_sync_at,c.last_error,u.name AS supplier_name
    FROM task_channels c JOIN key_tasks t ON t.id=c.task_id JOIN users u ON u.id=c.supplier_user_id WHERE t.workspace_id=$1 AND c.supplier_user_id=ANY($2::text[]) AND c.status<>'deleted' ${taskFilter} ORDER BY c.used_usd DESC,c.created_at DESC LIMIT 1000`, params);
    const [totals] = await db.query(`SELECT COALESCE(sum(c.used_usd),0) AS used_usd,count(*)::int AS channels FROM task_channels c JOIN key_tasks t ON t.id=c.task_id WHERE t.workspace_id=$1 AND c.supplier_user_id=ANY($2::text[]) AND c.status<>'deleted' ${taskFilter}`, params);
    return { rows, totals, page: q.page, generatedAt: new Date().toISOString(), refreshSeconds: 300 };
  });
  app.get('/api/key-settlements', async req => {
    await assertMember(db, req.user); const rows = await db.query(`SELECT e.*,s.observed_at,c.token_masked,c.task_id,t.name AS task_name FROM task_settlement_entries e
      JOIN task_usage_snapshots s ON s.id=e.snapshot_id JOIN task_channels c ON c.id=s.channel_id JOIN key_tasks t ON t.id=c.task_id
      WHERE e.user_id=$1 ORDER BY e.created_at DESC LIMIT 500`, [req.user.id]);
    const [total] = await db.query('SELECT COALESCE(sum(profit_usd),0) AS profit_usd FROM task_settlement_entries WHERE user_id=$1', [req.user.id]);
    return { rows, total: total.profit_usd };
  });
}
