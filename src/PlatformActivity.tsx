import { Activity, ArrowUpRight, Database, Server } from 'lucide-react';
import { Link } from 'react-router-dom';
import { dateTime, number } from './api';
import { Amount } from './PriceDisplay';
import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';
import './platform-activity.css';

const count=(value:any)=>value===null||value===undefined?'—':number(value);
const coverage=(metric:any)=>t('覆盖 {0}/{1} 个平台账号',[metric?.covered??0,metric?.total??0]);

export function PlatformActivityOverview({connections,activity,loading}:{connections:any[];activity:any;loading:boolean}){
  useLocale();
  const totals=activity?.totals?.periods?.today;
  return <div className="platform-activity-overview">
    <div><span><Server size={14}/>{t('已启用平台 / 全部连接')}</span><strong>{number(connections.filter(c=>c.enabled).length)} <small>/ {number(connections.length)}</small></strong><small>{t('统计每条平台连接')}</small></div>
    <div><span><Database size={14}/>{t('平台账号')}</span><strong>{loading?'—':number(totals?.bindings??0)}</strong><small>{t('有效快照 {0}/{1}',[totals?.fresh??0,totals?.bindings??0])}</small></div>
    <div><span>{t('今日平台账单')}</span><strong><Amount value={totals?.billedUsd?.value} digits={2}/></strong><small>{coverage(totals?.billedUsd)}</small></div>
    <div><span><Activity size={14}/>RPM</span><strong>{count(totals?.rpm?.value)}</strong><small>{coverage(totals?.rpm)}</small></div>
  </div>;
}

export default function PlatformActivity({connectionId,activity,loading,scope}:{connectionId:string;activity:any;loading:boolean;scope:string}){
  useLocale();
  const periods=activity?.periods,today=periods?.today,bindings=today?.bindings??0,fresh=today?.fresh??0;
  return <div className="platform-current-data" aria-label={t('平台当前数据')}>
    <div className="platform-data-heading"><span><Activity size={13}/>{t('当前用量与状态')}</span><Link className="text-button" to={`/analytics?connectionId=${encodeURIComponent(connectionId)}&scope=${scope}`}>{t('调用详情')}<ArrowUpRight size={12}/></Link></div>
    <div className="platform-bill-now"><div><span>{t('今日平台账单')}</span><strong><Amount value={today?.billedUsd?.value} digits={2}/></strong></div><small>{coverage(today?.billedUsd)}</small></div>
    <div className="platform-bill-periods">{(['5h','7d','30d'] as const).map(period=><div key={period}><span>{period==='5h'?t('近 5 小时'):period==='7d'?t('近 7 天'):t('近 30 天')}</span><Amount value={periods?.[period]?.billedUsd?.value} digits={2}/><small>{coverage(periods?.[period]?.billedUsd)}</small></div>)}</div>
    <div className="platform-data-rates"><DataMetric label={t('平台账号')} value={loading?null:bindings} detail={t('有效快照 {0}/{1}',[fresh,bindings])}/><DataMetric label="RPM" value={today?.rpm?.value} detail={coverage(today?.rpm)}/><DataMetric label="TPM" value={today?.tpm?.value} detail={coverage(today?.tpm)}/><DataMetric label={t('当前并发')} value={today?.concurrent?.value} detail={coverage(today?.concurrent)}/></div>
    <div className="platform-data-requests"><DataMetric label={t('今日请求数')} value={today?.requests?.value} detail={coverage(today?.requests)}/><DataMetric label={t('今日 Token')} value={today?.tokens?.value} detail={coverage(today?.tokens)}/></div>
    <div className="platform-data-models"><span>{t('今日模型消费')}</span>{['opus','fable'].map(model=>{
      const metric=today?.models?.find((m:any)=>m.model===model);
      return <div key={model}><span>{model==='opus'?'Opus':'Fable'}</span><Amount value={metric?.value} digits={2}/><small>{coverage(metric)}</small></div>;
    })}</div>
    {activity?.attribution?.unassigned>0&&<div className="platform-data-pending">{t('待归属平台账号：{0}',[activity.attribution.unassigned])}<Link className="text-button" to="/accounts?unassigned=1">{t('查看待归属账号')}<ArrowUpRight size={12}/></Link></div>}
    {!loading&&bindings===0?<p className="platform-data-empty">{t('当前统计范围内暂无平台账号')}</p>:
      <p className={`platform-data-source${fresh<bindings?' stale':''}`}>{fresh<bindings?t('部分数据已过期或尚未采集'):t('上游采样数据')} · {t('最近数据时间')} {dateTime(activity?.newestSourceAt)}</p>}
  </div>;
}

function DataMetric({label,value,detail}:{label:string;value:any;detail:string}){
  return <div><span>{label}</span><strong>{count(value)}</strong><small>{detail}</small></div>;
}
