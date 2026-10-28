import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Activity, BarChart3, ChevronDown, ChevronRight, CircleHelp, FileKey2, LayoutDashboard, LogOut, Menu, Plus, RefreshCw, Settings2, ShieldCheck, Wallet, Zap } from 'lucide-react';
import { api, dateTime, key, localToday, money, post, mutate, useData, type RecordData } from '../api';
import { Amount } from '../PriceDisplay';
import { Badge, Empty, ErrorBox, Field, Form, Loading, Modal, PageHead, Submit, Table, useSession, useToast } from '../components';
import LanguageSwitcher, { useLocale } from '../LanguageSwitcher';
import { SubmitKeyModal } from './KeyChannelForm';
import { t } from '../i18n';

const keyNav = [
  { to: '/key', label: '概览', icon: LayoutDashboard },
  { to: '/key/tasks', label: '我的任务', icon: FileKey2 },
  { to: '/key/channels', label: '我的渠道', icon: Activity },
  { to: '/key/usage', label: '额度 / 用量监控', icon: BarChart3 },
  { to: '/key/settlements', label: '我的结算', icon: Wallet },
  { to: '/key/settings', label: '设置', icon: Settings2 },
];

function KeyShell({ user, reload, onLogout }: { user: RecordData; reload: () => Promise<void>; onLogout: () => Promise<void> }) {
  useLocale();
  const location = useLocation();
  const [mobile, setMobile] = useState(false);
  const current = keyNav.find(item => item.to === location.pathname)?.label || '概览';
  return <div className="app-shell key-shell">
    <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
      <Link className="brand" to="/key"><span className="brand-symbol"><Zap size={22} fill="currentColor" /></span><span>CCMAX<span className="brand-dot">.</span><small>KEY SUPPLY</small></span></Link>
      <Link className="workspace-switch" to="/"><span className="workspace-icon">K</span><span><strong>Key 供货工作空间</strong><small>切换到账号收益</small></span><ChevronDown size={14} /></Link>
      <div className="nav-groups"><div className="nav-group"><div className="nav-label">供货履约</div>{keyNav.slice(0, 5).map(item => <NavLink end={item.to === '/key'} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} key={item.to} to={item.to}><item.icon size={18} /><span>{t(item.label)}</span></NavLink>)}</div><div className="nav-group"><div className="nav-label">管理</div><NavLink className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} to="/key/settings"><Settings2 size={18} /><span>{t('设置')}</span></NavLink></div></div>
      <div className="sidebar-bottom"><div className="workspace-note"><div><ShieldCheck size={16} /><strong>Key 安全托管</strong></div><p>上游 Key 只在服务端加密保存。<br />前端和日志始终显示掩码。</p><Link to="/key/settings">查看连接设置 <ChevronRight size={13} /></Link></div><button className="user-card" aria-label="退出登录" onClick={onLogout}><span className="avatar">{user.name?.slice(0, 1)}</span><span><strong>{user.name}</strong><small>{user.role === 'owner' ? '平台管理员' : '供货成员'}</small></span><LogOut size={16} /></button></div>
    </aside>
    {mobile && <button className="sidebar-shade" aria-label="关闭菜单" onClick={() => setMobile(false)} />}
    <div className="main-shell"><header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu" onClick={() => setMobile(v => !v)}><Menu size={19} /></button><span>Key 供货工作空间</span><ChevronRight size={13} /><strong>{t(current)}</strong></div><div className="topbar-actions"><LanguageSwitcher /><Link className="icon-button" to="/key/usage" aria-label="额度监控"><Activity size={18} /></Link><Link className="icon-button" to="/key/settings" aria-label="设置"><CircleHelp size={18} /></Link><span className="avatar small">{user.name?.slice(0, 1)}</span></div></header><main className="main-content"><Routes><Route path="/key" element={<KeyOverview />} /><Route path="/key/tasks" element={<KeyTasks />} /><Route path="/key/channels" element={<KeyChannels />} /><Route path="/key/usage" element={<KeyUsage />} /><Route path="/key/settlements" element={<KeySettlements />} /><Route path="/key/settings" element={<KeySettings />} /><Route path="*" element={<KeyOverview />} /></Routes><footer className="footer"><span>CCMAX · Key 供货与实时结算</span><span>同步周期 5 分钟 <span className="footer-dot">·</span> USD</span></footer></main></div>
  </div>;
}

