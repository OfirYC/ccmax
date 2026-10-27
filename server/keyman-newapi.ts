import { AppError, assert } from './core.js';
import type { NewApiChannel } from './new-api.js';

/** Credentials used by the KeyMan/Yudao admin API.  The tenant is part of
 * the account boundary, so it is sent on every request and never exposed to
 * supplier members. */
export type KeyManCredentials =
  | { kind: 'access_token'; token: string; tenantId?: string }
  | { kind: 'password'; username: string; password: string; tenantId?: string; captchaVerification?: string };

export type KeyManGateway = { id: string; name: string; status?: number; raw: any };

export type KeyManChannelInput = {
  gatewayId: string;
  key: string;
  name: string;
  type?: number;
  baseUrl?: string;
  models?: string[];
  groups?: string[];
  modelMapping?: Record<string, string>;
  openaiOrganization?: string;
  testModel?: string;
  remark?: string;
  autoBan?: boolean;
  settings?: string | Record<string, unknown>;
  setting?: string | Record<string, unknown>;
  paramOverride?: string;
  other?: string;
  statusCodeMapping?: string;
  multiKeyMode?: string;
  keyMode?: string;
};

type RequestOptions = RequestInit & { allowError?: boolean };
const timeoutMs = 20000;
const trimUrl = (url: string) => url.trim().replace(/\/+$/, '');

function apiError(status: number, message: string) {
  return new AppError(status >= 500 ? 502 : status, `KeyMan：${message}`, 'KEYMAN_API_ERROR');
}

function dataOf(value: any): any {
  if (value && typeof value === 'object' && 'data' in value) return value.data;
  return value;
}

function modelsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(/[\n,]/).map(v => v.trim()).filter(Boolean);
  return [];
}

function channelOf(value: any): NewApiChannel {
  const raw = value?.channel ?? value ?? {};
  const quota = raw.usedQuota ?? raw.used_quota ?? raw.todayQuota ?? raw.quota;
  return {
    id: String(raw.id ?? raw.channelId ?? ''),
    name: String(raw.name ?? raw.namePreview ?? ''),
    key: raw.key,
    keyMasked: raw.keyMasked ?? raw.key_masked ?? raw.key,
    baseUrl: raw.baseUrl ?? raw.base_url,
    models: modelsOf(raw.models),
    status: Number(raw.status ?? 0),
    usedQuota: quota === undefined || quota === null || quota === '' ? null : Number(quota),
    balance: raw.balance === undefined ? undefined : Number(raw.balance),
    type: raw.type === undefined ? undefined : Number(raw.type),
    group: Array.isArray(raw.groups) ? raw.groups[0] : raw.group,
    tag: raw.remark,
    raw,
  };
}

function normalizeTenant(value: string | undefined) {
  const tenant = (value || '1').trim();
  assert(/^[0-9]+$/.test(tenant), 'KeyMan 租户 ID 必须是数字', 400);
  return tenant;
}

/** Adapter for KeyMan's Yudao admin API. It deliberately implements the
 * subset used by the key-market service so standard New API code can share
 * the same sync and settlement pipeline. */
export class KeyManClient {
  readonly baseUrl: string;
  private accessToken = '';
  private refreshToken = '';
  private authenticated = false;
  readonly tenantId: string;

  constructor(baseUrl: string, private credentials: KeyManCredentials) {
    let normalized = trimUrl(baseUrl);
    // Operators often paste the public SPA URL. The API is hosted separately.
    try {
      const parsed = new URL(normalized);
      if (parsed.hostname === 'keyman.xkk.io') normalized = 'https://kapi.xkk.io/admin-api';
      else if (!parsed.pathname.endsWith('/admin-api') && parsed.hostname === 'kapi.xkk.io') normalized += '/admin-api';
    } catch { /* request() will return a useful validation error below */ }
    this.baseUrl = trimUrl(normalized);
    const parsed = new URL(this.baseUrl);
    assert(['http:', 'https:'].includes(parsed.protocol), 'KeyMan 地址必须使用 HTTP 或 HTTPS', 400);
    this.tenantId = normalizeTenant(credentials.tenantId);
  }

