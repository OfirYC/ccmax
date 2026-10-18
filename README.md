# CCMAX

CCMAX 是一个多平台账号聚合和多级代理结算工作台。当前适配：

- Gatelink（`cc.gatelink.dev`）：平台主账号 OAuth 上号、实时账号同步；每个账号按平台要求填写独立出口代理。
- AI008（`ai008.xyz`）：平台主账号 OAuth 上号、refresh token 导入、账号同步和历史用量查询。

代理只登录 CCMAX。Claude 账号提交到平台主账号，账号经真实授权邮箱校验或管理员核实后，在 CCMAX 中固定归属于对应用户；同一个 Claude 账号可以绑定多个平台。平台密码、refresh token 和 OAuth 会话只在服务器端加密处理，浏览器不会得到主账号密码。

## Railway 部署

1. 在 Railway 新建一个 Project，添加 **PostgreSQL** 服务。
2. 选择「Deploy from GitHub Repo」，选择 `abingyyds/ccmax`；Railway 会读取根目录 `Dockerfile` 构建。
3. 在 CCMAX 服务的 Variables 中设置以下变量（`DATABASE_URL` 使用 Railway 的变量引用）：

   ```text
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ENCRYPTION_KEY=<64 位十六进制，生成：openssl rand -hex 32>
   ADMIN_EMAIL=<首次平台管理员邮箱>
   ADMIN_PASSWORD=<至少 12 位的首次密码>
   ADMIN_NAME=平台管理员
   APP_URL=https://你的域名
   SYNC_INTERVAL_SECONDS=300
   ```

   `ENCRYPTION_KEY` 必须长期保留；更换它会使已保存的平台密码和上游令牌无法解密。生产环境没有默认账号、默认密码或公开注册。
4. 在 Settings → Networking → Generate Domain 生成域名，把生成的 HTTPS 地址填入 `APP_URL` 后重新部署。仅使用 Railway 默认域名时，也可不填 `APP_URL`，系统自动使用 `RAILWAY_PUBLIC_DOMAIN` 的 HTTPS 地址；自定义域名应明确填写 `APP_URL`。首次自动构建如因变量未设置而失败，补齐变量后 Redeploy 即可。
5. Healthcheck 使用 `/health`；首次启动会自动执行数据库迁移并创建唯一的平台管理员。后续部署不会覆盖用户、平台连接、账单或流水。
6. 首次登录后先在「平台连接」录入上游主账号，再同步账号，随后创建代理、分配归属和设置折扣。

PostgreSQL 服务若被重命名，`DATABASE_URL` 引用中的 `Postgres` 也要改为实际服务名。应用服务无需挂载本地磁盘；数据库持久化由 PostgreSQL 服务管理。初期保持一个应用副本，使用 Dockerfile 的默认启动命令，Railway 自动注入 PORT。

生产环境不要设置 `ALLOW_LOCAL_DB=true`，也不要把 `.env`、平台密码或 refresh token 提交到 GitHub。Railway PostgreSQL 建议开启自动备份，并在正式运营前做一次恢复演练。

## 使用顺序

1. 平台管理员在「平台连接」填写两个平台主账号；系统先登录核验，再同步平台账号。
2. 在「账号管理」新建或导入 Claude 账号。多平台 OAuth 可一次生成多个授权链接，但每个平台必须分别完成自己的回调授权；AI008 也可以导入 refresh token。
3. 管理员把同步出的未归属账号分配给团队成员。归属确认后不能自行更换，避免账单漂移。
4. 在「代理团队」创建直属下级并为每个平台设置 0–1 折扣。初始价格可填写真实合同起始日以支持历史导入；后续新价格从次日北京时间生效，平台给 CCMAX 的上游折扣也按生效日留档，历史日账单不会套用后来改过的价格。
5. 「用量明细」中的实时数据只用于预估。管理员用 AI008 历史接口或上游确认的 Gatelink 日账单导入，核实后封存。只有封存数据能生成结算账单。
6. 按「平台 → 直属代理 → 更下级」逐级生成并确认账单。确认会把本层利润写入不可重复的流水账。提现先冻结余额，再由直属上级线下打款并登记凭证。

## 本地开发

需要 Node.js 22：

```bash
npm ci
cp .env.example .env
# 本地没有 PostgreSQL 时，明确设置 ALLOW_LOCAL_DB=true，并填写 ENCRYPTION_KEY、ADMIN_EMAIL、ADMIN_PASSWORD
npm run dev
```

生产构建和检查：

```bash
npm run check
npm test
npm run build
npm run test:e2e # 首次需要 npx playwright install chromium
npm run start
```

本地嵌入式 PGlite 只用于开发，不建议承载生产数据。Railway 必须使用 PostgreSQL，避免容器重启造成数据丢失。

## 结算规则

每个账号每天只有一条用量记录。平台账单为 `raw_usd`，本层应收为 `raw_usd × 本层折扣`，本层利润为 `本层应收 − 下级应付`。金额保存 8 位美元小数并使用数据库事务，重复同步只更新实时快照，不重复产生收益。平台接口超时、OAuth 一次性回调和 refresh token 导入不会自动重试，任务会进入「需要核对」状态，避免外部成功而本地重复记账。

当前上游权限边界也会显示在界面：Gatelink 的历史结算接口需要管理员权限，使用代理账号时必须导入上游确认的逐账号日账单；AI008 的历史查询结果仍需要人工核对后才会进入账本。

当前版本的“透传”指账号上号、平台账号同步、实时/历史用量查询、启停状态、归属和账单数据透传到 CCMAX。它还不是把 Claude API 请求反向代理到上游平台的通用 API Gateway；如果需要让下级拿 CCMAX 的 API Key 直接调用模型，需要单独增加 API 密钥、额度预扣、请求审计、流式转发和上游路由层。

详细的实现范围、安全验证及运营边界见 [上线核查](docs/VERIFICATION.md)。GitHub Actions 已配置 PostgreSQL、浏览器及 Docker 构建检查。
