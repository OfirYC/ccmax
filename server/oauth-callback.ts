import { assert } from './core.js';

// AI008 and Mini CC both accept code#state alongside pending_state. Validate
// before enqueueing as well as before consuming a one-use upstream code.
export function statefulOAuthCallback(callback:string,pendingState:unknown):string {
  const input=callback.trim();
  let code='',state='';
  if(/^https?:\/\//i.test(input)) {
    let url:URL|undefined;
    try { url=new URL(input); } catch { /* Report a safe validation error below. */ }
    assert(url && url.searchParams.getAll('code').length===1 && url.searchParams.getAll('state').length===1,'此平台需要完整回调地址或 code#state，OAuth state 必须匹配');
    code=(url.searchParams.get('code')||'').trim();
    state=(url.searchParams.get('state')||'').trim();
  } else {
    const separator=input.indexOf('#');
    if(separator>0) {code=input.slice(0,separator).trim();state=input.slice(separator+1).trim();}
  }
  assert(code && state,'此平台需要完整回调地址或 code#state，OAuth state 必须匹配');
  assert(typeof pendingState==='string' && pendingState.length>0 && state===pendingState,'OAuth state 不匹配');
  return `${code}#${state}`;
}
