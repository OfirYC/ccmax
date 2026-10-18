# 代理 API 接入

每位代理可以使用自己的 API 密钥，将自己的网站或后端接入 CCMAX。API 复用网站的账号、团队、上号、用量和结算服务，数据范围与密钥所属账号一致。

## 获取密钥

1. 登录 CCMAX，进入「设置与审计 → API 接入」。
2. 点击「创建 API 密钥」，填写名称、权限和有效期，输入当前密码确认。
3. 保存完整密钥：只显示一次，服务器仅保存 SHA-256 摘要，列表不能再次取回。
4. 页面显示当前平台的 **API 基础地址**。打开「接入文档」查看完整接口，下载 OpenAPI 文件导入 Postman、Insomnia 等工具。

每个账号最多保留 10 个有效密钥，有效期可选 30、90、365 天。撤销后，后续请求立即失效；已开始执行的请求或后台任务不会被撤回。修改登录密码或由上级重置密码会撤销该账号的全部密钥。账号或任一上级停用时，密钥不能访问 API。

## 调用方式

代理的网站浏览器调用代理自己的后端，再由其后端调用 CCMAX。密钥放在代理后端的环境变量 `CCMAX_API_KEY` 中，不能写入公开网页、URL 或公开仓库。本接口面向服务端集成，不开放浏览器跨域 CORS，也不需要独立域名解析、第三方托管令牌或平台新增环境变量。

以设置页显示的基础地址作为 `CCMAX_BASE_URL`：

```bash
curl "$CCMAX_BASE_URL/api/accounts" \
  -H "Authorization: Bearer $CCMAX_API_KEY"
```

Node.js 后端示例：

```js
const base = process.env.CCMAX_BASE_URL;
const token = process.env.CCMAX_API_KEY;

async function ccmax(path, method = 'GET', body) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) {
    // 传输超时或 5xx 后先查询操作状态，不盲目重试写入。
    throw new Error(`${response.status} ${data.code}: ${data.error} (${data.requestId})`);
  }
  return data;
}

const { accounts } = await ccmax('/api/accounts');
console.log(accounts);

// 需要 accounts:write；userId 由密钥确定，不能指定其他账号的身份。
const { account } = await ccmax('/api/accounts', 'POST', {
  email: 'claude@example.com',
  label: 'My website account',
});
console.log(account.id);
```

Bearer 请求不需要网页登录 Cookie 或 `x-ccmax-request` 标记；网站 Cookie 会话继续检查 CSRF。提供了无效 Bearer 密钥时，即使同时携带有效 Cookie 也不会回退到网页登录。

## 权限

| 权限 | 功能 |
| --- | --- |
| `read`（必选，默认） | 查询获准访问的团队、账号、平台选项、用量、任务、财务及审计，导出 CSV |
| `team:write` | 创建直属下级、调整状态、重置密码及设置结算折扣 |
| `accounts:write` | 创建本人账号、固定出口代理、绑定代理、OAuth 上号、RT 导入、启停和代理同步 |
| `finance:write` | 创建/确认账单、申请提现、登记已付款或驳回提现 |

权限不会扩大原有团队范围。不能管理其他团队、修改非直属下级，或更换已核实的账号归属。财务写权限应只授予确有需要的后端；实际向外部账户付款仍是线下操作。

密钥管理、自己的登录密码、平台主账号配置、管理员归属分配和日账单导入仅支持网页登录，不能用 API 密钥调用。下级看不到平台主账号密码、管理员内部连接名称、管理员上游合同价或其他团队的数据。

## 接口文档

- 在线文档：`GET /api/docs`，无需登录，自带请求结构、权限和异步任务说明。
- 机器可读契约：`GET /api/openapi.json`，OpenAPI 3.1，版本 `1.0.0`。
- 完整接口清单与认证白名单共用 [shared/integration.ts](../shared/integration.ts)，避免文档中开放了实际不可调用的接口。

常用查询接口：

