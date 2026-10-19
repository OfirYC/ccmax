import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, ShieldCheck, Zap } from 'lucide-react';
import LanguageSwitcher, { useLocale } from './LanguageSwitcher';
import { post, useData } from './api';
import { ErrorBox, Field, Form, Loading, Submit } from './components';
import { RateBadge } from './PriceDisplay';
import { EarningsCalculator, HistoricalWeeklyPeak, MonetizationFaq, MonetizationOverview, MonetizationPitch } from './Monetization';
import { t } from './i18n';

export default function InviteRegistration({ token, signedIn }: { token: string; signedIn: boolean }) {
  useLocale();
  const { data, error, loading } = useData(`/api/invitations/${encodeURIComponent(token)}`), [done, setDone] = useState(false);
  return <div className="monetization-shell"><header className="monetization-header"><Link className="brand" to="/"><span className="brand-symbol"><Zap size={22} fill="currentColor"/></span><span>CCMAX<span className="brand-dot">.</span></span></Link><LanguageSwitcher/></header>
    {loading ? <Loading/> : done ? <main className="invite-card invite-success"><CheckCircle2 size={38}/><h1>{t('账号已创建')}</h1><p>{t('下一步：添加你的第一个 Claude Max 账号。')}</p><p>{t('登录后完成账号授权；产生实际用量并确认结算后，即可按余额申请提现。')}</p><Link className="button primary" to="/accounts?create=1">{t('登录并添加第一个账号')}<ArrowRight size={16}/></Link></main> : !data ? <main className="invite-card"><h1>{t('邀请暂不可用')}</h1><ErrorBox error={error}/><p>{t('这条邀请可能已到期、停用或满员。请联系邀请人获取新链接，已注册的账号仍可登录。')}</p><Link className="button" to="/">{t('前往登录')}</Link></main> : <main className="invite-conversion-layout">
      <section className="invite-story"><MonetizationPitch compact headline/><HistoricalWeeklyPeak/><EarningsCalculator rates={data.rates}/>{!signedIn && <a className="button primary mobile-signup-cta" href="#signup">{t('立即注册，添加账号')}<ArrowRight size={16}/></a>}</section>
      <aside className="invite-card" id="signup"><span className="marketing-kicker">{t('你的账号收益，从这里开始')}</span><h2>{t('创建你的收益工作空间')}</h2><p>{t('专属报价已展示。完成注册，即可添加自己的 Max 账号，开始记录每一笔有效收益。')}</p><p className="invite-by">{t('{0} 邀请你加入直属团队。', [data.inviterName])}</p><ErrorBox error={error}/>
        {signedIn ? <div className="notice"><ShieldCheck size={18}/><span>{t('你当前已登录。请先退出账号，再使用邀请链接注册新成员。')} <Link to="/">{t('返回工作空间')}</Link></span></div> : <Form onSubmit={async form => {
          if (form.get('password') !== form.get('confirmPassword')) throw new Error(t('两次输入的密码不一致'));
          await post(`/api/invitations/${encodeURIComponent(token)}/register`, { name: form.get('name'), email: form.get('email'), password: form.get('password') }); setDone(true); window.scrollTo(0, 0);
        }}><Field label={t('你的称呼')}><input name="name" required maxLength={80} autoComplete="name"/></Field><Field label={t('登录邮箱')} hint={t('用于登录 CCMAX，可与 Claude 账号邮箱不同。')}><input aria-label={t('登录邮箱')} name="email" type="email" required maxLength={200} autoComplete="username"/></Field><Field label={t('密码')} hint={t('至少 12 位，请设置独立的 CCMAX 登录密码。')}><input aria-label={t('密码')} name="password" type="password" minLength={12} maxLength={200} required autoComplete="new-password"/></Field><Field label={t('确认密码')}><input name="confirmPassword" type="password" minLength={12} maxLength={200} required autoComplete="new-password"/></Field><Submit>{t('立即注册，添加账号')}<ArrowRight size={16}/></Submit></Form>}
        <div className="signup-note"><ShieldCheck size={15}/>{t('注册本身不会产生收益；完成授权并产生有效用量后，才按账单结算。')}</div>
        <details className="invite-price-details"><summary>{t('查看我的结算报价')}</summary><div className="invite-prices"><h3>{t('你的结算折扣')}</h3>{Object.entries(data.rates).map(([provider, rate]) => <div key={provider}><span>{data.providers[provider].name}</span><RateBadge value={rate}/></div>)}<small>{t('价格从注册当日北京时间生效。未列出的平台保持未定价。')}</small></div></details>
        <Link className="invite-login" to="/">{t('已有账号？前往登录')}</Link>
      </aside><div className="invite-guide"><MonetizationOverview/><MonetizationFaq/></div>
    </main>}
  </div>;
}
