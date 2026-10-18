import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { localToday, post, useData, yesterday } from './api';
import { Amount } from './PriceDisplay';
import { PlatformIdentity } from './PlatformIdentity';
import { ErrorBox, Field, Form, Loading, Modal, Table, useSession, useToast } from './components';
import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';

export function SettlementProgress({onPrepare}:{onPrepare:(from?:string)=>void}) {
  useLocale();
  const {data,error,loading}=useData(`/api/invoices/preview?from=1970-01-01&to=${yesterday()}`),{user}=useSession();
  return <section className="panel settlement-progress">
    <div className="panel-head"><div><h2>{t('我的结算进度')}</h2><p>{t('截至昨日的全部历史用量 · 北京时间')}</p></div><Link className="text-button" to="/usage">{t('结算用量明细')}</Link></div>
    <ErrorBox error={error}/>{loading?<Loading/>:data&&<>
      <div className="settlement-stages">
        <div><span>{t('已封账待开票应收')} · USD</span><strong><Amount value={data.ready.gross_usd} digits={8} tone="settlement"/></strong><small>{t('{0} 条账号日用量',[data.ready.count])}</small></div>
        <div><span>{t('已归属待核实原始用量')} · USD</span><strong><Amount value={data.provisional.raw_usd} digits={8} tone="pending"/></strong><small>{t('{0} 条账号日用量',[data.provisional.count])}</small></div>
        {user.role==='owner'&&<div><span>{t('待归属原始用量')} · USD</span><strong><Amount value={data.unassigned.raw_usd} digits={8} tone="pending"/></strong><small>{t('{0} 条账号日用量',[data.unassigned.count])}</small></div>}
      </div>
      <div className="settlement-next"><p>{t('待归属和待核实金额均不是应收或利润。已开票记录不重复计入待开票金额。')}</p><button className="button" onClick={()=>onPrepare(data.firstDay??undefined)}>{t('预览结算账单')}</button></div>
      {data.unassigned.count>0&&<p className="form-hint"><Link to="/accounts?unassigned=1">{t('查看待归属账号')}</Link> · {t('账号归属需人工确认，系统不会自动分配。')}</p>}
    </>}
  </section>;
}

export function InvoiceBuilder({users,initialFrom,onClose,onDone}:{users:any[];initialFrom?:string;onClose:()=>void;onDone:()=>void}) {
  useLocale();const {user}=useSession();
  const [userId,setUserId]=useState(user.id),[from,setFrom]=useState(initialFrom??yesterday().slice(0,8)+'01'),[to,setTo]=useState(yesterday());
  const valid=!!from&&!!to&&from<=to&&to<localToday();
  return <Modal wide title={t('生成结算账单')} subtitle={t('先核对分平台明细；仅已归属、已核实且未开票的用量进入本次账单。')} onClose={onClose}>
    <Field label={t('结算成员')}><select aria-label={t('结算成员')} value={userId} onChange={e=>setUserId(e.target.value)}>{users.filter(u=>u.id===user.id||u.parent_id===user.id).map(u=><option key={u.id} value={u.id}>{u.name}{u.id===user.id?t('（我的上游应收）'):t('（直属下级）')}</option>)}</select></Field>
    <div className="form-grid"><Field label={t('开始日期')}><input type="date" required value={from} max={to} onChange={e=>setFrom(e.target.value)}/></Field><Field label={t('结束日期')}><input type="date" required value={to} min={from} max={yesterday()} onChange={e=>setTo(e.target.value)}/></Field></div>
    {valid?<InvoiceReview key={`${userId}:${from}:${to}`} userId={userId} from={from} to={to} onDone={onDone}/>:<ErrorBox error={t('仅可结算已经结束的北京时间日期')}/>}
  </Modal>;
}

function InvoiceReview({userId,from,to,onDone}:{userId:string;from:string;to:string;onDone:()=>void}) {
  useLocale();const toast=useToast(),[busy,setBusy]=useState(false),[refreshing,setRefreshing]=useState(false);
  const query=new URLSearchParams({userId,from,to}),{data,error,loading,refresh}=useData(`/api/invoices/preview?${query}`);
  const ready=data?.ready;
  async function reload(){setRefreshing(true);try{await refresh();}finally{setRefreshing(false);}}
  if(loading)return <Loading/>;
  return <><ErrorBox error={error}/><button className="button" type="button" disabled={refreshing} onClick={reload}><RefreshCw size={14}/>{t('刷新预览')}</button>{data&&<>
    <div className="confirm-amount invoice-preview-total"><div className="confirm-total"><span>{t('本次结算应收 · USD')}</span><Amount value={ready.gross_usd} digits={8} tone="settlement"/></div><div className="confirm-breakdown"><div><span>{t('下级应付')}</span><Amount value={ready.downstream_usd} digits={8}/></div><div><span>{t('本人利润')}</span><Amount value={ready.profit_usd} digits={8} tone="profit"/></div></div></div>
    <p className="form-hint">{t('本次可开票 {0} 条；待归属 {1} 条、已归属待核实 {2} 条、已开票 {3} 条均不重复计入。',[ready.count,data.unassigned.count,data.provisional.count,data.invoiced.count])}</p>
    {data.platforms.length>0&&<Table headers={[t('平台'),t('可开票记录'),t('平台账单合计'),t('应收 USD'),t('下级应付'),t('本人利润')]}>{data.platforms.map((p:any)=><tr key={p.connection_id}><td><PlatformIdentity provider={p.provider} connectionId={p.connection_id} rates={p.ready_rates} historical showId/></td><td>{p.ready_count}</td><td><Amount value={p.ready_raw_usd} digits={8}/></td><td><Amount value={p.ready_gross_usd} digits={8} tone="settlement"/></td><td><Amount value={p.ready_downstream_usd} digits={8}/></td><td><Amount value={p.ready_profit_usd} digits={8} tone="profit"/></td></tr>)}</Table>}
    {!ready.count&&<p className="notice amber">{t('所选期间没有可结算的已核实用量')}</p>}
    {!data.withinLimit&&<ErrorBox error={t('账单金额超出单笔上限，请缩小结算日期范围')}/>}
    {Number(ready.profit_usd)<0&&<p className="notice amber">{t('本账单为负利润，确认后将按真实亏损扣减该成员余额。请核对合同价和下级应付款。')}</p>}
    <p className="form-hint">{t('生成账单不会增加钱包余额，真实回款确认后才记入本人利润。')}</p>
    <Form onSubmit={async()=>{setBusy(true);try{await post('/api/invoices',{userId,from,to,previewToken:data.previewToken});toast(t('结算账单已生成'));onDone();}finally{setBusy(false);}}}><div className="modal-actions"><button className="button primary" type="submit" disabled={busy||refreshing||!!error||!ready.count||!data.withinLimit}>{t('生成账单')}</button></div></Form>
  </>}</>;
}