function KeyOverview() {
  useLocale();
  const { data, error, loading } = useData<{ tasks: RecordData[] }>('/api/key-tasks', 30000);
  const { data: usage } = useData<{ totals: RecordData }>('/api/key-usage', 30000);
  const tasks = data?.tasks || [];
  return <><PageHead eyebrow="Key Supply" title="供货工作台" description="发布任务、提交上游 Key，并实时查看额度和收益。" actions={<Link className="button primary" to="/key/tasks"><FileKey2 size={16} />查看任务</Link>} /><ErrorBox error={error} />{loading ? <Loading /> : <><div className="stats-grid key-stats"><div className="stat-card highlight"><span className="stat-label">任务总数</span><strong className="stat-value">{tasks.length}</strong><span className="stat-detail">已发布和待配置任务</span></div><div className="stat-card"><span className="stat-label">渠道数量</span><strong className="stat-value">{usage?.totals?.channels || 0}</strong><span className="stat-detail">已提交的上游 Key</span></div><div className="stat-card"><span className="stat-label">折前总用量</span><strong className="stat-value">{money(usage?.totals?.used_usd || 0)}</strong><span className="stat-detail">New API used_quota 换算</span></div><div className="stat-card"><span className="stat-label">自动刷新</span><strong className="stat-value">5<span className="stat-value-unit">min</span></strong><span className="stat-detail"><i className="live-dot" />同步延迟可在用量页查看</span></div></div><section className="panel"><div className="panel-head"><div><h2>最近任务 <span>{tasks.length}</span></h2><p>有价格的成员可以提交 Key；未定价任务会明确提示。</p></div><Link className="text-button" to="/key/tasks">全部任务 <ChevronRight size={14} /></Link></div>{tasks.length ? <Table headers={['任务', '资源 / 模型', '状态', '渠道数', '折前用量', '操作']}>{tasks.slice(0, 8).map(task => <tr key={task.id}><td><strong>{task.name}</strong><small>{task.provider} · {task.resource_type}</small></td><td><span className="key-models">{(task.models || []).slice(0, 3).join('、') || '—'}</span></td><td><Badge state={task.state} /></td><td>{task.channels || 0}</td><td className="amount-cell"><Amount value={task.used_usd} /></td><td><Link className="text-button" to={`/key/tasks?task=${task.id}`}>查看 <ChevronRight size={13} /></Link></td></tr>)}</Table> : <Empty title="还没有可见任务" detail="管理员发布任务并设置价格后，任务会出现在这里。" />}</section></>}</>;
}

