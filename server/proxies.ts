import { createHmac } from 'node:crypto';
import type { DB, Row } from './db.js';
import { AppError, assert, type SecretBox } from './core.js';

export function parseProxy(input:string) {
  let url:URL;
  try { url=new URL(input.trim()); } catch { throw new AppError(400,'代理地址格式无效，请使用 http、https 或 socks5h URL'); }
  if(url.protocol==='socks5:')url.protocol='socks5h:';
  url.hostname=url.hostname.toLowerCase();
  assert(['http:','https:','socks5h:'].includes(url.protocol) && url.hostname && (!url.pathname||url.pathname==='/') && !url.search && !url.hash,'代理地址必须为 http、https 或 socks5h URL，不能包含路径或参数');
  let username:string,password:string;
  try { username=decodeURIComponent(url.username);password=decodeURIComponent(url.password); } catch { throw new AppError(400,'代理认证信息编码无效'); }
  const port=Number(url.port||(url.protocol==='http:'?80:url.protocol==='https:'?443:1080));
  assert(Number.isInteger(port)&&port>0&&port<=65535 && (!password||username),'代理端口或认证信息无效');
  const endpoint=`${url.protocol}//${url.hostname}:${port}`;
  const auth=username?`${encodeURIComponent(username)}${password?':'+encodeURIComponent(password):''}@`:'';
  return {url:`${url.protocol}//${auth}${url.hostname}:${port}`,endpoint,scheme:url.protocol.slice(0,-1),host:url.hostname,port,username,password};
}
export function proxyFingerprint(url:string,encryptionKey:string) {
  const p=parseProxy(url);
  // Password rotation must not let another account claim the same proxy identity.
  return createHmac('sha256',Buffer.from(encryptionKey,'hex')).update(JSON.stringify([p.scheme,p.host,p.port,p.username])).digest('hex');
}
export async function accountProxy(db:DB,box:SecretBox,accountId:string,expectedId?:string):Promise<Row&{url:string}> {
  const [p]=await db.query(`SELECT p.* FROM proxies p JOIN accounts a ON a.proxy_id=p.id WHERE a.id=$1`,[accountId]);
  assert(p?.enabled,'请先为该账号绑定并启用专属出口代理');
  assert(!expectedId||expectedId===p.id,'账号代理与任务快照不一致，已阻止上号',409);
  return {...p,url:parseProxy(box.decrypt(p.secret).url).url};
}
