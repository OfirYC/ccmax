import { useState } from 'react';
import { Download } from 'lucide-react';
import { day, dateTime, useData } from './api';
import { Amount } from './PriceDisplay';
import { Badge, Empty, ErrorBox, Loading, Modal, Paginator, Table } from './components';
import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';
import { PlatformIdentity } from './PlatformIdentity';
import { platformName } from '../shared/platforms';

export function DailyBilling({from,to,provider}:{from:string;to:string;provider:string}) {
  useLocale();
  const [page,setPage]=useState(1),[detail,setDetail]=useState<any>(null);
  const query=new URLSearchParams({from,to,provider,page:String(page)});
  const {data,error,loading}=useData('/api/billing/days?'+query,10000);
  return <section className="panel daily-billing-panel">
    <div className="panel-head"><h2>{t('账单更新记录')}</h2></div>
    <ErrorBox error={error}/>{loading?<Loading/>:data?.rows.length?<><Table headers={[t('账单日期（北京时间）'),t('平台'),t('状态'),t('平台账单 USD'),t('账号入账进度'),t('操作')]}>{data.rows.map((r:any)=><tr key={r.connection_id+r.day}>
      <td><strong>{day(r.day)}</strong><small>{dateTime(r.last_attempt_at)}</small></td><td><PlatformIdentity provider={r.provider} connectionId={r.connection_id}/>{r.basis==='snapshot'&&<small>{t('快照预估')}</small>}</td><td><Badge state={r.state}/>{r.issue_count>0&&<small>{t('{0} 项待处理',[r.issue_count])}</small>}</td>
      <td className="amount-cell"><Amount value={r.raw_usd}/></td><td>{r.statement_id?`${r.finalized_count} / ${r.account_count}`:'—'}</td><td><div className="row-actions"><button onClick={()=>setDetail(r)}>{t('详情')}</button>{r.statement_id&&<a href={`/api/billing/statements/${r.statement_id}`} download><Download size={14}/>{t('原始日账单')}</a>}</div></td>
    </tr>)}</Table><Paginator total={data.total} page={page} setPage={setPage}/></>:<Empty title={t('等待账单更新')}/>}
    {detail&&<Modal title={t('账单详情')} subtitle={`${platformName(detail.provider)} · ${day(detail.day)}`} onClose={()=>setDetail(null)}><ErrorBox error={detail.error}/>{detail.basis==='snapshot'&&<p className="warning-text">{t('快照预估')}</p>}{detail.issues?.length>0&&<Table headers={[t('账号 / 成员'),t('待处理原因')]}>{detail.issues.map((issue:any,i:number)=><tr key={i}><td className="break-word">{issue.externalId||issue.userId||'—'}</td><td>{t(issue.message)}</td></tr>)}</Table>}</Modal>}
  </section>;
}
