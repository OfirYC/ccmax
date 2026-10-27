import { AppError, assert, type SecretBox } from './core.js';

export type NewApiCredentials =
  | { kind: 'access_token'; token: string }
  | { kind: 'password'; username: string; password: string };

export type NewApiChannel = {
  id: string;
  name: string;
  key?: string;
  keyMasked?: string;
  baseUrl?: string;
  models: string[];
  status: number;
  usedQuota: number | null;
  balance?: number;
  type?: number;
  group?: string;
  tag?: string;
  raw: any;
};

type RequestOptions = RequestInit & { allowError?: boolean };

const timeoutMs = 15000;
const trimUrl = (url: string) => url.trim().replace(/\/+$/, '');

function apiError(status: number, message: string) {
  return new AppError(status >= 500 ? 502 : status, `New API：${message}`, 'NEW_API_ERROR');
}

function payloadData(value: any): any {
  if (value && typeof value === 'object' && 'data' in value) return value.data;
  return value;
}

function parseModels(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(/[\n,]/).map(v => v.trim()).filter(Boolean);
  return [];
}

function toChannel(value: any): NewApiChannel {
  const raw = value?.channel ?? value ?? {};
  const quota = raw.used_quota ?? raw.usedQuota ?? raw.UsedQuota;
  return {
    id: String(raw.id ?? raw.Id ?? ''),
    name: String(raw.name ?? raw.Name ?? ''),
    key: raw.key ?? raw.Key,
    keyMasked: raw.key_masked ?? raw.keyMasked ?? raw.key,
    baseUrl: raw.base_url ?? raw.baseUrl,
    models: parseModels(raw.models ?? raw.Models),
    status: Number(raw.status ?? raw.Status ?? 0),
    usedQuota: quota === undefined || quota === null || quota === '' ? null : Number(quota),
    balance: raw.balance === undefined ? undefined : Number(raw.balance),
    type: raw.type === undefined ? undefined : Number(raw.type),
    group: raw.group,
    tag: raw.tag,
    raw,
  };
}

export class NewApiClient {
  readonly baseUrl: string;
  private cookie = '';
  private authenticated = false;

  constructor(baseUrl: string, private credentials: NewApiCredentials) {
    this.baseUrl = trimUrl(baseUrl);
    const parsed = new URL(this.baseUrl);
    assert(['http:', 'https:'].includes(parsed.protocol), 'New API 地址必须使用 HTTP 或 HTTPS', 400);
  }

  private async request(path: string, options: RequestOptions = {}): Promise<any> {
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (this.credentials.kind === 'access_token') headers.set('Authorization', `Bearer ${this.credentials.token}`);
    if (this.cookie) headers.set('Cookie', this.cookie);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...options, headers, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      const message = error instanceof Error && error.name === 'AbortError' ? '请求超时' : '连接失败';
      throw apiError(502, message);
    }
    clearTimeout(timer);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(',').map(v => v.split(';')[0]).join('; ');
    const text = await response.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 500) }; }
    if (!response.ok) {
      if (options.allowError) return body;
      throw apiError(response.status, body?.message || body?.error || `HTTP ${response.status}`);
    }
    if (body && body.success === false) throw apiError(400, body.message || '操作失败');
    if (body && body.code === false) throw apiError(400, body.message || '操作失败');
    return body;
  }

  async authenticate() {
    if (this.credentials.kind === 'password') {
      const result = await this.request('/api/user/login', {
        method: 'POST',
        body: JSON.stringify({ username: this.credentials.username, password: this.credentials.password }),
      });
      if (result?.success === false || result?.code === false) throw apiError(401, '管理员账号或密码错误');
    }
    // /api/status is public, but a protected channel read proves the supplied
    // access token or password has enough administrator permissions.
    await this.listChannels();
    this.authenticated = true;
  }

  async status(): Promise<{ quotaPerUnit: number; raw: any }> {
    const result = await this.request('/api/status');
    const data = payloadData(result) || {};
    const quotaPerUnit = Number(data.quota_per_unit ?? data.quotaPerUnit ?? data.data?.quota_per_unit);
    assert(Number.isFinite(quotaPerUnit) && quotaPerUnit > 0, '缺少有效的 quota_per_unit', 502);
    return { quotaPerUnit, raw: result };
  }

  async listChannels(): Promise<NewApiChannel[]> {
    const result = await this.request('/api/channel/?page=1&page_size=1000');
    const data = payloadData(result);
    const list = Array.isArray(data) ? data : data?.items ?? data?.list ?? data?.channels ?? result?.items ?? [];
    return Array.isArray(list) ? list.map(toChannel).filter(row => row.id) : [];
  }

  async createChannel(input: { key: string; name: string; models: string[]; baseUrl?: string; group?: string }) {
    const result = await this.request('/api/channel/', {
      method: 'POST',
      body: JSON.stringify({ type: 0, key: input.key, name: input.name, models: input.models.join(','), base_url: input.baseUrl || '', group: input.group || 'default', status: 1 }),
    });
    const data = payloadData(result);
    const channel = toChannel(data?.channel ?? data);
    assert(channel.id, '创建渠道后未返回渠道 ID', 502);
    return channel;
  }

  async updateChannel(channelId: string, input: { key?: string; name?: string; models?: string[]; status?: number }) {
    const result = await this.request('/api/channel/', {
      method: 'PUT',
      body: JSON.stringify({ id: Number(channelId) || channelId, ...(input.key === undefined ? {} : { key: input.key }), ...(input.name === undefined ? {} : { name: input.name }), ...(input.models === undefined ? {} : { models: input.models.join(',') }), ...(input.status === undefined ? {} : { status: input.status }) }),
    });
    return toChannel(payloadData(result)?.channel ?? payloadData(result));
  }

  async setChannelStatus(channelId: string, status: number) {
    // New API releases generally update status through the channel editor;
    // older deployments exposed a dedicated status endpoint. Keep both
    // formats compatible so pause/resume works across supported versions.
    try {
      return await this.updateChannel(channelId, { status });
    } catch (error) {
      if (error instanceof AppError && error.statusCode < 500) {
        return this.request(`/api/channel/${encodeURIComponent(channelId)}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      }
      throw error;
    }
  }

  async testChannel(channelId: string) {
    return this.request(`/api/channel/test/${encodeURIComponent(channelId)}`);
  }

  async syncChannelBalance(channelId: string) {
    await this.request(`/api/channel/update_balance/${encodeURIComponent(channelId)}`, { allowError: true });
    const channels = await this.listChannels();
    return channels.find(channel => channel.id === String(channelId)) || null;
  }
}

export function decryptNewApiCredentials(box: SecretBox, encrypted: string): NewApiCredentials {
  const value = box.decrypt<NewApiCredentials>(encrypted);
  assert(value && (value.kind === 'access_token' || value.kind === 'password'), 'New API 凭据格式无效', 500);
  return value;
}
