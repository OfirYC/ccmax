import { useState } from 'react';
import { Download } from 'lucide-react';
import { day, dateTime, post, useData } from './api';
import { Amount } from './PriceDisplay';
import { Badge, Empty, ErrorBox, Field, Form, Loading, Modal, Paginator, Submit, Table, useToast } from './components';
import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';
import { PlatformIdentity } from './PlatformIdentity';
import { platformName } from './platforms';

export function DailyBilling({from,to,provider}:{from:string;to:string;provider:string}) {
  useLocale();
  const [page,setPage]=useState(1),[detail,setDetail]=useState<any>(null),[finalize,setFinalize]=useState<any>(null),toast=useToast();
  const query=new URLSearchParams({from,to,provider,page:String(page)});
  const {data,error,loading,refresh}=useData('/api/billing/days?'+query,10000);
  async function finalizeSnapshot(form:FormData) {
    await post('/api/billing/finalize-snapshot',{connectionId:finalize.connection_id,day:day(finalize.day),evidence:form.get('evidence')});
    toast(t('快照已核实并生成账单'));
    setFinalize(null);setDetail(null);await refresh();
  }
  return <section className="panel daily-billing-panel">
    <div className="panel-head"><h2>{t('账单更新记录')}</h2></div>
    <ErrorBox error={error}/>{loading?<Loading/>:data?.rows.length?<><Table headers={[t('账单日期（北京时间）'),t('平台'),t('状态'),t('平台账单 USD'),t('账号入账进度'),t('操作')]}>{data.rows.map((r:any)=><tr key={r.connection_id+r.day}>
      <td><strong>{day(r.day)}</strong><small>{dateTime(r.last_attempt_at)}</small></td><td><PlatformIdentity provider={r.provider} connectionId={r.connection_id}/>{r.basis==='snapshot'&&!r.reviewed&&<small>{t('快照预估')}</small>}</td><td><Badge state={r.state} label={r.state==='succeeded'?t('账单已生成'):undefined}/>{r.issue_count>0&&r.state!=='awaiting_data'&&<small>{t('{0} 项待处理',[r.issue_count])}</small>}</td>
      <td className="amount-cell">{r.raw_usd===null||r.raw_usd===undefined?'—':<Amount value={r.raw_usd}/>}</td><td>{r.statement_id?`${r.finalized_count} / ${r.account_count}`:'—'}</td><td><div className="row-actions"><button onClick={()=>setDetail(r)}>{t('详情')}</button>{r.statement_id&&<a href={`/api/billing/statements/${r.statement_id}`} download><Download size={14}/>{t('原始日账单')}</a>}</div></td>
    </tr>)}</Table><Paginator total={data.total} page={page} setPage={setPage}/></>:<Empty title={t('等待账单更新')}/>}
    {detail&&<Modal title={t('账单详情')} subtitle={`${platformName(detail.provider)} · ${day(detail.day)}`} onClose={()=>setDetail(null)}><ErrorBox error={detail.error}/><Badge state={detail.state} label={detail.state==='succeeded'?t('账单已生成'):undefined}/>{detail.statement_id&&<><p>{t('来源账单已存档')}</p>{detail.basis==='snapshot'&&!detail.reviewed&&<p className="warning-text">{t('快照预估')}</p>}</>}{detail.issues?.length>0&&detail.state!=='awaiting_data'&&<Table headers={[t('账号 / 成员'),t('待处理原因')]}>{detail.issues.map((issue:any,i:number)=><tr key={i}><td className="break-word">{issue.externalId||issue.userId||'—'}</td><td>{t(issue.message)}</td></tr>)}</Table>}{detail.day<new Date(Date.now()+8*3600000).toISOString().slice(0,10)&&detail.state!=='succeeded'&&<div className="modal-actions"><button className="button primary" onClick={()=>setFinalize(detail)}>{t('核实并结算快照')}</button></div>}</Modal>}
    {finalize&&<Modal title={t('核实并结算快照')} subtitle={`${platformName(finalize.provider)} · ${day(finalize.day)}`} onClose={()=>setFinalize(null)}><p className="form-hint">{t('该日期仍有实时或快照预估。确认后将按现有快照封账并生成账单。')}</p><Form onSubmit={finalizeSnapshot}><Field label={t('核实依据 / 说明')}><textarea name="evidence" required minLength={5} maxLength={2000} rows={4} placeholder={t('填写已核对的平台账单或快照依据')}/></Field><div className="modal-actions"><Submit>{t('确认快照并生成账单')}</Submit></div></Form></Modal>}
  </section>;
}
