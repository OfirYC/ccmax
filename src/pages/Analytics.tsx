import { useState } from 'react';
import { Link,useSearchParams } from 'react-router-dom';
import { Activity,ArrowUpRight,RefreshCw,Search } from 'lucide-react';
import { dateTime,key,number,post,useData } from '../api';
import { Amount } from '../PriceDisplay';
import { Badge,Empty,ErrorBox,Loading,Modal,PageHead,Paginator,PlatformMark,Table,useSession,useToast } from '../components';
import { t } from '../i18n';
import { useLocale } from '../LanguageSwitcher';
import type { AccountTelemetry } from '../../shared/telemetry';
import { telemetryPeriods,type TelemetryPeriod } from '../../shared/telemetry-periods';

const periodLabels=()=>({today:t('今日'),'5h':t('近 5 小时'),'7d':t('近 7 天'),'30d':t('近 30 天')});
const count=(value:any)=>value===null||value===undefined?'—':number(value);
const coverage=(m:any)=>t('覆盖 {0}/{1} 个平台账号',[m?.covered??0,m?.total??0]);

export default function Analytics(){
  useLocale();
  const [params,setParams]=useSearchParams(),[search,setSearch]=useState(params.get('search')||'');
  function change(k:string,value:string){const next=new URLSearchParams(params);if(value)next.set(k,value);else next.delete(k);next.delete('page');if(k==='scope')next.delete('ownerId');setParams(next);}
  const scope=params.get('scope')||'team',period=params.get('period')||'today';
  return <><PageHead eyebrow="UPSTREAM MODEL ACTIVITY" title={t('模型调用')} description={t('按账号归属查看上游调用、速率与模型消费，支持全部层级的团队。')} actions={<Link className="button" to="/usage">{t('结算用量明细')}<ArrowUpRight size={15}/></Link>}/>
    <section className="panel telemetry-filters">
      <div className="telemetry-filter-row"><div className="tabs" aria-label={t('数据归属')}>
        {([['team',t('本人及下级团队')],['self',t('仅本人')],['descendants',t('仅下级团队')]]).map(([v,label])=><button key={v} className={scope===v?'active':''} onClick={()=>change('scope',v)}>{label}</button>)}
      </div><select className="compact-select" aria-label={t('筛选平台')} value={params.get('provider')||''} onChange={e=>change('provider',e.target.value)}><option value="">{t('所有平台')}</option><option value="gatelink">Gatelink</option><option value="ai008">AI008</option><option value="minicc">Mini CC Gateway</option></select></div>
      <div className="telemetry-filter-row"><div className="tabs" aria-label={t('统计窗口')}>{telemetryPeriods.map(p=><button key={p} className={period===p?'active':''} onClick={()=>change('period',p)}>{periodLabels()[p]}</button>)}</div>
        <form className="search-input" onSubmit={e=>{e.preventDefault();change('search',search.trim());}}><Search size={15}/><input aria-label={t('搜索账号')} value={search} onChange={e=>setSearch(e.target.value)} placeholder={t('搜索邮箱或归属成员')}/><button className="text-button" type="submit">{t('查询')}</button></form>
      </div>
      {(params.has('accountId')||params.has('connectionId')||params.has('ownerId'))&&<div className="telemetry-filter-row"><span className="subtle">{t('已限定账号、平台连接或成员')}</span><button className="text-button" onClick={()=>{const next=new URLSearchParams(params);for(const k of ['accountId','connectionId','ownerId','page'])next.delete(k);setParams(next);}}>{t('清除限定')}</button></div>}
    </section>
    <AnalyticsData key={params.toString()} query={params.toString()} setPage={n=>{const next=new URLSearchParams(params);next.set('page',String(n));setParams(next);}} onMember={id=>change('ownerId',id)} />
  </>;
}