| 接口 | 返回 |
| --- | --- |
| `GET /api/auth/me` | `{user, today}`，当前密钥所属账号及北京时间账单日 |
| `GET /api/dashboard` | 汇总、余额、每日趋势、团队及平台概况 |
| `GET /api/accounts` | `{accounts, providers}`；账号包含 `bindings` 和固定代理状态 |
| `GET /api/team?from=2026-10-01&to=2026-10-18` | `{users, rates, upcoming, period, providers, pricing}` |
| `GET /api/connections` | `{connections, providers, today}`，自己的结算价和平台能力 |
| `GET /api/proxies` | `{proxies}`，无认证密码的代理列表 |
| `GET /api/usage?from=2026-10-01&to=2026-10-18&page=1` | `{rows, totals, total, page}`，每页 12 条 |
| `GET /api/finance?tab=mine&page=1` | `{balance, pendingProfit, invoicesTotal, withdrawalsTotal, invoices, withdrawals, ledger}`，账单和提现各每页 12 条 |
| `GET /api/finance/check` | `{ok:true, balance, checkedAt}`，只核对密钥所属用户的钱包、利润来源与冻结/释放流水；异常返回 409 |
| `GET /api/jobs?id=<UUID>` | `{jobs}`，按任务编号查状态；不传编号时最多最近 100 条可见任务 |
| `GET /api/audits` | `{rows}`，最多最近 300 条可见审计 |

`/api/usage/export`、`/api/ledger/export`、`/api/invoices/:id/export` 返回 CSV，不能按 JSON 解析。用量导出最多 100,000 条，超限必须缩小范围；不会静默截断。

金额使用 USD 十进制字符串，最多 8 位小数；后端使用十进制计算，避免浮点误差。折扣写入值为 0–1 的数字，返回数据库中的折扣通常是十进制字符串。账单日期统一按 `Asia/Shanghai`，不是浏览器本地时区。日期参数为 `YYYY-MM-DD`。

## 上号流程

1. 查询 `/api/connections` 和 `/api/connections/:id/options`，确定平台连接、能力和可用配置。
2. `POST /api/accounts` 创建本人账号；`POST /api/proxies` 添加本人固定出口代理；`POST /api/accounts/:id/proxy` 以 `{proxyId}` 绑定。
3. `POST /api/accounts/:id/authorize`，提交 `{targets:[{connectionId,options:{}}],key}`，获得 `{jobs}`。每次逻辑操作使用新的 UUID 作为 `key`。
4. 轮询 `/api/jobs?id=<任务编号>`；授权链接生成后从 `/api/accounts/:id/attempts` 获取 `authorization_url`。每个平台分别授权，不能复用授权码。
5. `POST /api/oauth/:id/exchange`，其中 `:id` 是授权流程编号，提交 `{callback,key}`。Mini CC 使用完整回调 URL 或 `code#state`，其他平台使用其返回的回调内容。继续轮询任务，确认实际成功。
6. AI008 / Mini CC 可用 `/api/accounts/:id/import-token` 代替 OAuth，提交 `{connectionId,refreshToken,options:{},key}`。RT 为一次性敏感凭据，不能写入自己的访问日志。

任务可能为 `queued`、`running`、`succeeded`、`failed`、`needs_attention`。只有 `succeeded` 表示完成；`needs_attention` 先人工核对上游，不能直接重复提交。代理固定绑定、每个平台配置和旧账号归属核对规则与网站完全一致，Mini CC 使用服务端固定默认配置。

## 结算与重试

已有报价变更从次日北京时间生效，已封账价格保持固定。账单只能使用已核实的日用量，按平台到直属代理再到下一级的顺序确认；提现先冻结可用余额，再由付款人登记打款或驳回。

下级报价按平台实行硬上限，必须小于或等于整条上级链在报价有效期内的折扣。例如上级给你 `0.1`，你只能给下级设置 `0–0.1`，不能设置 `0.1001`。历史起始日和已安排的调价都会检查，上级缺少任何一段生效价格时拒绝报价。上级降价若低于已有或已安排的直属下级报价，也会被拒绝；需先调整下级，不会自动重定价。

