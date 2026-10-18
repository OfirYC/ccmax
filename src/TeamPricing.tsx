import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, RefreshCw } from 'lucide-react';
import { post } from './api';
import { Amount, RateBadge } from './PriceDisplay';
import { ErrorBox, Field, Form, Modal, Table, useSession, useToast } from './components';
import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';

export function PricingNotice({report}:{report:any}) {
  useLocale();
  if(!report?.risks.length)return null;
  const inverted=report.risks.filter((r:any)=>r.kind==='inverted');
  return <Link to="/team" className={`notice ${inverted.length?'pricing-warning':'amber'}`}><AlertTriangle size={18}/><span><strong>{inverted.length?t('结算价格倒挂提醒'):t('结算价格尚不完整')}</strong><br/>{t('原价继续生效，请检查当前及待生效报价，并按需批量调整直属下级。')}</span><ArrowRight size={17}/></Link>;
}

function RiskRows({risks,today}:{risks:any[];today?:string}) {
  return <Table headers={[t('生效日期'),t('承担风险的上级'),t('下级成员'),t('上级应收折扣'),t('下级折扣'),t('每 $100 账单的损失')]}>{risks.map((r:any,i:number)=><tr key={`${r.payerId}-${r.userId}-${r.provider}-${r.date}-${i}`}><td>{r.date}{r.date===today&&<small>{t('当前生效')}</small>}</td><td>{r.payerName}</td><td><strong>{r.userName}</strong><small>{r.provider}</small></td><td><RateBadge value={r.ownRate}/></td><td><RateBadge value={r.childRate}/></td><td>{r.kind==='inverted'?<Amount value={'-'+r.lossPer100Usd} tone="profit"/>:<span className="error-text">{t('缺少报价，无法评估')}</span>}</td></tr>)}</Table>;
}

export function TeamPriceOverview({report,error,onRefresh}:{report:any;error:string;onRefresh:()=>void}) {
  useLocale();
  const {user}=useSession();
  return <section className="panel team-pricing-panel"><div className="panel-head"><div><h2>{t('价格与差价风险')}</h2><p>{t('保留原价并提醒；每位上级自行管理直属下级报价。')}</p></div><button className="button" onClick={onRefresh}><RefreshCw size={14}/>{t('刷新价格')}</button></div><ErrorBox error={error}/>{report&&<>
    <div className="own-price-grid">{report.prices.map((p:any)=><div key={p.provider}><strong>{p.provider}</strong><span>{t('我的当前应收折扣')}</span><RateBadge value={p.currentRate}/><span>{t('次日应收折扣')} · {report.effectiveDate}</span><RateBadge value={p.nextRate}/>{user.role==='owner'&&p.connectionCount>1&&<small>{t('多个主账号按最低应收折扣评估')}</small>}</div>)}</div>
    {report.risks.length?<details className="price-risk-details" open><summary><AlertTriangle size={17}/>{t('发现 {0} 项当前或待生效价格风险',[report.risks.length])}</summary><p>{t('原价继续生效；倒挂产生的负利润仍按真实差价记账。')}</p><RiskRows risks={report.risks} today={report.today}/></details>:<p className="pricing-ok">{t('当前及待生效报价未发现直属下级倒挂。')}</p>}
  </>}</section>;
}