function KeyTasks() {
  useLocale();
  const { user } = useSession(); const toast = useToast();
  const { data, error, loading, refresh } = useData<{ tasks: RecordData[] }>('/api/key-tasks', 15000);
  const [modal, setModal] = useState<RecordData | null>(null);
  const owner = user.role === 'owner'; const tasks = data?.tasks || [];
  async function changeState(task: RecordData) { const state = task.state === 'published' ? 'paused' : task.state === 'paused' ? 'published' : 'published'; try { await mutate(`/api/key-tasks/${task.id}`, 'PATCH', { state }); toast(state === 'published' ? '任务已发布' : '任务已暂停'); await refresh(); } catch (e) { toast((e as Error).message, 'error'); } }
  return <><PageHead eyebrow="Key Supply" title="我的任务" description="查看供货需求、完成履约，并管理任务价格和发布状态。" actions={owner ? <button className="button primary" onClick={() => setModal({ type: 'create-task' })}><Plus size={16} />创建任务</button> : undefined} /><ErrorBox error={error} />{loading ? <Loading /> : tasks.length ? <section className="panel"><div className="panel-head"><div><h2>供货任务 <span>{tasks.length}</span></h2><p>按任务绑定的 New API 连接同步额度，收益同步后自动进入统一钱包。</p></div><button className="button" onClick={() => refresh()}><RefreshCw size={14} />刷新</button></div><Table headers={['ID / 任务', '站点 / 资源', '模型', '总额度', '已结算', '渠道数', '状态', '操作']}>{tasks.map(task => <tr key={task.id}><td><strong className="mono">{task.id.slice(0, 12)}</strong><small>{task.name}</small></td><td><strong>{task.site || 'New API'}</strong><small>{task.provider} · {task.resource_type}</small></td><td><span className="key-models">{(task.models || []).slice(0, 4).join('、')}</span></td><td className="amount-cell"><Amount value={task.used_usd} /></td><td className="amount-cell"><Amount value={task.profit_usd} tone="profit" /></td><td>{task.channels || 0}</td><td><Badge state={task.state} />{task.rate === null && <small className="warning-text">未定价</small>}</td><td><div className="row-actions">{task.state === 'published' && task.rate !== null && <button onClick={() => setModal({ type: 'submit-key', task })}>提交 Key</button>}{owner && task.state !== 'closed' && <button onClick={() => changeState(task)}>{task.state === 'published' ? '暂停' : '发布'}</button>}{owner && <button onClick={() => setModal({ type: 'rate', task })}>任务价格</button>}</div></td></tr>)}</Table></section> : <Empty title="暂无任务" detail={owner ? '创建一个 New API 任务并发布给供货成员。' : '等待管理员发布并为你配置价格的任务。'} />}{modal?.type === 'create-task' && <CreateTaskModal onClose={() => setModal(null)} onDone={async () => { setModal(null); await refresh(); }} />}{modal?.type === 'submit-key' && <SubmitKeyModal task={modal.task} onClose={() => setModal(null)} onDone={async () => { setModal(null); await refresh(); }} />}{modal?.type === 'rate' && <RateModal task={modal.task} onClose={() => setModal(null)} />}</>;
}

function CreateTaskModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const { data, error, loading, refresh } = useData<{ connections: RecordData[] }>('/api/new-api-connections', 15000);
  const connections = data?.connections || [];
  const [connectionId, setConnectionId] = useState('');
  const selected = connections.find(connection => connection.id === connectionId);
  const keyman = selected?.adapter_type === 'keyman_newapi';
  const [gateways, setGateways] = useState<RecordData[]>([]);
  const [gatewayId, setGatewayId] = useState('');
  const [gatewayError, setGatewayError] = useState('');
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setGateways([]); setGatewayId(''); setGatewayError(''); setGatewayLoading(false);
    if (!keyman || selected?.status !== 'connected') return;
    setGatewayLoading(true);
    void api<{ gateways: RecordData[] }>(`/api/new-api-connections/${connectionId}/gateways`).then(result => {
      if (!active) return;
      setGateways(result.gateways || []);
      setGatewayId(String(result.gateways?.[0]?.id || ''));
      if (!result.gateways?.length) setGatewayError('此连接没有可用网关，请先在 KeyMan 平台配置网关。');
    }).catch(error => { if (active) setGatewayError((error as Error).message); })
      .finally(() => { if (active) setGatewayLoading(false); });
    return () => { active = false; };
  }, [connectionId, keyman, selected?.status, attempt]);
  const ready = selected?.status === 'connected' && (!keyman || (!gatewayLoading && !gatewayError && !!gatewayId));
  return <Modal title="创建 Key 任务" subtitle="选择平台模板；KeyMan 的网关渠道表单会作为供货成员的提交表单" onClose={onClose}>
    <ErrorBox error={error} />
    {loading ? <Loading /> : <>
      {!connections.some(connection => connection.status === 'connected') && <div className="notice">请先<Link to="/key/settings">配置并验证平台连接</Link>，验证通过后才能创建和发布任务。</div>}
      <Form onSubmit={async f => {
        if (!ready || !selected) throw new Error('请先验证平台连接并选择可用网关');
        await post('/api/key-tasks', { connectionId, templateType: selected.adapter_type || 'standard_new_api', gatewayId: keyman ? gatewayId : undefined, name: f.get('name'), resourceType: f.get('resourceType'), provider: f.get('provider'), models: String(f.get('models') || '').split(/[,，\n]/).map(v => v.trim()).filter(Boolean), rootRate: Number(f.get('rootRate') || 1) });
        toast('任务已创建'); await onDone();
      }}>
        <Field label="任务名称"><input name="name" required maxLength={120} placeholder="Anthropic 新任务" /></Field>
        <div className="form-grid">
          <Field label="平台 / 任务模板"><select name="connectionId" required value={connectionId} onChange={e => setConnectionId(e.target.value)}>
            <option value="" disabled>选择已验证的平台连接</option>
            {connections.map(connection => <option key={connection.id} value={connection.id} disabled={connection.status !== 'connected'}>{connection.name} · {connection.adapter_type === 'keyman_newapi' ? 'KeyMan 定制' : '标准 New API'}{connection.status !== 'connected' ? ' · 未验证或已停用' : ''}</option>)}
          </select></Field>
          <Field label="资源类型"><input name="resourceType" required defaultValue="Anthropic" /></Field>
          <Field label="供应商"><input name="provider" required defaultValue="Anthropic" /></Field>
          <Field label="管理员折扣"><input name="rootRate" type="number" min="0" max="1" step="0.0001" defaultValue="1" /></Field>
        </div>
        {selected && selected.status !== 'connected' && <ErrorBox error="平台连接未验证或已停用，请先在设置中编辑并验证连接" />}
        {keyman && <>
          <Field label="KeyMan 网关"><select required value={gatewayId} disabled={gatewayLoading || !gateways.length} onChange={e => setGatewayId(e.target.value)}>
            <option value="" disabled>{gatewayLoading ? '正在加载网关…' : '选择可用网关'}</option>
            {gateways.map(gateway => <option key={gateway.id} value={gateway.id}>{gateway.name}</option>)}
          </select></Field>
          <ErrorBox error={gatewayError} />
          <button type="button" className="button" disabled={gatewayLoading} onClick={async () => { await refresh(); setAttempt(value => value + 1); }}><RefreshCw size={14} />重新加载网关</button>
        </>}
        <Field label="模型（可换行或逗号分隔）"><textarea name="models" required rows={3} placeholder="claude-opus-5-5, claude-opus-5" /></Field>
        <div className="modal-actions"><button type="submit" className="button primary" disabled={!ready}>创建任务</button></div>
      </Form>
    </>}
  </Modal>;
}

function RateModal({ task, onClose }: { task: RecordData; onClose: () => void }) { const { user } = useSession(); const { data, refresh } = useData<{ rates: RecordData[] }>(`/api/key-tasks/${task.id}/rates`); const { data: team } = useData<{ users: RecordData[] }>('/api/team'); const toast = useToast(); const members = (team?.users || []).filter(member => member.parent_id === user.id); return <Modal title="任务价格" subtitle="直属上级只能设置直属下级价格" onClose={onClose} wide><Table headers={['成员', '生效日期', '折扣', '操作']}>{(data?.rates || []).map(rate => <tr key={rate.id}><td>{rate.user_name}<small>{rate.user_id}</small></td><td>{rate.effective_date}</td><td><span className="rate-value">{Number(rate.rate).toFixed(4)}</span></td><td>—</td></tr>)}</Table><Form onSubmit={async f => { await post(`/api/key-tasks/${task.id}/rates`, { userId: f.get('userId'), rate: Number(f.get('rate')), effectiveDate: f.get('effectiveDate') || undefined }); toast('任务价格已保存'); await refresh(); }}><div className="form-grid"><Field label="直属成员"><select name="userId" required defaultValue=""><option value="" disabled>选择直属成员</option>{members.map(member => <option key={member.id} value={member.id}>{member.name} · {member.email}</option>)}</select></Field><Field label="折扣（0–1）"><input name="rate" type="number" required min="0" max="1" step="0.0001" /></Field><Field label="生效日期" hint="留空时首次报价当天生效，已有报价从次日生效"><input name="effectiveDate" type="date" min={localToday()} /></Field></div><div className="modal-actions"><Submit>保存价格</Submit></div></Form></Modal>; }

