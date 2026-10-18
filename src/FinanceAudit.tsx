import { PlatformIdentity } from './PlatformIdentity';
import { Link } from 'react-router-dom';
import { dateTime } from './api';
import { Amount } from './PriceDisplay';
import { Badge,Modal,Table } from './components';
import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';

export function FinanceAudit({report,users,onClose}:{report:any;users:any[];onClose:()=>void}) {
  useLocale();
  const names=new Map(users.map(u=>[u.id,u.name]));
  return <Modal wide title={t('全平台资金核对')} subtitle={dateTime(report.checkedAt)} onClose={onClose}>
    <div className={`notice ${report.ok?'':'amber'}`}><strong>{report.ok?t('账目一致性核对通过'):t('发现账目异常，请先核对原始凭证')}</strong></div>
    <p className="form-hint">{t('已核对 {0} 个钱包、{1} 条已封账和 {2} 条预估用量。',[report.checked.wallets,report.checked.finalizedUsageDays,report.checked.provisionalUsageDays])}</p>
    <div className="finance-audit-totals"><div><span>{t('全平台可提现利润')} · USD</span><Amount value={report.totals.available_profit_usd} digits={8} tone="settlement"/></div><div><span>{t('全平台提现冻结')} · USD</span><Amount value={report.totals.pending_withdrawal_usd} digits={8} tone="pending"/></div></div>
    {report.inventory.awaiting_attribution>0&&<div className="notice amber"><span>{t('仍有 {0} 个待归属账号，确认归属前不产生代理收益。',[report.inventory.awaiting_attribution])} <Link to="/accounts?unassigned=1" onClick={onClose}>{t('查看待归属账号')}</Link></span></div>}
    <h3>{t('平台账单进度')}</h3>
    <Table headers={[t('平台'),t('已归属 / 平台绑定'),t('历史待核实 USD'),t('已封账原始账单 USD'),t('管理员待开票应收 USD')]}>{report.platforms.map((p:any)=><tr key={p.id}>
      <td><div className="binding-list"><div><PlatformIdentity provider={p.provider} connectionId={p.id}/></div><small>{p.id.slice(0,8)} · <Badge state={p.enabled?p.status:'disabled'}/></small><small>{t('最近同步')} {dateTime(p.last_sync_at)}</small></div></td>
      <td>{p.assigned}/{p.accounts}<small>{t('待归属 {0} 个',[p.unassigned])}</small></td>
      <td><Amount value={p.awaiting_finalization_raw_usd} tone="pending"/><small>{t('{0} 条账号日用量',[p.awaiting_finalization_days])}</small></td>
      <td><Amount value={p.finalized_raw_usd}/></td><td><Amount value={p.uninvoiced_receivable_usd} tone="settlement"/></td>
    </tr>)}</Table>
    <p className="form-hint">{t('历史待核实仅包含北京时间已结束日期的预估记录；需取得完整日账单后核实封账。')} <Link to="/usage" onClick={onClose}>{t('结算用量明细')}</Link></p>
    <h3>{t('各代理资金余额')}</h3>
    <Table headers={[t('结算成员'),t('可提现利润 · USD'),t('提现冻结中'),t('已确认利润 USD'),t('已打款 USD')]}>{report.wallets.map((w:any)=><tr key={w.id}><td><strong>{names.get(w.id)??w.id.slice(0,8)}</strong></td><td><Amount value={w.available} digits={8} tone="settlement"/></td><td><Amount value={w.pending} digits={8} tone="pending"/></td><td><Amount value={w.confirmed_profit_usd} digits={8}/></td><td><Amount value={w.paid_withdrawal_usd} digits={8}/></td></tr>)}</Table>
    <p className="form-hint">{t('各成员余额独立计算，平台原始账单按平台绑定只统计一次。')}</p>
    {report.findings.length>0&&<div className="notice amber"><div><strong>{t('异常记录 {0} 项',[report.findings.length])}</strong>{report.findings.map((f:any,i:number)=><p key={i}>{f.message?t(f.message):t('数据归属或收益链异常，请核对原始记录。')} <small>{f.code} · {f.ids.slice(0,3).join(', ')}{f.ids.length>3?'…':''}</small></p>)}</div></div>}
  </Modal>;
}