export function BatchPricing({report,providers,onClose,onDone}:{report:any;providers:[string,any][];onClose:()=>void;onDone:()=>Promise<void>}) {
  useLocale();
  const toast=useToast();
  const [provider,setProvider]=useState(providers[0]?.[0]||''),[mode,setMode]=useState('cap'),[value,setValue]=useState(''),[selected,setSelected]=useState<string[]>([]),[plan,setPlan]=useState<any>(null),[acknowledge,setAcknowledge]=useState(false);
  const users=report?.directUsers||[],own=report?.prices.find((p:any)=>p.provider===provider);
  const allSelected=users.length>0&&users.slice(0,500).every((u:any)=>selected.includes(u.id));
  const change=()=>{setPlan(null);setAcknowledge(false);};
  const input=()=>({provider,mode,userIds:selected,...mode==='cap'?{}:{value:Number(value)}});
  return <Modal title={t('批量调整直属下级价格')} subtitle={t('先预览差价；保存后次日北京时间 00:00 生效，不改历史账单。')} onClose={onClose} wide>
    <Form onSubmit={async()=>{
      if(!plan){const result=await post('/api/team/rates/preview',input());setPlan(result);setAcknowledge(false);return;}
      try{
        const result=await post('/api/team/rates/batch',{...input(),snapshot:plan.snapshot,acknowledgeRisk:acknowledge});
        toast(t('已调整 {0} 位直属下级，{1} 00:00 北京时间生效',[result.changedCount,result.effectiveDate]));await onDone();onClose();
      }catch(e){setPlan(null);setAcknowledge(false);throw e;}
    }}>
      <div className="form-grid"><Field label={t('调价平台')}><select name="provider" value={provider} onChange={e=>{setProvider(e.target.value);change();}}>{providers.map(([p,v])=><option value={p} key={p}>{v.name}</option>)}</select></Field><Field label={t('调价方式')}><select name="mode" value={mode} onChange={e=>{setMode(e.target.value);setValue('');change();}}><option value="cap">{t('仅下调超出应收上限的报价')}</option><option value="fixed">{t('统一设置折扣')}</option><option value="scale">{t('按比例下调现有折扣')}</option></select></Field></div>
      <div className="batch-own-price"><span>{t('次日应收折扣')}</span><RateBadge value={own?.nextRate}/>{mode==='cap'&&<small>{t('上限模式只降低超出部分，调整后该部分差价为零。')}</small>}</div>
      {mode!=='cap'&&<Field label={mode==='fixed'?t('新的统一折扣'):t('下调比例')} hint={mode==='fixed'?t('例如 0.20：平台账单 $100，下级应收 $20。'):t('例如 0.80：将每位成员待生效折扣乘以 0.80，保留不同报价。')}><input className="rate-input" name="value" type="number" min="0" max="1" step="0.0001" required value={value} onChange={e=>{setValue(e.target.value);change();}}/></Field>}
      <div className="batch-member-head"><strong>{t('选择直属下级')} · {selected.length}/{users.length}</strong><button className="text-button" type="button" onClick={()=>{setSelected(allSelected?[]:users.slice(0,500).map((u:any)=>u.id));change();}}>{allSelected?t('清空选择'):t('选择全部')}</button></div>
      <div className="batch-members">{users.map((u:any)=><label className="check-row" key={u.id}><input type="checkbox" aria-label={t('选择成员 {0}',[u.name])} checked={selected.includes(u.id)} disabled={selected.length>=500&&!selected.includes(u.id)} onChange={e=>{setSelected(s=>e.target.checked?[...s,u.id]:s.filter(id=>id!==u.id));change();}}/>{u.name}{!u.active&&<small>{t('已停用')}</small>}</label>)}</div>
      <p className="form-hint">{t('最多选择 500 位直属下级；已排定的次日价格会在预览中显示，并由新报价替换。')}</p>
      {plan&&<div className="batch-preview"><h3>{t('调价预览')} · {plan.effectiveDate}</h3><Table headers={[t('下级成员'),t('当前报价'),t('原次日折扣'),t('新次日折扣'),t('我的每 $100 差价')]}>{plan.items.map((item:any)=><tr key={item.userId}><td>{item.userName}{!item.changed&&<small>{t('无需变更')}</small>}</td><td><RateBadge value={item.currentRate}/></td><td><RateBadge value={item.beforeRate}/></td><td><RateBadge value={item.afterRate}/></td><td><Amount value={item.marginPer100Usd} tone="profit"/></td></tr>)}</Table>
        {!!plan.risks.length&&<div className="batch-risk"><h3><AlertTriangle size={17}/>{t('本次调价仍有风险')}</h3><p>{t('请检查本层倒挂，以及下调后代理对其下级的倒挂或缺价。')}</p><RiskRows risks={plan.risks}/><label className="check-row"><input type="checkbox" checked={acknowledge} onChange={e=>setAcknowledge(e.target.checked)}/>{t('我已核对以上风险，仍按预览报价调整，并自行协调下级。')}</label></div>}
      </div>}
      <div className="modal-actions"><button className="button" type="button" onClick={onClose}>{t('取消')}</button><button className="button primary" type="submit" disabled={!selected.length||selected.length>500||(plan&&(!plan.changedCount||(plan.risks.length&&!acknowledge)))}>{plan?t('确认批量调价'):t('预览调价结果')}</button></div>
    </Form>
  </Modal>;
}