function KeyChannels() { return <KeyUsageTable title="我的渠道" description="集中管理供货渠道，查看 New API 状态、折前消耗和自动封禁原因。" manage />; }
function KeyUsage() { return <KeyUsageTable title="额度 / 用量监控" description="每 5 分钟同步 New API used_quota，计数回退会生成可审计的负向调整。" usage />; }
function KeyUsageTable({ title, description, usage = false, manage = false }: { title: string; description: string; usage?: boolean; manage?: boolean }) { useLocale(); const toast = useToast(); const { data, error, loading, refresh } = useData<{ rows: RecordData[]; totals: RecordData }>('/api/key-usage', 15000); const [rotate, setRotate] = useState<RecordData | null>(null); async function changeChannel(row: RecordData, action: 'test' | 'pause' | 'resume' | 'delete') { try { if (action === 'test') await post(`/api/key-channels/${row.channel_id}/test`, {}); else await mutate(`/api/key-channels/${row.channel_id}`, 'PATCH', { state: action === 'delete' ? 'deleted' : action === 'pause' ? 'paused' : 'active' }); toast(action === 'test' ? '渠道测试通过' : action === 'delete' ? '渠道已删除' : action === 'pause' ? '渠道已暂停' : '渠道已恢复'); await refresh(); } catch (e) { toast((e as Error).message, 'error'); } } return <><PageHead eyebrow="Key Supply" title={title} description={description} actions={<button className="button" onClick={() => refresh()}><RefreshCw size={14} />刷新</button>} /><ErrorBox error={error} />{loading ? <Loading /> : <><div className="usage-totals key-usage-totals"><div><span>折前总消耗额度</span><strong><Amount value={data?.totals?.used_usd} /></strong></div><div><span>渠道总数</span><strong>{data?.totals?.channels || 0}</strong></div><div><span>同步周期</span><strong>5 min</strong></div><div><span>数据时间</span><strong>{dateTime(new Date().toISOString())}</strong></div></div><section className="panel"><Table headers={['Token / ID', '站点 / 任务', '状态', '折前消耗额度', '模型', '最近同步', '原因', ...(manage ? ['操作'] : [])]}>{(data?.rows || []).map(row => <tr key={row.channel_id}><td><strong className="mono">{row.token_masked}</strong><small>{row.channel_id}</small></td><td><strong>{row.task_name}</strong><small>{row.supplier_name}</small></td><td><Badge state={row.status} /></td><td className="amount-cell amount-cell-key"><Amount value={row.used_usd} /></td><td><span className="key-models">{(row.models || []).join('、') || '—'}</span></td><td>{dateTime(row.last_sync_at)}</td><td className="break-word">{row.last_error || (usage ? '正常同步' : '—')}</td>{manage && <td><div className="row-actions"><button onClick={() => changeChannel(row, 'test')}>测试</button><button onClick={() => changeChannel(row, row.status === 'active' ? 'pause' : 'resume')}>{row.status === 'active' ? '暂停' : '恢复'}</button><button onClick={() => setRotate(row)}>轮换</button><button className="error-text" onClick={() => changeChannel(row, 'delete')}>删除</button></div></td>}</tr>)}</Table>{!data?.rows?.length && <Empty title="暂无渠道" detail="在我的任务中提交上游 Key 后，渠道会出现在这里。" />}</section></>}{rotate && <RotateChannelModal channel={rotate} onClose={() => setRotate(null)} onDone={async () => { setRotate(null); await refresh(); }} />}</>; }

