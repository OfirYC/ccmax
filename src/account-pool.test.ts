import { describe,expect,it } from 'vitest';
import Decimal from 'decimal.js';
import { normalizeTelemetry,aggregateTelemetry } from '../server/telemetry';
import { today } from '../server/core';
import { accountStatusKind,comparePoolBills,poolBill,poolMetric,poolModel,matchingBindings,type PoolBinding } from './account-pool';

function binding(amount:string|null,fresh=true):PoolBinding {
  const telemetry=normalizeTelemetry('ai008',{stats:{daily_cost:amount,rpm:4},usage_windows:{cost_7d:amount}});
  return {id:crypto.randomUUID(),provider:'ai008',status:'active',connection_enabled:true,data_fresh:fresh,telemetry};
}
describe('account pool totals',()=>{
  it('sorts exact bills with missing amounts last',()=>{
    const values=[null,'9007199254740993.00000001','0','9007199254740993.00000002'];
    expect(values.sort(comparePoolBills)).toEqual(['9007199254740993.00000002','9007199254740993.00000001','0',null]);
  });
  it('matches analytics with exact decimals, partial coverage and stale snapshots',()=>{
    const bindings=[binding('9007199254740993.12345678'),binding('0.00000001'),binding(null),binding('999',false)];
    const expected=aggregateTelemetry(bindings.map(b=>({...b,fresh:b.data_fresh})),'today');
    expect(poolBill(bindings,today(),'today')).toEqual(expected.billedUsd);
    expect(poolBill(bindings,today(),'today')).toEqual({value:'9007199254740993.12345679',covered:2,total:4});
    // Browser code must work without the server's global Decimal configuration.
    const precision=Decimal.precision;
    try{Decimal.set({precision:20});expect(poolBill(bindings,today(),'today')).toEqual(expected.billedUsd);}
    finally{Decimal.set({precision});}
    expect(poolMetric(bindings,d=>d.activity.rpm)).toEqual(expected.rpm);
    expect(poolBill(bindings,today(),'7d')).toEqual(aggregateTelemetry(bindings.map(b=>({...b,fresh:b.data_fresh})),'7d').billedUsd);
  });
  it('distinguishes missing data from genuine zero and excludes prior-day totals',()=>{
    expect(poolBill([],today(),'today')).toEqual({value:null,covered:0,total:0});
    const missing=binding(null),zero=binding('0'),old=binding('100');old.telemetry!.day='2000-01-01';
    expect(poolBill([missing],today(),'today').value).toBeNull();
    expect(poolBill([missing,zero,old],today(),'today')).toEqual({value:'0',covered:1,total:3});
    expect(poolBill([old],today(),'7d').value).toBe('100');
  });
  it('never shows a model cache as current model usage',()=>{
    const b=binding('100'),now=Date.now();
    b.telemetry!.periods.today.models=[{model:'opus',usageUsd:'80'},{model:'fable',usageUsd:'0'}];
    b.telemetry!.modelsAt=new Date(now).toISOString();
    expect(poolModel([b],today(),'opus',now).value).toBe('80');
    expect(poolModel([b],today(),'fable',now).value).toBe('0');
    expect(poolModel([b],today(),'opus',now+600001).value).toBeNull();
    b.telemetry!.modelsAt=new Date(now+60001).toISOString();expect(poolModel([b],today(),'opus',now).value).toBeNull();
    b.telemetry!.day='2000-01-01';expect(poolModel([b],today(),'opus',now).value).toBeNull();
  });
  it('filters status within the selected platform and respects disabled connections',()=>{
    const ai=binding('100'),gate={...binding('20'),provider:'gatelink',status:'disabled'},disabled={...binding('9'),connection_enabled:false};
    expect(matchingBindings([ai,gate,disabled],'ai008','active')).toEqual([ai]);
    expect(matchingBindings([ai,gate,disabled],'gatelink','disabled')).toEqual([gate]);
    expect(matchingBindings([ai,gate,disabled],'all','disabled')).toEqual([gate,disabled]);
    expect(matchingBindings([ai,gate,disabled],'all','attention')).toEqual([]);
  });
  it('summarizes platform states into an actionable account status',()=>{
    const active=binding('1'),disabled={...binding('2'),status:'disabled'},stale={...binding('3'),data_fresh:false};
    expect(accountStatusKind({bindings:[active]})).toBe('active');
    expect(accountStatusKind({bindings:[disabled]})).toBe('disabled');
    expect(accountStatusKind({bindings:[active,disabled]})).toBe('partial');
    expect(accountStatusKind({bindings:[stale]})).toBe('attention');
    expect(accountStatusKind({ownership_verified:false,bindings:[active]})).toBe('attention');
    expect(accountStatusKind({bindings:[]})).toBe('pending');
  });
});