function AnalyticsData({query,setPage,onMember}:{query:string;setPage:(n:number)=>void;onMember:(id:string)=>void}){
  useLocale();
  const {data,error,loading,refresh}=useData(`/api/telemetry?${query}`,30000),trendQuery=new URLSearchParams(query);trendQuery.delete('page');
  const trend=useData(`/api/telemetry/trend?${trendQuery}`,60000),connections=useData('/api/connections'),{user}=useSession(),toast=useToast();
  const [selected,setSelected]=useState<string|null>(null),[view,setView]=useState('accounts'),[syncing,setSyncing]=useState(false);
  const row=data?.rows.find((r:any)=>r.id===selected);
  async function sync(){setSyncing(true);try{const ids=connections.data?.connections.filter((c:any)=>c.enabled).map((c:any)=>c.id)||[];if(!ids.length){toast(t('请先添加平台连接'),'error');return;}await post('/api/connections/sync',{connectionIds:ids,key:key()});toast(t('同步任务已提交，可在同步任务查看结果'));}catch(e){toast((e as Error).message,'error');}finally{setSyncing(false);}}
  if(loading)return <Loading/>;
  if(!data)return <ErrorBox error={error}/>;
  const totals=data.totals,period=data.period as TelemetryPeriod;
  return <><ErrorBox error={error}/><div className="telemetry-status"><span><Activity size={15}/>{t('有效快照 {0}/{1}',[totals.fresh,totals.bindings])} · {dateTime(data.generatedAt)}</span><div className="actions"><button className="button" onClick={()=>{void refresh();void trend.refresh();}}><RefreshCw size={14}/>{t('刷新展示')}</button>{user.role==='owner'&&<button className="button primary" disabled={syncing||!connections.data} onClick={sync}>{t('同步平台数据')}</button>}</div></div>
    <p className="page-note">{t('RPM/TPM 为上游最近一分钟的采样值，不代表持续实时流量。过期、缺失或未返回的指标不计入当前汇总。')} {t('数据时间采用上游同步时间或响应读取时间，上游内部缓存可能仍有延迟。')}</p>
    <div className="telemetry-kpis">
      <Metric label="RPM" metric={totals.rpm}/><Metric label="TPM" metric={totals.tpm}/><Metric label={periodLabels()[period]+' · '+t('请求数')} metric={totals.requests}/>
      <Metric label={periodLabels()[period]+' · Token'} metric={totals.tokens}/><Metric label={t('当前并发')} metric={totals.concurrent}/><Metric label={periodLabels()[period]+' · '+t('平台消费 USD')} metric={totals.billedUsd} usd/>
    </div>
    {totals.fresh<totals.bindings&&<div className="notice amber">{t('部分账号快照已过期或尚未采集。账号行保留最后一次数据供核对；当前汇总只计算有效快照。')}</div>}
    <div className="telemetry-charts"><section className="panel"><div className="panel-head"><div><h2>{t('最近 24 小时采样趋势')}</h2><p>{t('每 5 分钟保留一个采样点，空档不补零。')}</p></div></div><ErrorBox error={trend.error}/><RateTrend samples={trend.data?.samples||[]} total={trend.data?.total||0}/></section>
      <section className="panel"><div className="panel-head"><div><h2>{t('模型消费分布')}</h2><p>{periodLabels()[period]} · {t('上游模型分类 · USD')}</p></div></div><div className="telemetry-models">{totals.models.map((m:any)=>{
        const max=Math.max(1,...totals.models.map((x:any)=>Number(x.value)||0));
        return <div key={m.model}><div><strong>{m.model==='opus'?'Opus':'Fable'}</strong><Amount value={m.value}/></div><div className="telemetry-model-track"><i style={{width:m.value===null?'0':`${Math.max(0,Number(m.value)/max*100)}%`}}/></div><small>{coverage(m)}</small></div>;
      })}<p className="form-hint">{t('模型金额来自账号级模型统计，为缓存补偿前的消耗，可能包含上游延迟；未分类消费不按比例分摊。')}</p></div></section></div>
    <section className="panel telemetry-table"><div className="account-toolbar"><div className="tabs">{[['accounts',t('账号明细')],['platforms',t('平台汇总')],['members',t('成员汇总')]].map(([v,l])=><button key={v} className={view===v?'active':''} onClick={()=>setView(v)}>{l}</button>)}</div><small>{t('同一账号在不同平台分别统计，跨平台汇总包含各平台调用。')}</small></div>
      {view==='accounts'?data.rows.length?<><Table headers={[t('Claude 账号'),t('平台 / 归属'),t('请求数')+' / Token','RPM / TPM',t('平台消费 USD'),t('数据状态'),t('操作')]}>{data.rows.map((r:any)=>{
        const p=r.telemetry?.periods[period],a=r.telemetry?.activity,oldToday=period==='today'&&r.telemetry?.day!==data.day;
        return <tr key={r.id}><td><strong>{r.email}</strong><small>{r.label}</small></td><td><div className="binding-list"><div><PlatformMark provider={r.provider} size="tiny"/>{r.connection_name}</div></div><small>{r.owner_name||t('待归属')}</small></td>
          <td><strong>{count(oldToday?null:p?.requests)}</strong><small>{count(oldToday?null:p?.tokens)} Token</small></td><td><strong>{count(a?.rpm)}</strong><small>{count(a?.tpm)} TPM</small></td><td><Amount value={oldToday?null:p?.billedUsd}/></td>
          <td><Badge state={r.fresh?'active':'pending'} label={!r.telemetry?t('尚未采集'):r.fresh?t('有效快照'):t('快照已过期')}/><small>{dateTime(r.telemetry?.sourceAt||r.telemetry?.collectedAt)}</small></td><td><button className="text-button" onClick={()=>setSelected(r.id)}>{t('调用详情')}<ArrowUpRight size={14}/></button></td></tr>;
      })}</Table><Paginator total={data.total} page={data.page} setPage={setPage}/></>:<Empty title={t('当前范围没有平台账号')} detail={t('完成账号授权并确认归属后，平台同步会采集调用数据。')}/>:<Table headers={[view==='platforms'?t('平台'):t('归属成员'),t('平台账号'),t('请求数'),'Token','RPM',t('平台消费 USD')]}>{(view==='platforms'?data.platforms:data.members).map((r:any)=><tr key={r.id??'unassigned'}><td>{view==='platforms'?<div className="binding-list"><div><PlatformMark provider={r.provider} size="tiny"/>{r.name}</div></div>:r.id?<button className="text-button" onClick={()=>onMember(r.id)}>{r.name}</button>:t('待归属')}</td><td>{r.fresh}/{r.bindings}<small>{t('有效 / 全部')}</small></td><td><MetricCell metric={r.requests}/></td><td><MetricCell metric={r.tokens}/></td><td><MetricCell metric={r.rpm}/></td><td><MetricCell metric={r.billedUsd} usd/></td></tr>)}</Table>}
    </section>
    {view==='members'&&<p className="page-note">{t("成员汇总仅计算该成员本人名下账号；下级用量列在各自成员行。全部成员行之和等于当前范围总计，不重复累加团队。")}</p>}
    <div className="notice telemetry-cache"><Activity size={18}/><div><strong>{t('缓存与请求日志的可见范围')}</strong><p>{t('当前上游权限未提供可核实到 Claude 账号的输入、输出、缓存读写 Token 和逐条请求日志。主账号 API 日志不能当作个人或团队数据，缓存命中率暂不计算。')}</p><p>{t('账号详情中的缓存补偿是美元金额，不等于缓存 Token 或缓存命中率。今日口径来自上游，结算日期仍按北京时间。')}</p></div></div>
    {row&&<AccountDetail row={row} day={data.day} onClose={()=>setSelected(null)}/>}
  </>;
}
function Metric({label,metric,usd=false}:{label:string;metric:any;usd?:boolean}){return <div className="telemetry-kpi"><span>{label}</span><strong>{usd?<Amount value={metric?.value}/>:count(metric?.value)}</strong><small>{coverage(metric)}</small></div>;}
function MetricCell({metric,usd=false}:{metric:any;usd?:boolean}){return <>{usd?<Amount value={metric.value}/>:count(metric.value)}<small>{coverage(metric)}</small></>;}
function AccountDetail({row,day,onClose}:{row:any;day:string;onClose:()=>void}){
  useLocale();const d=row.telemetry as AccountTelemetry|null;
  return <Modal wide title={t('账号调用详情')} subtitle={`${row.email} · ${row.connection_name}`} onClose={onClose}>{!d?<Empty title={t('尚未采集')}/>:<>
    {!row.fresh&&<div className="notice amber">{t('快照已过期')} · {dateTime(d.sourceAt||d.collectedAt)}</div>}
    <div className="telemetry-detail-meta"><span>{t('归属成员')}: {row.owner_name||t('待归属')}</span><span>{t('上游数据时间')}: {dateTime(d.sourceAt)}</span><span>{t('CCMAX 采集时间')}: {dateTime(d.collectedAt)}</span><span>{t('采集日期（北京时间）')}: {d.day}</span></div>
    <div className="telemetry-detail-grid">{[['RPM',d.activity.rpm,d.limits.rpm],['TPM',d.activity.tpm,d.limits.tpm],[t('当前并发'),d.activity.concurrent,d.limits.concurrent],[t('活跃会话'),d.activity.sessions,null]].map(([label,v,limit])=><div key={label as string}><small>{label}</small><strong>{count(v)}</strong>{limit!==null&&<small>{t('配置上限 {0}（0 表示未限制）',[count(limit)])}</small>}</div>)}</div>
    <div className="telemetry-quotas"><Quota label={t('5 小时额度使用')} value={d.quota.fiveHour} reset={d.quota.reset5h}/><Quota label={t('7 天额度使用')} value={d.quota.sevenDay} reset={d.quota.reset7d}/></div>
    <Table headers={[t('统计窗口'),t('请求数'),'Token',t('平台计费 USD'),t('官方原价 USD'),t('缓存补偿 USD')]}>{telemetryPeriods.map(p=>{const v=p==='today'&&d.day!==day?null:d.periods[p];return <tr key={p}><td>{periodLabels()[p]}{p==='today'&&d.day!==day&&<small>{t('今日有效数据暂缺')}</small>}</td><td>{count(v?.requests)}</td><td>{count(v?.tokens)}</td><td><Amount value={v?.billedUsd}/></td><td><Amount value={v?.officialUsd}/></td><td><Amount value={v?.cacheCreditUsd}/></td></tr>;})}</Table>
    <div className="telemetry-detail-grid"><div><small>{t('24 小时请求')}</small><strong>{count(d.health.requests24h)}</strong></div><div><small>{t('24 小时成功')}</small><strong>{count(d.health.successful24h)}</strong></div><div><small>{t('24 小时限流')}</small><strong>{count(d.health.limited24h)}</strong></div><div><small>{t('24 小时成功率')}</small><strong>{d.health.requests24h!==null&&d.health.requests24h>0&&d.health.successful24h!==null&&d.health.successful24h<=d.health.requests24h?`${(d.health.successful24h/d.health.requests24h*100).toFixed(1)}%`:'—'}</strong></div></div>
    <p className="form-hint">{t('未返回的指标显示 —。账号详情补充读取不可用时保留列表快照，不影响结算同步。平台计费金额用于运营核对，实际应收与利润以结算账单为准。')}</p>
    <Link className="button" to={`/analytics?accountId=${row.account_id}` } onClick={onClose}>{t('查看此账号所有平台')}</Link>
  </>}</Modal>;
}
function Quota({label,value,reset}:{label:string;value:number|null;reset:string|null}){return <div><div><strong>{label}</strong><span>{value===null?'—':`${number(value)}%`}</span></div><div className="telemetry-model-track"><i style={{width:`${Math.min(100,value??0)}%`}}/></div><small>{t('重置时间')}: {dateTime(reset)}</small></div>;}
function RateTrend({samples,total}:{samples:any[];total:number}){
  useLocale();const [metric,setMetric]=useState('rpm');
  const values=samples.filter(s=>s[metric]!==null),max=Math.max(1,...values.map(s=>Number(s[metric]))),end=Date.now(),start=end-24*3600000;
  const x=(s:any)=>45+(Date.parse(s.at)-start)/(end-start)*650,y=(s:any)=>185-Number(s[metric])/max*155;
  const paths:string[]=[];let path='',last=0;
  for(const s of values){const at=Date.parse(s.at);if(last&&at-last>300001){paths.push(path);path='';}path+=`${path?'L':'M'}${x(s)},${y(s)} `;last=at;}if(path)paths.push(path);
  return <><div className="tabs telemetry-trend-tabs">{['rpm','tpm','concurrent'].map(v=><button key={v} className={metric===v?'active':''} onClick={()=>setMetric(v)}>{v==='concurrent'?t('当前并发'):v.toUpperCase()}</button>)}</div>{!values.length?<Empty title={t('尚无速率采样')} detail={t('完成平台同步后开始记录，不回填历史流量。')}/>:<><svg className="telemetry-trend" viewBox="0 0 740 225" role="img" aria-label={t('最近 24 小时采样趋势')}>
    {[0,.5,1].map(n=><g key={n}><line x1="45" x2="695" y1={185-n*155} y2={185-n*155} stroke="#e1eae5"/><text x="38" y={189-n*155} textAnchor="end">{number(Math.round(max*n))}</text></g>)}
    {paths.map((d,i)=><path key={i} d={d} fill="none" stroke="#2a796b" strokeWidth="2.5"/>)}
    {values.map(s=><circle key={s.at} cx={x(s)} cy={y(s)} r="3" fill={Number(s[`${metric}_covered`])<total?'#c29354':'#2a796b'}><title>{dateTime(s.at)} · {count(s[metric])} · {coverage({covered:s[`${metric}_covered`],total})}</title></circle>)}
    <text x="45" y="216">{t('24 小时前')}</text><text x="695" y="216" textAnchor="end">{t('现在')}</text></svg><p className="telemetry-chart-note">{t('金色采样点表示覆盖不完整；采样只描述当时速率，不用于还原请求数或结算。')}</p></>}</>;
}