function RotateChannelModal({ channel, onClose, onDone }: { channel: RecordData; onClose: () => void; onDone: () => Promise<void> }) { const toast = useToast(); return <Modal title="轮换上游 Key" subtitle={`${channel.task_name} · 当前仅显示掩码`} onClose={onClose}><Form onSubmit={async f => { try { await mutate(`/api/key-channels/${channel.channel_id}`, 'PATCH', { secret: f.get('secret') }); toast('Key 已轮换并加密保存'); await onDone(); } catch (e) { toast((e as Error).message, 'error'); } }}><Field label="新的上游 API Key"><input name="secret" type="password" required minLength={8} maxLength={1000} autoComplete="off" /></Field><div className="modal-actions"><Submit>保存并轮换</Submit></div></Form></Modal>; }

function KeySettlements() { useLocale(); const { data, error, loading } = useData<{ rows: RecordData[]; total: string }>('/api/key-settlements', 15000); const { data: finance } = useData<RecordData>('/api/finance', 15000); return <><PageHead eyebrow="Key Supply" title="我的结算" description="Key 任务用量同步后立即生成流水，与账号收益共用一个钱包。" actions={<Link className="button primary" to="/withdrawals"><Wallet size={16} />统一提现</Link>} /><ErrorBox error={error} /><div className="finance-summary key-finance-summary"><div className="finance-balance"><span>统一可提现余额</span><strong><Amount value={finance?.balance?.available} tone="settlement" /></strong><small>包含账号收益和 Key 任务收益</small></div><div><span>Key 任务收益</span><strong><Amount value={data?.total} tone="profit" /></strong><small>已生成的任务结算流水</small></div><div><span>冻结中</span><strong><Amount value={finance?.balance?.pending} tone="pending" /></strong><small>来自统一提现入口</small></div></div>{loading ? <Loading /> : <section className="panel"><div className="panel-head"><div><h2>任务结算流水 <span>{data?.rows?.length || 0}</span></h2><p>价格按同步时的任务报价冻结，调整流水会保留原始快照。</p></div></div><Table headers={['时间', '任务 / 渠道', '价格快照', '折前应收', '下级应付', '本层利润', '来源']}>{(data?.rows || []).map(row => <tr key={row.id}><td>{dateTime(row.observed_at)}</td><td><strong>{row.task_name}</strong><small>{row.token_masked}</small></td><td><span className="rate-value">{Number(row.rate).toFixed(4)}</span><small>下级 {Number(row.downstream_rate).toFixed(4)}</small></td><td className="amount-cell"><Amount value={row.gross_usd} /></td><td className="amount-cell"><Amount value={row.downstream_usd} /></td><td className="amount-cell"><Amount value={row.profit_usd} tone="profit" signed /></td><td><Badge state={row.kind === 'task_adjustment' ? 'error' : 'confirmed'} label={row.kind === 'task_adjustment' ? '负向调整' : '任务结算'} /></td></tr>)}</Table>{!data?.rows?.length && <Empty title="暂无任务结算" detail="渠道产生用量并完成同步后，流水会自动生成。" />}</section>}</>; }

