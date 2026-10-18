import { useState } from 'react';
import { CalendarDays, Download, RefreshCw } from 'lucide-react';
import { day, dateTime, post, useData, yesterday } from './api';
import { Amount } from './PriceDisplay';
import { Badge, Empty, ErrorBox, Field, Form, Loading, Modal, Paginator, Submit, Table, useToast } from './components';
import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';
import { PlatformIdentity, platformOptionLabel } from './PlatformIdentity';
import { platformName } from '../shared/platforms';

export function DailyBilling({from,to,provider,connections}:{from:string;to:string;provider:string;connections:any[]}) {
  useLocale();
  const [page,setPage]=useState(1),[collect,setCollect]=useState(false),[detail,setDetail]=useState<any>(null),toast=useToast();
  const query=new URLSearchParams({from,to,provider,page:String(page)});
  const {data,error,loading,refresh}=useData('/api/billing/days?'+query,10000);
  return <section className="panel daily-billing-panel">
    <div className="panel-head"><div><h2>{t('每日自动账单库')}</h2><p>{t('每天北京时间 02:00 后采集完整日账单，自动计算各层金额并生成待确认账单。失败自动重试，异常单独列出。')}</p></div><div className="row-actions"><button className="button" onClick={refresh}><RefreshCw size={15}/>{t('刷新')}</button><button className="button primary" onClick={()=>setCollect(true)}><CalendarDays size={15}/>{t('补采历史账单')}</button></div></div>
    <ErrorBox error={error}/>{loading?<Loading/>:data?.rows.length?<><Table headers={[t('账单日期（北京时间）'),t('平台'),t('采集状态'),t('平台账单 USD'),t('账号入账进度'),t('操作')]}>{data.rows.map((r:any)=><tr key={r.connection_id+r.day}>
      <td><strong>{day(r.day)}</strong><small>{dateTime(r.last_attempt_at)}</small></td><td><PlatformIdentity provider={r.provider} connectionId={r.connection_id}/><small>{r.basis==='snapshot'?t('快照预估'):r.basis==='upstream'?t('上游完整日账单'):'—'}</small></td><td><Badge state={r.state}/>{r.issue_count>0&&<small>{t('{0} 项待处理',[r.issue_count])}</small>}</td>
      <td className="amount-cell"><Amount value={r.raw_usd}/></td><td>{r.statement_id?`${r.finalized_count} / ${r.account_count}`:'—'}</td><td><div className="row-actions"><button onClick={()=>setDetail(r)}>{t('详情')}</button>{r.statement_id&&<a href={`/api/billing/statements/${r.statement_id}`} download><Download size={14}/>{t('原始日账单')}</a>}</div></td>
    </tr>)}</Table><Paginator total={data.total} page={page} setPage={setPage}/></>:<Empty title={t('等待每日自动采集')} detail={t('系统自动补采最近 30 天内已接入日期的缺失账单，也可指定日期立即采集。')}/>}
    {collect&&<Modal title={t('补采历史账单')} subtitle={t('每次最多 31 天；重复采集不会重复计费或出账。')} onClose={()=>setCollect(false)}><Form onSubmit={async f=>{
      const selected=f.get('connectionId'),connectionIds=connections.filter(c=>c.enabled&&(!selected||c.id===selected)).map(c=>c.id);
      await post('/api/billing/collect',{connectionIds,from:f.get('from'),to:f.get('to')});toast(t('账单采集已排队，完成后自动入账和出账'));setCollect(false);await refresh();
    }}><Field label={t('平台连接')}><select name="connectionId"><option value="">{t('全部平台')}</option>{connections.filter(c=>c.enabled).map(c=><option key={c.id} value={c.id}>{platformOptionLabel(c)}</option>)}</select></Field><div className="form-grid"><Field label={t('开始日期')}><input name="from" type="date" required max={yesterday()} defaultValue={yesterday()}/></Field><Field label={t('结束日期')}><input name="to" type="date" required max={yesterday()} defaultValue={yesterday()}/></Field></div><div className="modal-actions"><Submit>{t('开始自动采集')}</Submit></div></Form></Modal>}
    {detail&&<Modal title={t('每日账单采集详情')} subtitle={`${platformName(detail.provider)} · ${day(detail.day)}`} onClose={()=>setDetail(null)}><ErrorBox error={detail.error}/>{detail.basis==='snapshot'&&<div className="notice amber">{t('本账单包含日终快照预估，可能缺少上游尚未更新的末尾用量，请按约定结算。')}</div>}<p>{t('采集 {0} 次，已入账 {1} / {2} 个账号',[detail.attempts,detail.finalized_count,detail.account_count])}</p>{detail.issues?.length>0&&<Table headers={[t('账号 / 成员'),t('待处理原因')]}>{detail.issues.map((issue:any,i:number)=><tr key={i}><td className="break-word">{issue.externalId||issue.userId||'—'}</td><td>{t(issue.message)}</td></tr>)}</Table>}<p className="form-hint">{t('原始金额已存档。补齐归属或历史折扣后系统自动重试；已封账金额冲突会保留原账并提示核对。')}</p><p className="form-hint">{t('自动出账不代表收到回款，也不会发起转账。')}</p></Modal>}
  </section>;
}
