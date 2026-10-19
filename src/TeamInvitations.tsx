import type { WeeklyRecordReport } from '../shared/monetization';
import { useState } from 'react';
import { Copy, Link2, Plus } from 'lucide-react';
import { api, money, post, useData } from './api';
import { Badge, Empty, ErrorBox, Field, Form, Loading, Modal, Paginator, Submit, Table, useToast } from './components';
import { RateBadge, RateField } from './PriceDisplay';
import { getLocale, t } from './i18n';
import { useLocale } from './LanguageSwitcher';

export default function TeamInvitations({ providers, pricing }: { providers: [string, any][]; pricing: any }) {
  useLocale();
  const { data, error, loading, refresh } = useData('/api/team/invitations', 30000), toast = useToast();
  const [creating, setCreating] = useState(false), [selected, setSelected] = useState<string[]>([]), [revoking, setRevoking] = useState<any>(null), [page, setPage] = useState(1);
  const invitations = data?.invitations || [];
  const weeklyRecord = useData<WeeklyRecordReport>('/api/marketing/weekly-record', 60000);
  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); toast(t('已复制')); }
    catch { toast(t('无法自动复制，请手动选择并复制'), 'error'); }
  }
  function copyPromotion(url: string) {
    const record = weeklyRecord.error ? null : weeklyRecord.data?.record;
    const headline = record ? t('单账号历史 7 天收益最高 {0}！', [money(record.receivableUsd)]) : '';
    return copy([headline, t('闲置 Claude Max，立即加入 CCMAX 变现：'), url].filter(Boolean).join('\n'));
  }
  return <section className="panel team-invitations">
    <div className="panel-head"><div><h2><Link2 size={17}/>{t('邀请链接')}</h2><p>{t('一条链接，一份报价。分享邀请与推广文案，对方自行注册，自动归属团队，无需逐个开户。')}</p></div><button className="button primary" disabled={!providers.length} onClick={() => { setSelected(providers.map(([p]) => p)); setCreating(true); }}><Plus size={15}/>{t('创建邀请链接')}</button></div>
    <div className="invitation-error"><ErrorBox error={error}/></div>
    {loading ? <Loading/> : invitations.length ? <><Table headers={[t('邀请链接'), t('结算折扣'), t('已注册 / 人数上限'), t('到期时间（北京时间）'), t('状态'), t('操作')]}>{invitations.slice((page - 1) * 8, page * 8).map((invite: any) => {
      const state = invite.revoked_at ? 'revoked' : invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now() ? 'expired' : invite.max_uses !== null && invite.used_count >= invite.max_uses ? 'full' : 'active';
      return <tr key={invite.id}><td><strong>{invite.name}</strong><input className="invitation-url" aria-label={t('{0} 的邀请链接', [invite.name])} readOnly value={invite.url} onFocus={e => e.target.select()}/></td><td><div className="invitation-rates">{providers.filter(([p]) => invite.rates[p] !== undefined).map(([p, v]) => <span key={p}>{v.name} <RateBadge value={invite.rates[p]}/></span>)}</div></td><td>{invite.used_count} / {invite.max_uses ?? t('不限人数')}</td><td>{invite.expires_at ? new Date(invite.expires_at).toLocaleString(getLocale(), { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : t('长期有效')}</td><td><Badge state={state === 'active' ? 'active' : 'disabled'} label={t(state === 'active' ? '有效' : state === 'expired' ? '已过期' : state === 'full' ? '名额已满' : '已停用')}/></td><td><div className="row-actions invitation-actions">{state === 'active' && <><button onClick={() => copy(invite.url)}><Copy size={13}/>{t('复制链接')}</button><button onClick={() => copyPromotion(invite.url)}><Copy size={13}/>{t('复制推广文案')}</button></>}{!invite.revoked_at && <button onClick={() => setRevoking(invite)}>{t('停用链接')}</button>}</div></td></tr>;
    })}</Table><Paginator total={invitations.length} page={page} setPage={setPage} size={8}/></> : !error && <Empty title={t('还没有邀请链接')} detail={t('为不同客户设置不同折扣，分享链接即可邀请注册。')}/>}
    {creating && <Modal title={t('创建邀请链接')} subtitle={t('链接价格固定；需要新价格时创建另一条链接。')} onClose={() => setCreating(false)}><Form onSubmit={async form => {
      await post('/api/team/invitations', { name: form.get('name'), rates: Object.fromEntries(selected.map(p => [p, Number(form.get(p))])), expiresInDays: form.get('expiresInDays') === '' ? null : Number(form.get('expiresInDays')), maxUses: form.get('maxUses') === '' ? null : Number(form.get('maxUses')) });
      setCreating(false); setPage(1); toast(t('邀请链接已创建，可以复制分享')); await refresh();
    }}><Field label={t('链接名称')} hint={t('例如：标准客户、合作伙伴；此名称仅自己可见。')}><input name="name" required maxLength={80} autoComplete="off"/></Field>
      <div className="invitation-platforms">{providers.map(([p, v]) => <div key={p}><label className="check-row"><input type="checkbox" checked={selected.includes(p)} onChange={e => setSelected(values => e.target.checked ? [...values, p] : values.filter(value => value !== p))}/>{v.name}</label>{selected.includes(p) && <RateField name={p} label={t('{0} 结算折扣', [v.name])} recipient="downstream" ceiling={pricing?.prices.find((price: any) => price.provider === p)?.nextRate}/>}</div>)}</div>
      <p className="form-hint">{t('所选平台价格从注册当日北京时间生效；未选平台保持未定价。下级应收 = 平台账单 × 折扣。')}</p>
      <div className="form-grid"><Field label={t('有效期')}><select name="expiresInDays" defaultValue="30">{[1, 7, 30, 90, 365].map(days => <option key={days} value={days}>{t('{0} 天', [days])}</option>)}<option value="">{t('长期有效')}</option></select></Field><Field label={t('注册人数上限')} hint={t('留空不限人数；填写 1 可生成单人邀请。')}><input name="maxUses" type="number" min="1" max="1000000" step="1" placeholder={t('不限人数')}/></Field></div>
      <p className="form-hint">{t('任何持有链接的人都可按此价格注册，请只分享给目标客户。停用链接不会影响已注册成员。')}</p>
      <div className="modal-actions"><Submit busy={!selected.length}>{t('生成邀请链接')}</Submit></div>
    </Form></Modal>}
    {revoking && <Modal title={t('停用邀请链接')} subtitle={revoking.name} onClose={() => setRevoking(null)}><p>{t('停用后无法继续注册，已注册成员的归属和价格保持不变。')}</p><Form onSubmit={async () => { await api(`/api/team/invitations/${revoking.id}`, { method: 'DELETE' }); setRevoking(null); toast(t('邀请链接已停用')); await refresh(); }}><div className="modal-actions"><Submit>{t('确认停用')}</Submit></div></Form></Modal>}
  </section>;
}