function KeySettings() {
  useLocale();
  const { user } = useSession(); const toast = useToast();
  const { data, error, loading, refresh } = useData<{ connections: RecordData[] }>('/api/new-api-connections', 15000);
  const [editing, setEditing] = useState<RecordData | null | undefined>(undefined);
  const [testing, setTesting] = useState('');
  const owner = user.role === 'owner';
  async function testConnection(connection: RecordData) {
    setTesting(connection.id);
    try { await post(`/api/new-api-connections/${connection.id}/test`, {}); toast('连接测试通过'); }
    catch (error) { toast((error as Error).message, 'error'); }
    finally { await refresh(); setTesting(''); }
  }
  return <>
    <PageHead eyebrow="Key Supply" title={owner ? '平台连接与设置' : '设置'} description={owner ? '管理员维护标准 New API 或 KeyMan 定制模板连接，任务按连接同步渠道额度。' : '平台连接凭据仅由管理员维护。'} actions={owner ? <button className="button primary" onClick={() => setEditing(null)}><Plus size={16} />新增连接</button> : undefined} />
    <ErrorBox error={error} />
    {!owner && <div className="notice"><ShieldCheck size={18} />你可以查看连接健康状态、模板类型、额度换算单位和最近同步时间，凭据对代理成员不可见。</div>}
    {loading ? <Loading /> : <section className="connections-grid key-connections">
      {(data?.connections || []).map(connection => <article className="panel connection-card" key={connection.id}>
        <div className="panel-head"><div><h2>{connection.name}</h2>{owner && <p className="mono break-word">{connection.base_url}</p>}<small>{connection.adapter_type === 'keyman_newapi' ? 'KeyMan NewAPI 定制模板' : '标准 New API 模板'}</small></div><Badge state={connection.status} /></div>
        <div className="connection-facts">
          {owner && <div><span>认证方式</span><strong>{connection.auth_type === 'access_token' ? '管理访问令牌' : '管理员账号密码'}</strong></div>}
          <div><span>quota_per_unit</span><strong>{connection.quota_per_unit || '—'}</strong></div>
          {owner && <div><span>租户 ID</span><strong>{connection.tenant_id || '—'}</strong></div>}
          <div><span>最近验证 / 同步</span><strong>{dateTime(connection.last_sync_at)}</strong></div>
        </div>
        <ErrorBox error={connection.last_error} />
        {owner && <>
          {connection.status === 'error' && <p>连接已保存，验证通过后才能创建和发布任务。请编辑凭据后重新验证。</p>}
          <div className="connection-actions">
            <button className="button" onClick={() => setEditing(connection)}><Settings2 size={14} />编辑并验证</button>
            <button className="button" disabled={!!testing} onClick={() => testConnection(connection)}><RefreshCw size={14} />{testing === connection.id ? '正在测试…' : '测试连接'}</button>
            {connection.status === 'connected' && <Link className="button" to="/key/tasks">前往创建任务</Link>}
          </div>
        </>}
      </article>)}
      {!error && !data?.connections?.length && <Empty title="还没有平台连接" detail="新增并验证连接后即可创建和发布 Key 供货任务。" />}
    </section>}
    {owner && editing !== undefined && <ConnectionModal connection={editing} onClose={() => setEditing(undefined)} onDone={async () => { setEditing(undefined); await refresh(); }} />}
  </>;
}

