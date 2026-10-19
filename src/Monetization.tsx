import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BadgeDollarSign, CheckCircle2, CircleDollarSign, Wallet, Zap } from 'lucide-react';
import { bestQuote, calculateQuotedEarnings, monetizationReference } from '../shared/monetization';
import { platformName } from '../shared/platforms';
import { money, useData } from './api';
import { Empty, ErrorBox, Field, Loading } from './components';
import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';

export function MonetizationSteps() {
  useLocale();
  return <ol className="monetization-steps"><li><span>01</span><div><strong>{t('查看专属报价')}</strong><small>{t('了解每份用量的结算价格')}</small></div></li><li><span>02</span><div><strong>{t('添加你的 Max 账号')}</strong><small>{t('完成账号授权，开始产生用量')}</small></div></li><li><span>03</span><div><strong>{t('核实账单，申请提现')}</strong><small>{t('用量结算后，可按余额申请提现')}</small></div></li></ol>;
}

export function MonetizationPitch({ compact = false, headline = false }: { compact?: boolean; headline?: boolean }) {
  useLocale();
  const Heading = headline ? 'h1' : 'h2';
  return <div className={`monetization-pitch ${compact ? 'compact' : ''}`}><span className="marketing-kicker"><Zap size={15}/>{t('Claude Max 20x · 账号变现')}</span><Heading>{t('让闲置 Max 额度，')}<br/><em>{t('变成看得见的收益。')}</em></Heading><p>{t('已经有 Max 账号？查看专属报价，接入闲置额度。有效用量按账单结算，每个账号赚了多少，随时有据可查。')}</p><div className="monetization-benefits"><span><CircleDollarSign size={17}/>{t('先看报价，再添加账号')}</span><span><CheckCircle2 size={17}/>{t('周月应收，逐号可查')}</span><span><Wallet size={17}/>{t('结算确认，按余额提现')}</span></div>{!compact && <MonetizationSteps/>}</div>;
}

export function MonetizationOverview() {
  useLocale();
  return <section className="monetization-overview"><span className="marketing-kicker">{t('从账号接入，到收益到账')}</span><h2>{t('收益的每一步，都看得清。')}</h2><MonetizationSteps/><div className="income-features"><article><CircleDollarSign size={20}/><h3>{t('一个账号，一份收益记录')}</h3><p>{t('近 7 天、近 30 天已核实应收分别展示，还能填入实际成本核算收入。')}</p></article><article><CheckCircle2 size={20}/><h3>{t('每笔收入，都有账单依据')}</h3><p>{t('按有效日账单和当日约定报价核算，历史价格留存，结算明细可追溯。')}</p></article><article><Wallet size={20}/><h3>{t('从应收到提现，进度透明')}</h3><p>{t('区分预估、已核实应收和可提现余额，确认结算后再按余额申请提现。')}</p></article></div></section>;
}

