# Claude Max 20x 官方额度核查

核查日期：2026-10-19。以下依据本次实际读取的官方页面，非第三方经验值或账号用量反推。

| 项目 | 官方公开规则 |
| --- | --- |
| 网页订阅价格 | Max 5x：$100/月；Max 20x：$200/月。移动端价格可能不同，税费以实际账单为准。 |
| 5 小时额度 | Max 20x 为 Pro **每个会话周期**使用额度的 20 倍，5 小时重置。不是订阅价格乘 20，也不是固定美元钱包。 |
| 周额度 | 另有跨模型的周使用限制，在分配给账号的固定星期及时间重置；重置时间不取决于本周首次使用或订阅日期。官方页面未给出统一 Token 数或美元数。 |
| 月额度 | 未公布统一的订阅月 Token 数或美元数。官方保留设置其他周/月及模型、功能限制的权利，不能将周额度乘 4 或 30/7 声称为官方月额度。 |
| 额度共享 | Claude 网页、桌面、移动端及 Claude Code 使用同一份订阅额度；接入多个渠道不会增加同一账号的订阅额度。 |
| 模型限制 | Max 另有 Fable 周限制；官方定价表列明最多可使用总周额度的 50%。这不是额外赠送 50% 总额度。 |
| 独立 API 赠金 | Max 20x 另含 $200/账单周期的 API credits；这不是 Claude Code 的周/月订阅额度。 |

官方原文：

> Max 20x includes 20 times the Pro plan's per-session usage allowance.
>
> The weekly limit resets at a fixed time each week that is assigned to your account.

## 每月 $200 API credits 的具体条件

有效且状态正常的 Max 订阅满 7 天后，订阅人可在网页的 Settings → Billing 关联一个 Claude Console 组织领取；领取人需要对应的 Owner、Admin 或 Billing 权限。功能分批开放，具体账号以页面是否可领取为准。每个组织只能接收一个订阅的赠金。

每个账单周期更新，到期不结转。可用于 Claude Platform 上的 API、Playground、Managed Agents 和 Agent SDK；不用于交互式 Claude Code、Claude/Cowork 的额外订阅用量或第三方云。官方另说明，持关联组织 API key 自行运行的 `claude -p` / Agent SDK 属于可覆盖的 API 用量，不能与订阅登录的使用混淆。

## 对收益计算的含义

官方没有提供可直接代入的“Max 20x 每周可结算 $X、每月可结算 $Y”。因此无法仅凭官方订阅规则算出固定现金收益或最高收益。$200 API 赠金是特定用途的使用余额，也不能当作已收到 $200 现金。

实际应收应逐日累计：**已核实有效账单金额 × 该日约定结算价格**。净收入再扣同期间实际订阅、出口代理等成本；应收、已确认利润、已打款和可提现余额分别展示。

本地界面已移除未经核实的每周 $1,000 默认用量。注册页展示邀请价格，核算金额及成本留空；登录后只读取本人已核实归属账号的近 7 / 30 个已结束的北京时间日账单，采用冻结历史价格，排除快照及实时预估，显示记录覆盖，不将缺失数据当零或外推为最高收益。本次未访问生产账本、未核实任何账号完整现金回款周期。

## 官方来源

- [What is the Max plan?](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)：价格、20x 倍率、五小时及每周重置规则。
- [How do usage and length limits work?](https://support.claude.com/en/articles/11647753-understanding-usage-and-length-limits)：模型、上下文复杂度、effort 对额度的影响；各端共享额度。
- [Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)：Claude Code 共用限制、额外付费与独立 API 赠金边界。
- [Monthly API credits for Max and Team plans](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)：$200 赠金、资格、领取、周期及覆盖范围。
- [Claude Pricing](https://claude.com/pricing)：计划比较、Fable 周额度比例、月 API 赠金。

这些网页可能更新，应以账号 Settings → Usage 的当前额度和重置时间，以及最新官方页面为准。此前引用的文章 11014257 本次实际返回 404，已替换为有效的官方 Max 说明链接。