function ConnectionModal({ connection, onClose, onDone }: { connection: RecordData | null; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [auth, setAuth] = useState(connection?.auth_type || 'password');
  const [adapter, setAdapter] = useState(connection?.adapter_type || 'standard_new_api');
  const editing = !!connection;
  return <Modal title={editing ? '编辑供货平台连接' : '新增供货平台连接'} subtitle="凭据会在服务端加密保存，KeyMan 是定制任务模板" onClose={onClose}>
    <Form onSubmit={async f => {
      const username = String(f.get('username') || '').trim();
      const password = String(f.get('password') || '');
      const accessToken = String(f.get('accessToken') || '').trim();
      const captchaVerification = String(f.get('captchaVerification') || '').trim();
      const replaceCredentials = !editing || auth !== connection.auth_type || !!(username || password || accessToken || captchaVerification);
      const payload = { name: f.get('name'), baseUrl: f.get('baseUrl'), adapterType: adapter, tenantId: f.get('tenantId') || '1', quotaPerUnit: f.get('quotaPerUnit') ? Number(f.get('quotaPerUnit')) : undefined,
        ...(replaceCredentials ? { authType: auth, ...(auth === 'password' ? { username: username || undefined, password: password || undefined, captchaVerification: captchaVerification || undefined } : { accessToken }) } : {}) };
      const result = editing
        ? await mutate(`/api/new-api-connections/${connection.id}`, 'PATCH', payload)
        : await post('/api/new-api-connections', payload);
      if (result.verified === false) toast(`连接已保存，但验证失败：${result.warning || '请补充验证码或管理访问令牌'}`, 'error');
      else toast('平台连接已验证');
      await onDone();
    }}>
      <Field label="连接名称"><input name="name" required maxLength={100} defaultValue={connection?.name} placeholder={adapter === 'keyman_newapi' ? 'KeyMan 生产网关' : '生产 New API'} /></Field>
      <Field label="管理 API 地址"><input name="baseUrl" type="url" required defaultValue={connection?.base_url} placeholder={adapter === 'keyman_newapi' ? 'https://kapi.xkk.io/admin-api' : 'https://new-api.example.com'} /></Field>
      <Field label="任务模板"><select value={adapter} disabled={editing} onChange={e => setAdapter(e.target.value)}><option value="standard_new_api">标准 New API</option><option value="keyman_newapi">KeyMan NewAPI 定制模板</option></select></Field>
      {adapter === 'keyman_newapi' && <div className="form-grid">
        <Field label="租户 ID"><input name="tenantId" required defaultValue={connection?.tenant_id || '1'} inputMode="numeric" pattern="[0-9]+" /></Field>
        <Field label="quota_per_unit" hint="按上游平台填写，用于把 usedQuota 换算 USD"><input name="quotaPerUnit" type="number" min="1" step="any" required defaultValue={connection?.quota_per_unit || ''} /></Field>
      </div>}
      {editing && <div className="notice">凭据留空会使用已加密保存的凭据或会话。重新使用账号登录时，请同时填写账号和密码。</div>}
      {adapter === 'keyman_newapi' && <div className="notice">KeyMan 开启滑块验证码时，账号密码还需提供登录页生成的一次性 captchaVerification；也可切换到管理访问令牌完成验证。</div>}
      <div className="tabs key-auth-tabs"><button type="button" className={auth === 'password' ? 'active' : ''} onClick={() => setAuth('password')}>管理员账号密码</button><button type="button" className={auth === 'access_token' ? 'active' : ''} onClick={() => setAuth('access_token')}>管理访问令牌</button></div>
      {auth === 'password' ? <div className="form-grid">
        <Field label="管理员账号"><input name="username" required={!editing || auth !== connection.auth_type} maxLength={200} autoComplete="off" /></Field>
        <Field label="管理员密码"><input name="password" required={!editing || auth !== connection.auth_type} maxLength={500} type="password" autoComplete="new-password" /></Field>
        {adapter === 'keyman_newapi' && <Field label="验证码串（KeyMan 开启时必填）" hint="在 KeyMan 登录页完成滑块验证后粘贴 captchaVerification；登录成功后系统会加密保存会话令牌"><input name="captchaVerification" maxLength={2000} autoComplete="off" /></Field>}
      </div> : <Field label="管理访问令牌"><input name="accessToken" required={!editing || auth !== connection.auth_type} maxLength={500} type="password" autoComplete="new-password" /></Field>}
      <div className="modal-actions"><Submit>验证并保存</Submit></div>
    </Form>
  </Modal>;
}

export default function KeyWorkspace({ user, reload, onLogout }: { user: RecordData; reload: () => Promise<void>; onLogout: () => Promise<void> }) { return <KeyShell user={user} reload={reload} onLogout={onLogout} />; }
