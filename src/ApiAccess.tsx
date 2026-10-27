import { useState } from 'react';
import { BookOpen, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { api, post, useData } from './api';
import { Badge, Empty, ErrorBox, Field, Form, Loading, Modal, Submit, Table, useToast } from './components';
import { getLocale, t } from './i18n';
import { useLocale } from './LanguageSwitcher';
import type { ApiScope } from '../shared/integration';

type Key = { id: string; name: string; prefix: string; scopes: ApiScope[]; expires_at: string; revoked_at: string | null; last_used_at: string | null };
type KeyData = { keys: Key[]; baseUrl: string; maxActiveKeys: number };
const scopeNames: Record<ApiScope, string> = { read: '读取团队数据', 'team:write': '管理直属下级与定价', 'accounts:write': '管理账号、代理与上号', 'finance:write': '操作账单与提现', 'key:write': '提交和管理 Key 渠道' };
const scopes = Object.keys(scopeNames) as ApiScope[];
const date = (value: string) => new Date(value).toLocaleDateString(getLocale(), { timeZone: 'Asia/Shanghai' });

export default function ApiAccess() {
  useLocale();
  const { data, error, loading, refresh } = useData<KeyData>('/api/settings/api-keys');
  const toast = useToast();
  const [creating, setCreating] = useState(false), [issued, setIssued] = useState(''), [revoking, setRevoking] = useState<Key | null>(null);
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); toast(t('已复制')); }
    catch { toast(t('无法自动复制，请手动选择并复制'), 'error'); }
  }
  return <section className="panel api-access">
    <div className="panel-head"><div><h2>{t('API 接入')}</h2><p>{t('让你自己的后端对接账号、团队、用量和结算服务。')}</p></div><KeyRound size={20} className="muted"/></div>
    <div className="api-access-body">
      <p className="api-description">{t('API 密钥继承当前账号的数据范围，默认只读。请仅保存在自己的后端服务器。')}</p>
      <ErrorBox error={error}/>
      {data && <>
        <div className="api-base"><Field label={t('API 基础地址')}><input readOnly value={data.baseUrl} onFocus={event => event.target.select()}/></Field><button className="button" onClick={() => copy(data.baseUrl)}><Copy size={15}/>{t('复制地址')}</button></div>
        <div className="api-toolbar"><div className="actions"><a className="button" href="/api/docs" target="_blank" rel="noreferrer"><BookOpen size={15}/>{t('接入文档')}</a><a className="button" href="/api/openapi.json" download="ccmax-openapi.json">{t('下载 OpenAPI')}</a></div><button className="button primary" onClick={() => setCreating(true)} disabled={data.keys.filter(key => !key.revoked_at && new Date(key.expires_at).getTime() > Date.now()).length >= data.maxActiveKeys}><Plus size={15}/>{t('创建 API 密钥')}</button></div>
        <p className="form-hint">{t('每个账号最多 10 个有效密钥。修改或重置密码会撤销该账号的全部密钥。财务权限可申请提现和确认结算，请按需开启。')}</p>
      </>}
    </div>
    {loading ? <Loading/> : data?.keys.length ? <Table headers={[t('密钥名称'), t('权限'), t('到期日期'), t('最近使用'), t('状态'), t('操作')]}>{data.keys.map(key => {
      const state = key.revoked_at ? 'revoked' : new Date(key.expires_at).getTime() <= Date.now() ? 'expired' : 'active';
      return <tr key={key.id}><td><strong>{key.name}</strong><small className="mono">{key.prefix}…</small></td><td className="api-scopes">{key.scopes.map(scope => <span key={scope}>{t(scopeNames[scope])}</span>)}</td><td>{date(key.expires_at)}</td><td>{key.last_used_at ? date(key.last_used_at) : t('尚未使用')}</td><td><Badge state={state === 'active' ? 'active' : 'disabled'} label={t(state === 'active' ? '有效' : state === 'revoked' ? '已撤销' : '已过期')}/></td><td>{state === 'active' && <button className="button" onClick={() => setRevoking(key)}><Trash2 size={13}/>{t('撤销')}</button>}</td></tr>;
    })}</Table> : !error && <Empty title={t('暂无 API 密钥')} detail={t('创建一个密钥，即可开始对接你的网站。')}/>}
    {creating && <Modal title={t('创建 API 密钥')} subtitle={t('选择所需权限，并使用当前登录密码确认。')} onClose={() => setCreating(false)}><Form onSubmit={async form => {
      const result = await post<{ token: string }>('/api/settings/api-keys', { name: form.get('name'), scopes: ['read', ...form.getAll('scopes')], expiresInDays: Number(form.get('expiresInDays')), currentPassword: form.get('currentPassword') });
      setCreating(false); setIssued(result.token); await refresh();
    }}><Field label={t('密钥名称')} hint={t('例如：我的网站后端')}><input name="name" required maxLength={80} autoComplete="off"/></Field><fieldset className="api-permissions"><legend>{t('权限')}</legend>{scopes.map(scope => <label className="check-row" key={scope}><input type="checkbox" name="scopes" value={scope} defaultChecked={scope === 'read'} disabled={scope === 'read'}/>{t(scopeNames[scope])}</label>)}</fieldset><Field label={t('有效期')}><select name="expiresInDays" defaultValue="90">{[30, 90, 365].map(days => <option key={days} value={days}>{t('{0} 天', [days])}</option>)}</select></Field><Field label={t('当前密码')}><input name="currentPassword" type="password" autoComplete="current-password" required maxLength={200}/></Field><div className="modal-actions"><button className="button" type="button" onClick={() => setCreating(false)}>{t('取消')}</button><Submit>{t('生成密钥')}</Submit></div></Form></Modal>}
    {issued && <Modal title={t('保存你的 API 密钥')} subtitle={t('完整密钥仅显示这一次，请立即保存。')} onClose={() => setIssued('')}><Field label={t('API 密钥')}><textarea readOnly value={issued} rows={3} spellCheck={false} onFocus={event => event.target.select()}/></Field><p className="form-hint">{t('使用 Authorization: Bearer 携带密钥。请勿放入网页代码、URL 或公开仓库。')}</p><div className="modal-actions"><button className="button" onClick={() => copy(issued)}><Copy size={15}/>{t('复制密钥')}</button><button className="button primary" onClick={() => setIssued('')}>{t('我已保存')}</button></div></Modal>}
    {revoking && <Modal title={t('撤销 API 密钥')} subtitle={revoking.name} onClose={() => setRevoking(null)}><p>{t('撤销后，使用此密钥的应用将立即无法访问 API。此操作无法恢复。')}</p><Form onSubmit={async () => { await api(`/api/settings/api-keys/${revoking.id}`, { method: 'DELETE' }); setRevoking(null); toast(t('API 密钥已撤销')); await refresh(); }}><div className="modal-actions"><button className="button" type="button" onClick={() => setRevoking(null)}>{t('取消')}</button><Submit>{t('确认撤销')}</Submit></div></Form></Modal>}
  </section>;
}
