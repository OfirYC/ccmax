// Return only operation names, known field names and numeric HTTP statuses.
// Gatelink error bodies may echo proxy credentials, OAuth codes or account data.
const fields = new Set(['username','password','accountType','oauthFlow','loginMethod','proxy','overwriteExisting','callback','code','state','page','pageSize','enabled']);

async function errorMetadata(response:Response):Promise<any> {
  const reader=response.body?.getReader();
  if(!reader)return null;
  const chunks:Uint8Array[]=[];let size=0;
  try {
    for(;;) {
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.length;
      if(size>32768){await reader.cancel();return null;}
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
  finally { reader.releaseLock(); }
}

function validationFields(data:any) {
  const result=new Set<string>();
  for(const container of [data,data?.error,data?.details]) {
    if(!container||typeof container!=='object')continue;
    for(const list of [container.issues,container.errors,container.detail,container.details]) {
      if(!Array.isArray(list))continue;
      for(const issue of list) {
        const path=issue?.path??issue?.loc;
        const field=Array.isArray(path)?(path[0]==='body'||path[0]==='query'?path[1]:path[0]):path;
        if(typeof field==='string'&&fields.has(field))result.add(field);
      }
    }
    for(const errors of [container.fieldErrors,container.errors]) {
      if(!errors||typeof errors!=='object'||Array.isArray(errors))continue;
      for(const field of Object.keys(errors))if(fields.has(field))result.add(field);
    }
  }
  return [...result].sort();
}

export async function gatelinkFailure(response:Response,path:string) {
  const pathname=path.split('?')[0];
  const operation=pathname==='/api/auth/login'?'登录'
    :pathname==='/api/settings/submission'?'读取上号配置'
    :pathname==='/api/submissions'?'同步账号'
    :pathname==='/api/admin/usage-settlements'?'读取历史日账单'
    :pathname==='/api/oauth-submissions/authorize'?'生成授权链接'
    :pathname==='/api/oauth-submissions/exchange'?'提交授权回调'
    :/^\/api\/admin\/accounts\/[^/]+\/enabled$/.test(pathname)?'修改账号状态':'请求';
  let message=`Gatelink ${operation}失败（HTTP ${response.status}）`;
  if(response.status===403)message+='；当前主账号无此权限';
  if(response.status===422) {
    const data=await errorMetadata(response),invalid=validationFields(data);
    const rawStatus=data?.upstream?.httpStatus;
    const status=typeof rawStatus==='number'?rawStatus:typeof rawStatus==='string'&&/^\d{3}$/.test(rawStatus)?Number(rawStatus):null;
    const upstreamFailure=status!==null&&Number.isInteger(status)&&status>=400&&status<=599;
    if(invalid.length)message+=`；参数校验未通过：${invalid.join(', ')}`;
    if(upstreamFailure)message+=`；Gatelink 的上游返回 HTTP ${status}`;
    if(!invalid.length&&!upstreamFailure)message+='；请求被拒绝，请核对本步骤的参数或在 Gatelink 查看拒绝原因';
  }
  return message;
}