// This is a quote conversion, never an invented subscription quota. Historical
// settled earnings are shown separately with their frozen prices after login.
export function EarningsCalculator({ rates, quoteSource = 'invitation' }: { rates: Record<string, unknown>; quoteSource?: 'invitation' | 'current' }) {
  useLocale();
  const preferred = bestQuote(rates), [selection, setSelection] = useState('');
  const provider = selection && bestQuote({ value: rates[selection] }) ? selection : preferred?.provider;
  const rate = provider === undefined ? null : rates[provider];
  const [weekly, setWeekly] = useState(''), [monthly, setMonthly] = useState('');
  const [subscription, setSubscription] = useState(''), [proxy, setProxy] = useState('');
  const result = rate === null || rate === undefined ? null : calculateQuotedEarnings({ weeklyBillableUsd: weekly, monthlyBillableUsd: monthly, rate: String(rate), subscriptionUsd: subscription, monthlyProxyUsd: proxy });
  return <section className="earnings-calculator" aria-label={t('Max 20x 收益核算')}>
    <div className="calculator-heading"><span className="marketing-kicker"><BadgeDollarSign size={15}/>{t('你的专属结算价格')}</span><h3>{t('每一份有效用量，都有明确报价。')}</h3></div>
    {!preferred ? <p className="calculator-missing">{t('还没有可用报价，请先向邀请人确认结算价格。')}</p> : <>
      <div className="quote-conversion"><span>{t('每 $1 已核实账单，可结算')}</span><strong data-testid="unit-earnings">${Number(rate).toFixed(4)}</strong><small>{quoteSource === 'invitation' ? t('按本邀请的专属报价计算') : t('按你的当前报价计算')} · {provider && platformName(provider)}</small></div>
      <p className="calculator-footnote">{t('已核实账单金额 × 约定报价 = 应收。实际收入随有效用量变化，订阅和代理等成本需另计。')}</p>
      <details className="calculator-details"><summary>{t('用已有账单核算收入')}</summary><p className="calculator-intro">{t('填入两个期间各自的实际账单金额；不将周金额放大为月收入。历史实际结算请登录查看。')}</p><div className="calculator-inputs">
        <Field label={t('用于核算的结算报价')}><select aria-label={t('用于核算的结算报价')} value={provider} onChange={e => setSelection(e.target.value)}>{Object.entries(rates).filter(([, value]) => bestQuote({ value }) !== null).map(([key, value]) => <option key={key} value={key}>{platformName(key)} · × {Number(value).toFixed(4)}</option>)}</select></Field>
        <Field label={t('近 7 天实际账单（USD）')}><input aria-label={t('近 7 天实际账单（USD）')} type="number" min="0" step="0.00000001" value={weekly} onChange={e => setWeekly(e.target.value)}/></Field>
        <Field label={t('近 30 天实际账单（USD）')}><input aria-label={t('近 30 天实际账单（USD）')} type="number" min="0" step="0.00000001" value={monthly} onChange={e => setMonthly(e.target.value)}/></Field>
      </div><div className="calculator-results" aria-live="polite"><div><span>{t('7 天账单 × 所选报价')}</span><strong data-testid="weekly-earnings">{result?.week == null ? '—' : money(result.week)}</strong></div><div><span>{t('30 天账单 × 所选报价')}</span><strong data-testid="monthly-earnings">{result?.month == null ? '—' : money(result.month)}</strong></div></div>
        <div className="calculator-inputs"><Field label={t('实际 30 天订阅成本（USD）')}><input aria-label={t('实际 30 天订阅成本（USD）')} type="number" min="0" step="0.01" value={subscription} onChange={e => setSubscription(e.target.value)}/></Field><Field label={t('实际 30 天代理等成本（USD）')}><input aria-label={t('实际 30 天代理等成本（USD）')} type="number" min="0" step="0.01" value={proxy} onChange={e => setProxy(e.target.value)}/></Field></div>
        <div className={`calculator-net ${result?.monthAfterCosts != null && Number(result.monthAfterCosts) < 0 ? 'negative' : ''}`}><span>{t('30 天核算收入 − 已填成本')}</span><strong data-testid="net-earnings">{result?.monthAfterCosts == null ? '—' : money(result.monthAfterCosts)}</strong></div>
        <p className="calculator-footnote">{t('金额和成本均不预填。结果仅按所选报价核算；同一份用量不能叠加多个渠道报价，也不代表已收款或可提现。')}</p>
      </details>
    </>}
  </section>;
}

export function VerifiedAccountEarnings() {
  useLocale();
  const { data, loading, error } = useData('/api/monetization', 30000);
  return <section className="panel verified-earnings"><div className="panel-head"><div><h2>{t('我的账号，实际赚了多少？')}</h2><p>{t('近 7 / 30 个已结束的北京时间日期 · 仅本人已核实归属的账号')}</p></div><Link className="text-button" to="/usage">{t('查看明细')}<ArrowRight size={14}/></Link></div><ErrorBox error={error}/>{loading ? <Loading/> : data?.accounts?.length ? <div className="verified-account-grid">{data.accounts.map((account: any) => <VerifiedAccountCard key={account.id} account={account}/>)}</div> : !error && <Empty title={t('添加账号，积累你的第一份收益记录')} detail={t('完成授权并产生已核实日账单后，自动展示每个账号的周/月实际应收。')}/>}
    <p className="verified-earnings-note">{t('按账单当日约定报价统计，记录不足时仅显示已有应收。应收未扣订阅及代理成本，已确认利润不等于已打款。')}</p>
  </section>;
}