  private headers(options: RequestOptions = {}) {
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    headers.set('tenant-id', this.tenantId);
    headers.set('visit-tenant-id', this.tenantId);
    if (this.accessToken) headers.set('Authorization', `Bearer ${this.accessToken}`);
    return headers;
  }

  private async request(path: string, options: RequestOptions = {}, retry = true): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...options, headers: this.headers(options), signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      throw apiError(502, error instanceof Error && error.name === 'AbortError' ? '请求超时' : '连接失败');
    }
    clearTimeout(timer);
    const text = await response.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { msg: text.slice(0, 500) }; }
    const code = Number(body?.code);
    if (retry && (response.status === 401 || code === 401 || code === 401000000)) {
      if (this.refreshToken) {
        try {
          const refreshed = await this.request(`/system/auth/refresh-token?refreshToken=${encodeURIComponent(this.refreshToken)}`, { method: 'POST' }, false);
          const token = dataOf(refreshed)?.accessToken;
          if (token) { this.accessToken = String(token); return this.request(path, options, false); }
        } catch { /* fall through to the original auth error */ }
      }
      this.authenticated = false;
    }
    if (!response.ok || (body && body.code !== undefined && body.code !== 0 && body.code !== 200)) {
      if (options.allowError) return body;
      throw apiError(response.status || 400, body?.msg || body?.message || body?.error || `HTTP ${response.status}`);
    }
    return body;
  }

  async authenticate() {
    if (this.credentials.kind === 'password') {
      const result = await this.request('/system/auth/login', {
        method: 'POST',
        // KeyMan currently enables captcha for some tenants. A browser-issued
        // verification value can be supplied without storing an image or a
        // password outside the encrypted connection record.
        headers: { isEncrypt: 'false' },
        body: JSON.stringify({ username: this.credentials.username, password: this.credentials.password, ...(this.credentials.captchaVerification ? { captchaVerification: this.credentials.captchaVerification } : {}) }),
      });
      const data = dataOf(result) || {};
      assert(data.accessToken, 'KeyMan 登录失败：请提供有效的验证码串或管理访问令牌', 401);
      this.accessToken = String(data.accessToken);
      this.refreshToken = data.refreshToken ? String(data.refreshToken) : '';
    } else {
      this.accessToken = this.credentials.token;
    }
    await this.listGateways();
    this.authenticated = true;
  }

  async listGateways(): Promise<KeyManGateway[]> {
    const result = await this.request('/newapi/gateway/simple-list');
    const data = dataOf(result);
    const list = Array.isArray(data) ? data : data?.list ?? data?.items ?? [];
    return Array.isArray(list) ? list.map((raw: any) => ({ id: String(raw.id ?? raw.gatewayId ?? ''), name: String(raw.name ?? raw.title ?? raw.id ?? ''), status: raw.status === undefined ? undefined : Number(raw.status), raw })).filter(row => row.id) : [];
  }

  async status(fallbackQuotaPerUnit?: number): Promise<{ quotaPerUnit: number; raw: any }> {
    const gateways = await this.listGateways();
    let raw: any = gateways[0]?.raw || {};
    if (gateways[0]) {
      const result = await this.request(`/newapi/channel/console-status?gatewayId=${encodeURIComponent(gateways[0].id)}`, { allowError: true });
      raw = dataOf(result) || raw;
    }
    const quota = Number(raw.quota_per_unit ?? raw.quotaPerUnit ?? raw.quotaUnit ?? raw.quotaUnitValue ?? fallbackQuotaPerUnit);
    assert(Number.isFinite(quota) && quota > 0, 'KeyMan 缺少有效的额度换算单位，请在连接中填写 quota_per_unit', 502);
    return { quotaPerUnit: quota, raw };
  }

  async listChannels(gatewayId: string): Promise<NewApiChannel[]> {
    const result = await this.request(`/newapi/channel/page?gatewayId=${encodeURIComponent(gatewayId)}&pageNo=1&pageSize=1000`);
    const data = dataOf(result);
    const list = Array.isArray(data) ? data : data?.list ?? data?.items ?? data?.records ?? [];
    return Array.isArray(list) ? list.map(channelOf).filter(row => row.id) : [];
  }

  async createChannel(input: KeyManChannelInput): Promise<NewApiChannel> {
    const payload: Record<string, unknown> = {
      gatewayId: input.gatewayId,
      type: input.type ?? 1,
      name: input.name,
      keys: [input.key],
      keyMode: input.keyMode,
      multiKeyMode: input.multiKeyMode,
      baseUrl: input.baseUrl || undefined,
      models: input.models || [],
      groups: input.groups?.length ? input.groups : ['default'],
      modelMapping: input.modelMapping && Object.keys(input.modelMapping).length ? JSON.stringify(input.modelMapping) : '',
      openaiOrganization: input.openaiOrganization || undefined,
      testModel: input.testModel || undefined,
      remark: input.remark || undefined,
      autoBan: input.autoBan === false ? 0 : 1,
      settings: typeof input.settings === 'string' ? input.settings : JSON.stringify(input.settings || {}),
      setting: typeof input.setting === 'string' ? input.setting : JSON.stringify(input.setting || {}),
      paramOverride: input.paramOverride || '',
      other: input.other || '',
      statusCodeMapping: input.statusCodeMapping || '',
    };
    const result = await this.request('/newapi/channel/create', { method: 'POST', body: JSON.stringify(payload) });
    const data = dataOf(result);
    let channel = channelOf(data?.channel ?? data);
    if (!channel.id) {
      // A few older KeyMan builds return only `{success:true}`. Resolve the
      // newly created row by its unique display name before giving up.
      const rows = await this.listChannels(input.gatewayId);
      channel = rows.find(row => row.name === input.name) || channel;
    }
    assert(channel.id, 'KeyMan 创建渠道后未返回渠道 ID', 502);
    return channel;
  }

  async updateChannel(channelId: string, input: Partial<KeyManChannelInput> & { id?: string }) {
    const { key, gatewayId, ...rest } = input;
    const payload = { ...rest, id: input.id || channelId, gatewayId, ...(key === undefined ? {} : { keys: [key] }) };
    const result = await this.request('/newapi/channel/update', { method: 'PUT', body: JSON.stringify(payload) });
    return channelOf(dataOf(result)?.channel ?? dataOf(result));
  }

  async setChannelStatus(gatewayId: string, channelId: string, status: number) {
    const result = await this.request('/newapi/channel/update-status', { method: 'PUT', body: JSON.stringify({ gatewayId, id: channelId, status }) });
    return dataOf(result);
  }

  async deleteChannel(gatewayId: string, channelId: string) {
    return this.request(`/newapi/channel/delete?gatewayId=${encodeURIComponent(gatewayId)}&id=${encodeURIComponent(channelId)}`, { method: 'DELETE' });
  }

  async testChannel(gatewayId: string, channelId: string, model?: string) {
    return this.request(`/newapi/channel/test?gatewayId=${encodeURIComponent(gatewayId)}&id=${encodeURIComponent(channelId)}${model ? `&model=${encodeURIComponent(model)}` : ''}`);
  }

  async channelStat(gatewayId: string, channelId: string) {
    const result = await this.request(`/newapi/channel/stat?gatewayId=${encodeURIComponent(gatewayId)}&channelId=${encodeURIComponent(channelId)}`, { allowError: true });
    return dataOf(result);
  }

  async syncChannelBalance(gatewayId: string, channelId: string) {
    const rows = await this.listChannels(gatewayId);
    const row = rows.find(channel => channel.id === String(channelId));
    if (row && row.usedQuota !== null) return row;
    const stat = await this.channelStat(gatewayId, channelId);
    if (!row || !stat) return row || null;
    const raw = stat.channel ?? stat;
    const quota = raw.usedQuota ?? raw.used_quota ?? raw.totalQuota ?? raw.quota;
    if (quota !== undefined && quota !== null) row.usedQuota = Number(quota);
    return row;
  }

  async fetchModels(input: { gatewayId: string; type: number; key: string; baseUrl?: string }) {
    const result = await this.request('/newapi/channel/fetch-models', { method: 'POST', body: JSON.stringify(input) });
    const data = dataOf(result);
    return modelsOf(Array.isArray(data) ? data : data?.models ?? data?.list ?? []);
  }
}
