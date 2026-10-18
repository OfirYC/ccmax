import { describe,it,expect } from 'vitest';
import { ProviderClient } from './providers.js';

const account=(id:string)=>({id,email:`${id}@example.com`,stats:{daily_cost:'1.25'},status:'active'});
const client=(handler:(url:string,init?:RequestInit)=>any)=>new ProviderClient('ai008',{username:'test',password:'test'},async(url,init)=>Response.json(await handler(String(url),init)));

describe('upstream adapter data integrity',()=>{
  it('follows all declared pages even when the upstream ignores our requested page size',async()=>{
    const pages:number[]=[];
    const c=client(url=>{const page=Number(new URL(url).searchParams.get('page'));pages.push(page);return {accounts:[account(String(page))],pagination:{page,page_size:1,total_pages:3,total_rows:3}};});
    const accounts=await c.listAccounts();expect(pages).toEqual([1,2,3]);expect(accounts).toHaveLength(3);
  });
  it('does not turn an absent upstream usage amount into a zero-dollar snapshot',()=>{
    const c=client(()=>({}));expect(()=>c.normalize({id:'one',email:'one@example.com',stats:{}})).toThrow('有效的当日用量');
  });
  it('verifies a token import against the authoritative account list when the response contains only an ID',async()=>{
    const c=client(url=>url.endsWith('/import-rt')?{id:'real'}:{accounts:[account('real')],pagination:{total_pages:1}});
    const remote=await c.importRefreshToken({email:'claimed@example.com'},'owned-refresh-token');
    expect(remote.email).toBe('real@example.com');
  });
  it('fails closed if a write has no authoritative identity to verify',async()=>{
    const c=client(url=>url.endsWith('/import-rt')?{id:'missing'}:{accounts:[],pagination:{total_pages:1}});
    await expect(c.importRefreshToken({email:'claimed@example.com'},'owned-refresh-token')).rejects.toThrow('可验证的真实邮箱');
  });
  it('checks OAuth state before sending a one-use code upstream',async()=>{
    let calls=0;const c=client(()=>{calls++;return {};});
    await expect(c.exchangeOAuth({options:{email:'a@example.com'},pendingState:'expected'},'https://callback.example/?code=once&state=wrong')).rejects.toThrow('state');expect(calls).toBe(0);
  });
  it('does not leak upstream response bodies through errors',async()=>{
    const c=new ProviderClient('ai008',{username:'test',password:'test'},async()=>new Response('token=private-secret',{status:403}));
    await expect(c.call('/api/admin/oauth-accounts')).rejects.toThrow('HTTP 403');
    try{await c.call('/api/admin/oauth-accounts');}catch(error){expect(String(error)).not.toContain('private-secret');}
  });
});
