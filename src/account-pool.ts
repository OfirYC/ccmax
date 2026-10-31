import Decimal from 'decimal.js';
import type { AccountTelemetry, TelemetryPeriod } from '../shared/telemetry';

const PoolDecimal=Decimal.clone({precision:40,rounding:Decimal.ROUND_HALF_UP});

export type PoolBinding = {
  id:string;provider:string;status:string;usage_enabled?:boolean;connection_enabled:boolean;data_fresh:boolean;
  telemetry:AccountTelemetry|null;
};
export type PoolMetric = {value:string|null;covered:number;total:number};
export type AccountStatusKind = 'active'|'disabled'|'attention'|'pending'|'partial';

/** Resolve the most actionable state for an account from its platform bindings. */
export function accountStatusKind(account:{ownership_verified?:boolean;bindings?:Array<Pick<PoolBinding,'status'|'connection_enabled'|'usage_enabled'|'data_fresh'>>}):AccountStatusKind {
  const bindings=account.bindings??[];
  if(!bindings.length)return 'pending';
  if(account.ownership_verified===false)return 'attention';
  const states=bindings.map(binding=>{
    if(binding.connection_enabled===false||binding.usage_enabled===false||['disabled','paused','auto_disabled'].includes(binding.status))return 'disabled' as const;
    if(['active','connected','healthy'].includes(binding.status))return 'active' as const;
    return 'attention' as const;
  });
  if(states.includes('attention')||states.some((state,index)=>state==='active'&&!bindings[index].data_fresh))return 'attention';
  if(states.every(state=>state==='disabled'))return 'disabled';
  if(states.includes('disabled'))return 'partial';
  return 'active';
}

export function comparePoolBills(a:string|null,b:string|null) {
  return a===null?(b===null?0:1):b===null?-1:new PoolDecimal(b).cmp(a);
}

// Use the same freshness and billing-day boundary as the telemetry API. Decimal
// sums preserve the upstream bill; no settlement rate is applied to these values.
export function poolMetric(bindings:PoolBinding[], select:(data:AccountTelemetry)=>number|string|null):PoolMetric {
  const values=bindings.filter(b=>b.usage_enabled!==false&&b.data_fresh&&b.telemetry).map(b=>select(b.telemetry!)).filter((v):v is number|string=>v!==null);
  return {value:values.length?values.reduce((sum,v)=>sum.plus(v),new PoolDecimal(0)).toFixed():null,covered:values.length,total:bindings.length};
}
export function poolBill(bindings:PoolBinding[],day:string,period:TelemetryPeriod):PoolMetric {
  return poolMetric(bindings,data=>period==='today'&&data.day!==day?null:data.periods[period].billedUsd);
}
export function poolModel(bindings:PoolBinding[],day:string,model:'opus'|'fable',now=Date.now()):PoolMetric {
  return poolMetric(bindings,data=>{
    if(!data.modelsAt||Date.parse(data.modelsAt)>now+60000||Math.abs(now-Date.parse(data.modelsAt))>600000||data.day!==day)return null;
    const modelDay=new Date(Date.parse(data.modelsAt)+8*3600000).toISOString().slice(0,10);
    return modelDay===day?data.periods.today.models.find(m=>m.model===model)?.usageUsd??null:null;
  });
}
export function matchingBindings<T extends PoolBinding>(bindings:T[],provider:string,status:string):T[] {
  return bindings.filter(b=>{
    const enabled=b.usage_enabled!==false,effective=enabled?b.status:'disabled';
    return (provider==='all'||b.provider===provider)&&(status==='all'||
      (status==='active'?b.connection_enabled&&effective==='active':
        status==='disabled'?!b.connection_enabled||effective==='disabled':
          status==='partial'?true:
          status==='attention'?b.connection_enabled&&!['active','disabled'].includes(effective):false));
  });
}