`GET /api/team` 的 `pricing.limits[provider]` 返回 `{create, change}`：分别是从今天、次日起持续生效的保守报价上限，以四位十进制字符串返回；缺少上级价格时为 `null`。初始报价回溯日期及已有报价的具体有效区间仍以写入接口校验为准。`pricing.issues` 列出可见团队当前或待生效的异常，格式为 `{userId, provider, effectiveDate}`。旧的倒挂封账记录保持原样，但受影响用量不能新生成或确认结算账单。

接受 `key` 的任务、提现接口支持业务幂等：同一逻辑操作发生网络失败时使用同一 `key` 和完全相同的业务参数，不要把这个 `key` 用在不同请求上。其他写接口不要盲目重试，先查询最终状态。

账单确认前复核原冻结价格、完整代理收益链、明细归属和汇总金额；不是按今天的价格重新计算历史。提现及审核会自动核对利润来源、等额冻结和释放流水。提现审核以相同 `action` 和 `reference` 重试时返回原记录，不重复扣款或退回；已处理记录的冲突决定返回 409。实际付款仍由线下完成，核对通过不能证明外部回款或现金准备金充足。

## 错误、限流和审计

错误形如 `{error, code, requestId}`。依据状态码和 `code` 判断结果，`error` 供人阅读，可能是中文或上游错误描述。

| HTTP / code | 含义 |
| --- | --- |
| 400 / `VALIDATION_ERROR` 或 `HTTP_400` | 参数或业务前提不满足 |
| 400 / `RATE_CAP_EXCEEDED` | 报价超过有效期内的上级价格上限 |
| 400 / `RATE_FLOOR_VIOLATION` | 降价会低于已有或已安排的下级报价；先调整下级 |
| 400 / `UPSTREAM_RATE_MISSING` | 报价期间缺少完整的上级平台价格 |
| 409 / `RATE_HIERARCHY_CONFLICT` | 用量或账单存在层级价格倒挂，需核对后处理 |
| 409 / `USAGE_ACCOUNTING_CONFLICT` | 冻结收益链、归属、付款关系或金额公式不一致 |
| 409 / `INVOICE_INTEGRITY_CONFLICT` | 账单为空，或明细、日期及汇总金额不一致 |
| 409 / `WALLET_INTEGRITY_CONFLICT` | 余额来源或原提现冻结/释放流水不一致 |
| 409 / `UPSTREAM_SETTLEMENT_REQUIRED` | 同一用量尚未被整条上级链的有效已确认账单和利润流水覆盖 |
| 400 / `AMOUNT_OUT_OF_RANGE` | 多条用量合计超出单笔账单范围，需缩短结算期间 |
| 401 / `INVALID_API_KEY` | 密钥无效、过期、撤销或所属账号停用 |
| 403 / `INSUFFICIENT_SCOPE` | 未授予所需权限 |
| 403 / `SESSION_REQUIRED` | 此接口只允许网页登录 |
| 403 / `HTTP_403` | 团队停用、资源归属或操作权限限制 |
| 404 | 资源不存在或对当前用户不可见 |
| 409 / `CONFLICT` 或 `HTTP_409` | 归属、状态或重复记录冲突 |
| 429 / `RATE_LIMITED` | 遵循 `Retry-After` 秒数退避 |
| 5xx | 服务器或上游暂时失败，先查询最终状态 |

API 密钥请求按**每个用户、每个应用实例 120 次/分钟**限流，多把密钥共享此额度；同时受现有每 IP 240 次/分钟限制。后台任务建议每几秒查询一次。初期仍按 README 使用一个应用副本，若扩容需先将限流存储改为共享存储。

API 写操作的额外审计记录密钥 ID、路由、状态码和请求 ID，具体业务操作继续记录原有审计。完整密钥、请求体、RT 和密码不进入 API 调用审计。请求与撤销可能并发，已在途请求及已提交后台任务不保证撤回。

本接口供二次开发工作台，不包含模型推理转发、CCMAX 模型 API Key 或令牌额度预扣。
