import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowUpRight, Clock3, LayoutGrid, List, RefreshCw, Search, Server, ShieldCheck, Trash2, UserRound, Zap } from 'lucide-react';
import { platformName } from './platforms';
import { dateTime, number } from './api';
import { Badge, Empty, Loading, Paginator, Table, useSession } from './components';
import { PlatformIdentity } from './PlatformIdentity';
import { Amount } from './PriceDisplay';
import { comparePoolBills, matchingBindings, poolBill, poolMetric, poolModel, type PoolMetric } from './account-pool';
import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';
import './account-pool.css';

type Props={data:any;loading:boolean;onRefresh:()=>Promise<void>;unassigned:boolean;onUnassigned:(value:boolean)=>void;
  onProxy:(account:any)=>void;onAssign:(account:any)=>void;onOnboard:(account:any)=>void;onManage:(account:any)=>void;onDelete:(account:any)=>void};
const coverage=(metric:PoolMetric)=>t('覆盖 {0}/{1} 个平台账号',[metric.covered,metric.total]);
const count=(value:unknown)=>value===null||value===undefined?'—':number(value);

export default function AccountPool(props:Props){
  useLocale();
  const {data,loading,unassigned,onUnassigned,onRefresh}=props,{user}=useSession();
  const [search,setSearch]=useState(''),[provider,setProvider]=useState('all'),[owner,setOwner]=useState('all'),[status,setStatus]=useState('all'),[sort,setSort]=useState('today'),[view,setView]=useState('cards'),[size,setSize]=useState(12),[page,setPage]=useState(1);
  useEffect(()=>setPage(1),[search,provider,owner,status,sort,size,unassigned]);
  const all:any[]=data?.accounts||[],day=data?.day||'';
  const accounts=all.filter(a=>(!unassigned||!a.ownership_verified)&&(owner==='all'||a.owner_id===owner)&&
    (status!=='pending'||provider==='all'&&!a.bindings.length)&&
    `${a.email} ${a.label} ${a.owner_name||''}`.toLowerCase().includes(search.trim().toLowerCase()))
    .map(a=>({...a,bindings:matchingBindings(a.bindings,provider,status)}))
    .filter(a=>status==='pending'||provider==='all'&&status==='all'||a.bindings.length>0);
  accounts.sort((a,b)=>{
    if(sort==='email')return a.email.localeCompare(b.email);
    if(sort==='latest')return Date.parse(b.created_at)-Date.parse(a.created_at)||a.id.localeCompare(b.id);
    const av=poolBill(a.bindings,day,'today').value,bv=poolBill(b.bindings,day,'today').value;
    return comparePoolBills(av,bv)||a.email.localeCompare(b.email);
  });
  const bindings=accounts.flatMap(a=>a.bindings),fresh=bindings.filter(b=>b.data_fresh).length;
  const members=[...new Map(all.filter(a=>a.owner_id).map(a=>[a.owner_id,{id:a.owner_id,name:a.owner_name}])).values()];
  const visible=accounts.slice((page-1)*size,page*size);
  const actionProps={...props,original:(account:any)=>all.find(a=>a.id===account.id)||account};
  return <div className="account-pool">
    <div className="pool-overview">
      <div className="pool-overview-label"><span><Server size={15}/>{t('账号池概览')}</span><small>{t('汇总随当前筛选变化')}</small></div>
      <div className="pool-summary">
        <div className="pool-summary-count"><span>{t('账号 / 平台绑定')}</span><strong>{loading?'—':number(accounts.length)} <small>/ {loading?'—':number(bindings.length)}</small></strong><small>{t('有效快照 {0}/{1}',[fresh,bindings.length])}</small></div>
        <Summary label="RPM" metric={poolMetric(bindings,d=>d.activity.rpm)} loading={loading}/>
        <Summary label={t('当前并发')} metric={poolMetric(bindings,d=>d.activity.concurrent)} loading={loading}/>
        <Summary label={t('今日平台账单')} metric={poolBill(bindings,day,'today')} usd loading={loading}/>
        <Summary label={t('近 7 天平台账单')} metric={poolBill(bindings,day,'7d')} usd loading={loading}/>
        <Summary label={t('近 30 天平台账单')} metric={poolBill(bindings,day,'30d')} usd loading={loading}/>
      </div>
    </div>
    <section className="panel pool-browser" aria-label={t('账号池')}>
      <div className="pool-toolbar">
        <div className="tabs"><button className={!unassigned?'active':''} onClick={()=>onUnassigned(false)}>{t('全部账号')} <span>{all.length}</span></button>{user.role==='owner'&&<button className={unassigned?'active':''} onClick={()=>onUnassigned(true)}>{t('待归属')} <span>{all.filter(a=>!a.ownership_verified).length}</span></button>}</div>
        <button className="button" onClick={()=>void onRefresh()}><RefreshCw size={14}/>{t('刷新账号')}</button>
      </div>
      <div className="pool-filters">
        <label className="pool-search"><span>{t('搜索')}</span><div className="search-input"><Search size={15}/><input aria-label={t('搜索账号')} value={search} onChange={e=>setSearch(e.target.value)} placeholder={t('搜索邮箱或归属成员')}/></div></label>
        <label><span>{t('所属平台')}</span><select aria-label={t('筛选平台')} value={provider} onChange={e=>setProvider(e.target.value)}><option value="all">{t('所有平台')}</option>{Object.keys(data?.providers||{}).map(p=><option key={p} value={p}>{platformName(p)}</option>)}</select></label>
        <label><span>{t('归属团队')}</span><select aria-label={t('筛选归属')} value={owner} onChange={e=>setOwner(e.target.value)}><option value="all">{t('全部归属')}</option><option value={user.id}>{t('仅本人')}</option>{members.filter(m=>m.id!==user.id).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label><span>{t('状态')}</span><select aria-label={t('筛选账号状态')} value={status} onChange={e=>setStatus(e.target.value)}><option value="all">{t('全部状态')}</option><option value="active">{t('正常')}</option><option value="disabled">{t('已停用')}</option><option value="attention">{t('需要核对')}</option><option value="pending">{t('等待上号')}</option></select></label>
        <label><span>{t('排序')}</span><select aria-label={t('账号排序')} value={sort} onChange={e=>setSort(e.target.value)}><option value="today">{t('今日账单从高到低')}</option><option value="latest">{t('最近添加')}</option><option value="email">{t('邮箱名称')}</option></select></label>
      </div>
      <div className="pool-viewbar"><span>{t('筛选 {0} / 全部 {1} 个账号',[accounts.length,all.length])}</span><div className="actions"><select aria-label={t('每页条数')} value={size} onChange={e=>setSize(Number(e.target.value))}>{[12,24,48].map(n=><option key={n} value={n}>{t('每页 {0} 条',[n])}</option>)}</select><div className="pool-view-toggle" aria-label={t('展示方式')}><button aria-pressed={view==='cards'} onClick={()=>setView('cards')}><LayoutGrid size={14}/>{t('卡片')}</button><button aria-pressed={view==='list'} onClick={()=>setView('list')}><List size={14}/>{t('列表')}</button></div></div></div>
      {loading?<Loading/>:!accounts.length?<Empty title={all.length?t('没有匹配的账号'):t('添加第一个 Claude Max 账号')} detail={all.length?t('调整筛选条件，或新增账号并完成平台授权。'):t('从你已有的账号开始：填写邮箱、绑定固定代理、完成授权，再查看实际用量与收益。')} action={!all.length&&<button className="button primary" onClick={()=>props.onOnboard({})}><Zap size={15}/>{t('新增账号')}</button>}/>:<>
        {view==='cards'?<div className="pool-card-grid">{visible.map(account=><AccountCard key={account.id} account={account} day={day} actions={<AccountActions account={account} {...actionProps}/>}/>)}</div>:
          <Table headers={[t('Claude 账号'),t('平台连接 / 状态'),t('今日平台账单'),t('近 7 天平台账单'),t('归属团队'),t('固定出口代理'),t('操作')]}>{visible.map(a=><tr key={a.id}><td><strong>{a.email}</strong><small>{a.label}</small><Link className="text-button" to={`/analytics?accountId=${a.id}${provider==='all'?'':`&provider=${provider}`}`}>{t('调用详情')} <ArrowUpRight size={12}/></Link></td><td><div className="binding-list">{a.bindings.map((b:any)=><div key={b.id}><PlatformIdentity provider={b.provider} connectionId={b.connection_id}/><Badge state={b.connection_enabled?b.status:'disabled'}/></div>)}</div>{!a.bindings.length&&<Badge state="pending" label={t('等待上号')}/>}</td><td><Amount value={poolBill(a.bindings,day,'today').value}/><small>{coverage(poolBill(a.bindings,day,'today'))}</small></td><td><Amount value={poolBill(a.bindings,day,'7d').value}/></td><td><AccountOwner account={a}/></td><td><ProxyLabel account={a}/></td><td><AccountActions account={a} {...actionProps}/></td></tr>)}</Table>}
        <Paginator total={accounts.length} page={page} setPage={setPage} size={size}/>
      </>}
    </section>
    <p className="pool-data-note"><Activity size={14}/>{t('展示上游采样数据。过期或缺失指标不计入汇总；平台账单为折扣前金额，不等于结算收益。')}</p>
  </div>;
}

function Summary({label,metric,usd=false,loading=false}:{label:string;metric:PoolMetric;usd?:boolean;loading?:boolean}){
  return <div><span>{label}</span><strong>{loading?'—':usd?<Amount value={metric.value} digits={2}/>:count(metric.value)}</strong><small>{coverage(metric)}</small></div>;
}

function AccountCard({account:a,day,actions}:{account:any;day:string;actions:React.ReactNode}){
  const bindings=a.bindings,today=poolBill(bindings,day,'today'),fresh=bindings.filter((b:any)=>b.data_fresh).length;
  const activity=(key:'rpm'|'tpm'|'concurrent')=>poolMetric(bindings,d=>d.activity[key]);
  const requests=poolMetric(bindings,d=>d.day===day?d.periods.today.requests:null),tokens=poolMetric(bindings,d=>d.day===day?d.periods.today.tokens:null);
  return <article className="pool-account-card" aria-label={a.email}>
    <header className="pool-card-head"><span className="account-avatar">{a.email[0].toUpperCase()}</span><div><h2>{a.email}</h2><small>{a.label||t('Claude 账号')}</small></div><Link className="icon-button" to={`/analytics?accountId=${a.id}`} aria-label={t('查看 {0} 的调用详情',[a.email])}><ArrowUpRight size={17}/></Link></header>
    <div className="pool-card-meta"><AccountOwner account={a}/><span><Clock3 size={12}/>{t('添加于 {0}',[dateTime(a.created_at)])}</span></div>
    <div className="pool-card-bill"><div><span>{t('今日平台账单')}</span><strong><Amount value={today.value} digits={2}/></strong></div><small>{coverage(today)}</small></div>
    <div className="pool-periods">{(['5h','7d','30d'] as const).map(period=><div key={period}><span>{period==='5h'?t('近 5 小时'):period==='7d'?t('近 7 天'):t('近 30 天')}</span><Amount value={poolBill(bindings,day,period).value} digits={2}/><small>{coverage(poolBill(bindings,day,period))}</small></div>)}</div>
    <div className="pool-model-usage"><span>{t('今日模型消费')}</span>{(['opus','fable'] as const).map(model=><span key={model} title={coverage(poolModel(bindings,day,model))}>{model==='opus'?'Opus':'Fable'} <Amount value={poolModel(bindings,day,model).value} digits={2}/></span>)}</div>
    <div className="pool-live">{(['rpm','tpm','concurrent'] as const).map(k=><div key={k} title={coverage(activity(k))}><span>{k==='concurrent'?t('当前并发'):k.toUpperCase()}</span><strong>{count(activity(k).value)}</strong><small>{coverage(activity(k))}</small></div>)}</div>
    <div className="pool-bindings"><div className="pool-binding-label"><span>{t('所属平台')}</span><small>{t('有效快照 {0}/{1}',[fresh,bindings.length])}</small></div>{bindings.map((b:any)=><BindingUsage binding={b} day={day} key={b.id}/>)}{!bindings.length&&<div className="pool-waiting"><Badge state="pending" label={t('等待上号')}/><span>{t('完成授权后显示平台用量')}</span></div>}</div>
    <div className="pool-card-requests"><span>{t('今日请求数')} <b title={coverage(requests)}>{count(requests.value)}</b></span><span>Token <b title={coverage(tokens)}>{count(tokens.value)}</b></span></div>
    <footer><div className="pool-card-proxy"><ShieldCheck size={13}/><ProxyLabel account={a}/></div>{actions}</footer>
  </article>;
}

function BindingUsage({binding:b,day}:{binding:any;day:string}){
  const q=b.telemetry?.quota,valid=b.data_fresh;
  return <section className="pool-binding" aria-label={platformName(b.provider)}><div className="pool-binding-head"><PlatformIdentity provider={b.provider} connectionId={b.connection_id}/><Badge state={b.connection_enabled?b.status:'disabled'}/></div>
    <div className="pool-quotas"><Quota label={t('5 小时额度')} value={valid?q?.fiveHour:null} reset={valid?q?.reset5h:null}/><Quota label={t('7 天额度')} value={valid?q?.sevenDay:null} reset={valid?q?.reset7d:null}/></div>
    <div className="pool-binding-foot"><span>{t('今日')} <Amount value={poolBill([b],day,'today').value} digits={2}/></span><small className={valid?'':'pool-stale'}>{valid?t('最近同步'):t('数据待更新')} · {dateTime(b.snapshot_at)}</small></div>
  </section>;
}

function Quota({label,value,reset}:{label:string;value:number|null|undefined;reset?:string|null}){
  const known=value!==null&&value!==undefined;
  return <div className={`pool-quota${known&&value>=90?' high':''}`}><div><span>{label}</span><strong>{known?`${value.toFixed(1)}%`:'—'}</strong></div><div className="pool-quota-track" role={known?'meter':undefined} aria-label={label} aria-valuemin={known?0:undefined} aria-valuemax={known?100:undefined} aria-valuenow={known?Math.min(value,100):undefined}><i style={{width:known?`${Math.min(value,100)}%`:'0%'}}/></div>{reset&&<small>{t('恢复于 {0}',[dateTime(reset)])}</small>}</div>;
}

function AccountOwner({account:a}:{account:any}){
  const {user}=useSession();
  return <span className="pool-owner"><UserRound size={12}/>{a.owner_id?<>{a.owner_name}{a.owner_id===user.id&&<small>{t('我')}</small>}{!a.ownership_verified&&<span className="badge amber">{a.bindings.length?t('归属尚待核实'):t('待授权核实')}</span>}</>:<span className="badge amber">{t('待分配归属')}</span>}</span>;
}
function ProxyLabel({account:a}:{account:any}){
  const bound=a.proxy_bound??!!a.proxy_id;
  return <span title={a.proxy_endpoint||undefined}>{a.proxy_name||(bound?t('已绑定'):t('未绑定代理'))}{bound&&(!a.proxy_enabled?<small className="pool-stale"> · {t('禁止上号')}</small>:<small> · {t('所有平台自动沿用')}</small>)}</span>;
}
function AccountActions({account:a,original,onProxy,onAssign,onOnboard,onManage,onDelete}:Props&{account:any;original:(account:any)=>any}){
  const {user}=useSession(),account=original(a);
  return <div className="row-actions">{account.owner_id===user.id&&<button onClick={()=>onProxy(account)}>{t('代理')}</button>}{!account.ownership_verified&&user.role==='owner'&&(!account.owner_id||account.bindings.length>0)&&<button onClick={()=>onAssign(account)}>{account.owner_id?t('核实归属'):t('分配归属')}</button>}{account.owner_id===user.id&&<button onClick={()=>onOnboard(account)}><Zap size={12}/>{t('上号')}</button>}{account.bindings.length>0&&(account.owner_id===user.id||user.role==='owner')&&<button onClick={()=>onManage(account)}>{t('平台管理')}</button>}{account.owner_id===user.id&&!account.ownership_verified&&!account.bindings.length&&<button className="danger" onClick={()=>onDelete(account)}><Trash2 size={12}/>{t('删除账号')}</button>}</div>;
}
