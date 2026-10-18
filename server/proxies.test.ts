import { describe,it,expect } from 'vitest';
import { parseProxy,proxyFingerprint } from './proxies.js';
import { ProviderClient,type ProviderKey } from './providers.js';

const url='http://user:secret@proxy.example.com:8080';
function client(provider:ProviderKey,handler:(path:string,body:any)=>any) {
  return new ProviderClient(provider,{username:'test',password:'test'},async(input,init={})=>Response.json(await handler(new URL(String(input)).pathname,init.body?JSON.parse(String(init.body)):{})));
}
describe('account proxy integrity',()=>{
  it('canonicalizes proxy identities, hides credentials in endpoints and rejects unsupported inputs',()=>{
    expect(parseProxy('http://user:secret@PROXY.example.com:80/')).toMatchObject({url:'http://user:secret@proxy.example.com:80',endpoint:'http://proxy.example.com:80'});
    expect(parseProxy('socks5://user:secret@proxy.example.com:1080').scheme).toBe('socks5h');
    expect(parseProxy('socks5h://user:secret@PROXY.example.com:1080').host).toBe('proxy.example.com');
    expect(proxyFingerprint(url,'ab'.repeat(32))).toBe(proxyFingerprint(url.replace('secret','rotated'),'ab'.repeat(32)));
    for(const value of ['file:///etc/passwd','ftp://proxy.example.com','http://user:secret@proxy.example.com/path','http://user:secret@proxy.example.com?x=1','invalid'])expect(()=>parseProxy(value)).toThrow();
  });
  for(const provider of ['gatelink','ai008','minicc'] as const) {
    it(`${provider} refuses proxy-free authorization before contacting the upstream`,async()=>{
      let calls=0;const c=client(provider,()=>{calls++;return {};});
      await expect(c.startOAuth({email:'claude@example.com'})).rejects.toThrow('专属出口代理');
      if(provider!=='gatelink')await expect(c.importRefreshToken({email:'claude@example.com'},'token')).rejects.toThrow('专属出口代理');
      expect(calls).toBe(0);
    });
  }
  for(const provider of ['ai008','minicc'] as const) {
    it(`${provider} resolves an exact authenticated proxy and refuses mismatched mappings`,async()=>{
      const c=client(provider,()=>({total:1,proxies:[{id:'physical-proxy',upstream_id:'physical-proxy',url,status:'active'}]}));
      expect(await c.provisionProxy(url)).toBe('physical-proxy');
      await expect(c.verifyProxyMapping(url,'other-id')).rejects.toThrow('不符或不可核实');
      await expect(c.verifyProxyMapping('https://different.example.com:443','physical-proxy')).rejects.toThrow('不符或不可核实');
    });
    it(`${provider} rejects ambiguous imports instead of picking another proxy or using a direct connection`,async()=>{
      let writes=0;
      const c=client(provider,path=>path.endsWith('/import')?(writes++,{imported:0,existing:1,failed:0}):{total:1,proxies:[{id:'existing',upstream_id:'existing',scheme:'http',host:'proxy.example.com',port:8080,status:'active'}]});
      await expect(c.provisionProxy(url)).rejects.toThrow('核实平台映射');expect(writes).toBe(1);
    });
    it(`${provider} verifies an occupied proxy but rejects assigning it as a new proxy or accepting a disabled proxy`,async()=>{
      const record={id:'occupied',upstream_id:'occupied',url,status:'active',at_bound_account_limit:true,selectable:false};
      const c=client(provider,()=>({total:1,proxies:[record]}));
      expect(await c.verifyProxyMapping(url,'occupied')).toBe('occupied');
      await expect(c.provisionProxy(url)).rejects.toThrow('绑定上限');
      record.status='disabled';
      await expect(c.verifyProxyMapping(url,'occupied')).rejects.toThrow('已停用');
    });
    it(`${provider} reads the real proxy back after modifying a legacy account`,async()=>{
      let changed=false;
      const c=client(provider,(path,body)=>{
        if(path.endsWith('/policy')||body.outbound_proxy_id) {expect(body.outbound_proxy_id).toBe('fixed');changed=true;return {};}
        return {account:{outbound_proxy_id:changed?'fixed':null}};
      });
      await c.setAccountProxy('remote-account',{email:'test@example.com',proxy:url,proxyExternalId:'fixed'});expect(changed).toBe(true);
      const ignored=client(provider,()=>({account:{outbound_proxy_id:'wrong'}}));
      await expect(ignored.setAccountProxy('remote-account',{email:'test@example.com',proxy:url,proxyExternalId:'fixed'})).rejects.toThrow('实际代理未匹配');
    });
  }
});