function VerifiedAccountCard({ account }: { account: any }) {
  useLocale();
  const [subscription, setSubscription] = useState(''), [proxy, setProxy] = useState('');
  const monthly = account.periods['30d'];
  const net = calculateQuotedEarnings({ rate: '1', weeklyBillableUsd: '', monthlyBillableUsd: monthly.complete && monthly.grossUsd !== null ? monthly.grossUsd : '', subscriptionUsd: subscription, monthlyProxyUsd: proxy });
  return <article><h3>{account.email}</h3><div className="calculator-results">{(['7d', '30d'] as const).map(period => {
    const p = account.periods[period];
    return <div key={period}><span>{period === '7d' ? t('近 7 天已核实应收') : t('近 30 天已核实应收')}</span><strong>{p.grossUsd === null ? '—' : money(p.grossUsd)}</strong><small>{p.from} — {p.to}</small><small>{t('已核实 {0}/{1} 份日账单', [p.verifiedBindingDays, p.expectedBindingDays])} · {p.complete ? t('期间完整') : t('记录不完整')}</small>{(p.snapshotBindingDays > 0 || p.provisionalBindingDays > 0) && <small>{t('快照预估 {0} 条，实时预估 {1} 条，未计入以上金额。', [p.snapshotBindingDays, p.provisionalBindingDays])}</small>}</div>;
  })}</div><p className="verified-confirmed">{t('其中近 30 天已确认利润：{0}', [account.periods['30d'].confirmedProfitUsd === null ? '—' : money(account.periods['30d'].confirmedProfitUsd)])}</p><details className="calculator-details"><summary>{t('核算扣成本后的收入')}</summary><div className="calculator-inputs"><Field label={t('实际 30 天订阅成本（USD）')}><input aria-label={t('实际 30 天订阅成本（USD）')} type="number" min="0" step="0.01" value={subscription} onChange={e => setSubscription(e.target.value)}/></Field><Field label={t('实际 30 天代理等成本（USD）')}><input aria-label={t('实际 30 天代理等成本（USD）')} type="number" min="0" step="0.01" value={proxy} onChange={e => setProxy(e.target.value)}/></Field></div><div className={`calculator-net ${net?.monthAfterCosts != null && Number(net.monthAfterCosts) < 0 ? 'negative' : ''}`}><span>{t('完整 30 天应收 − 实填成本')}</span><strong>{net?.monthAfterCosts == null ? '—' : money(net.monthAfterCosts)}</strong></div><p className="calculator-footnote">{t('账单记录不足 30 天时，暂不计算 30 天净收入。')}</p></details></article>;
}

export function MonetizationFaq() {
  useLocale();
  return <section className="monetization-faq"><h2>{t('开始之前，你可能想知道')}</h2><details><summary>{t('一个 Max 20x 账号，每周、每月能赚多少？')}</summary><p>{t('官方规定：Max 20x 每 5 小时额度为 Pro 的 20 倍，另有独立周限制；未公布统一的周/月美元用量。')}</p><p>{t('官方未公布固定周/月 Token 数或美元用量。周额度在账号指定的固定时间重置；不能用订阅价格或使用百分比推算最高收入。')}</p><p>{t('接入后可在首页查看每个账号近 7 天、近 30 天的已核实应收；账单记录不足时会显示覆盖情况，不把预估当作到账。')}</p><a href={monetizationReference.usageSource} target="_blank" rel="noreferrer">{t('查看 Claude 官方用量说明')} <ArrowRight size={12}/></a></details><details><summary>{t('注册后，怎样开始？')}</summary><p>{t('使用 CCMAX 登录邮箱进入工作空间，添加 Claude 账号，为账号绑定专属固定出口代理并完成授权。产生有效用量后，系统按日核实账单。')}</p></details><details><summary>{t('官方每月 $200 API credits 是什么？')}</summary><p>{t('这是 Max 20x 另含的 API 赠金，符合条件后需关联 Console 组织领取，到期不结转。不能用于交互式 Claude Code、订阅额外用量，也不改变订阅的周额度。')}</p><a href={monetizationReference.apiCreditsSource} target="_blank" rel="noreferrer">{t('查看 API 赠金规则')} <ArrowRight size={12}/></a></details><details><summary>{t('接入后还能自己使用账号吗？')}</summary><p>{t('自己的使用与接入产生的使用会占用同一份订阅额度，请按你的实际需求安排可用额度。')}</p></details><details><summary>{t('什么时候可以提现？')}</summary><p>{t('产生实际用量后，系统按日核实账单。直属上级确认结算后，利润进入可提现余额；实际打款按提现流程处理。')}</p></details></section>;
}
