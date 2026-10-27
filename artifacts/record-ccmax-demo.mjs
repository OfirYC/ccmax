import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const base = process.env.DEMO_BASE || 'http://127.0.0.1:4320';
const outDir = path.resolve('artifacts/ccmax-demo');
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

const width = 1280;
const height = 720;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width, height },
  recordVideo: { dir: outDir, size: { width, height } },
});
await context.addInitScript(() => {
  localStorage.setItem('ccmax.locale', 'zh-CN');
  window.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = `
      #ccmax-demo-caption { position: fixed; z-index: 2147483647; left: 34px; right: 34px; bottom: 24px; display: flex; align-items: center; gap: 18px; padding: 14px 20px; border: 1px solid rgba(128, 211, 205, .34); border-radius: 16px; color: #effffc; background: linear-gradient(100deg, rgba(7, 17, 31, .95), rgba(12, 31, 45, .92)); box-shadow: 0 12px 34px rgba(0,0,0,.28); font-family: "DM Sans", -apple-system, BlinkMacSystemFont, sans-serif; pointer-events: none; }
      #ccmax-demo-caption .demo-kicker { min-width: 120px; color: #87e5d6; font-size: 11px; letter-spacing: .13em; text-transform: uppercase; font-weight: 700; }
      #ccmax-demo-caption .demo-title { font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
      #ccmax-demo-caption .demo-detail { margin-top: 3px; color: #b8c9d2; font-size: 13px; }
      #ccmax-demo-caption .demo-watermark { margin-left: auto; color: rgba(226,247,246,.66); font-size: 12px; white-space: nowrap; }
      #ccmax-demo-caption .demo-bar { position: absolute; left: 0; right: 0; bottom: -6px; height: 3px; border-radius: 3px; background: linear-gradient(90deg, #81e5d3 var(--demo-progress, 0%), rgba(129,229,211,.18) var(--demo-progress, 0%)); }
    `;
    document.head.appendChild(style);
    const box = document.createElement('div');
    box.id = 'ccmax-demo-caption';
    box.innerHTML = '<div class="demo-kicker">CCMAX · 产品演示</div><div><div class="demo-title"></div><div class="demo-detail"></div></div><div class="demo-watermark">演示环境 · 不含真实凭据</div><div class="demo-bar"></div>';
    document.body.appendChild(box);
    window.setDemoCaption = (title, detail, progress = 0) => {
      box.querySelector('.demo-title').textContent = title;
      box.querySelector('.demo-detail').textContent = detail;
      box.style.setProperty('--demo-progress', `${progress}%`);
    };
  });
});

const page = await context.newPage();
page.setDefaultTimeout(15000);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const caption = async (title, detail, progress) => {
  await page.evaluate(({ title, detail, progress }) => window.setDemoCaption?.(title, detail, progress), { title, detail, progress });
};
const waitFor = async (ms = 500) => { await page.waitForTimeout(ms); };

// Safe, local-only mocks for the authorization UI. The rest of the product is live.
const connectionsResponse = await page.goto(`${base}/`);
await page.getByLabel('登录邮箱').fill('owner@example.com');
await page.getByLabel('密码', { exact: true }).fill('e2e-owner-password');
await page.getByRole('button', { name: '进入工作空间' }).click();
await page.locator('h1').filter({ hasText: '你好' }).waitFor({ state: 'visible' });
const connections = await page.evaluate(() => fetch('/api/connections', { headers: { 'x-ccmax-request': '1' } }).then((r) => r.json()));
const gatelink = connections.connections.find((c) => c.provider === 'gatelink');
const ai008 = connections.connections.find((c) => c.provider === 'ai008');
let authorizationStarted = false;
await page.route('**/api/connections/*/options', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ defaults: { accountType: 'speed' }, policies: [], groups: [], templates: [] }),
}));
await page.route('**/api/accounts/*/authorize', async (route) => {
  authorizationStarted = true;
  await route.fulfill({ json: { jobs: [{ id: 'demo-oauth-job', kind: 'oauth_start', state: 'queued' }] } });
});
await page.route('**/api/jobs', async (route) => {
  await route.fulfill({ json: { jobs: authorizationStarted ? [{ id: 'demo-oauth-job', kind: 'oauth_start', state: 'succeeded' }] : [] } });
});
await page.route('**/api/accounts/*/attempts', async (route) => {
  const attempts = authorizationStarted ? [
    { id: 'demo-gatelink-attempt', connection_id: gatelink.id, provider: 'gatelink', state: 'pending', authorization_url: 'https://demo.gatelink.dev/oauth/authorize?state=ccmax-demo', expires_at: new Date(Date.now() + 900000).toISOString() },
    { id: 'demo-ai008-attempt', connection_id: ai008.id, provider: 'ai008', state: 'pending', authorization_url: 'https://demo.ai008.xyz/oauth/authorize?state=ccmax-demo', expires_at: new Date(Date.now() + 900000).toISOString() },
  ] : [];
  await route.fulfill({ json: { attempts } });
});

await caption('CCMAX 账号收益平台', '操作演示：账号接入 · 用量查看 · 提现 · 团队发展', 0);
await pause(2400);

await caption('登录工作空间', '使用自己的 CCMAX 登录账号进入平台，所有账单和成员操作集中在一个工作空间。', 8);
await pause(1200);
await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'x-ccmax-request': '1' } }));
await page.goto(`${base}/`);
await page.getByLabel('登录邮箱').fill('owner@example.com');
await page.getByLabel('密码', { exact: true }).fill('e2e-owner-password');
await pause(500);
await page.getByRole('button', { name: '进入工作空间' }).click();
await page.locator('h1').filter({ hasText: '你好' }).waitFor({ state: 'visible' });
await pause(1400);

await caption('1 / 添加 Claude Max 账号', '进入「账号管理」，点击「新增账号 / 多平台上号」，填写要接入的 Claude 账号邮箱。', 20);
await page.goto(`${base}/accounts`);
await page.getByRole('button', { name: '新增账号 / 多平台上号', exact: true }).click();
let dialog = page.getByRole('dialog', { name: '多平台分别授权' });
await dialog.getByLabel('Claude 账号邮箱').fill('demo-max-account@example.com');
await dialog.locator('input[name="label"]').fill('演示 Max 账号');
await pause(1400);
await caption('账号归属先登记', '提交邮箱只建立 CCMAX 归属记录；完成上游授权并核对真实邮箱后，账号才会进入收益核算。', 27);
await dialog.getByRole('button', { name: '下一步：选择平台' }).click();
await dialog.getByText('先绑定账号专属代理').waitFor({ state: 'visible' });
await pause(1200);

await caption('绑定一条固定出口代理', '一个 Claude 账号绑定一条专属代理，所有平台统一沿用，避免跨平台出口不一致。', 35);
await dialog.getByRole('button', { name: '添加新代理' }).click();
await dialog.locator('input[name="name"]').fill('演示账号专属出口');
await dialog.getByLabel('代理地址').fill('http://demo-proxy.example.com:8080');
await pause(700);
await dialog.getByRole('button', { name: '添加并绑定代理' }).click();
await dialog.getByText('固定出口代理：演示账号专属出口').waitFor({ state: 'visible' });
await pause(1200);

await caption('选择接入平台并生成授权链接', '勾选需要接入的平台；每个平台分别打开自己的 OAuth 链接，回调码也必须分别提交。', 44);
const gateCard = dialog.locator('.target-card').filter({ hasText: 'Gatelink' });
const aiCard = dialog.locator('.target-card').filter({ hasText: 'AI008' });
await gateCard.locator('input[type="checkbox"]').check();
await aiCard.locator('input[type="checkbox"]').check();
await dialog.getByRole('button', { name: '批量生成独立授权链接' }).click();
await dialog.locator('.oauth-attempt').first().waitFor({ state: 'visible' });
await pause(1400);
await caption('完成上游授权', '在上游平台完成登录授权后，把完整回调地址或 code#state 粘贴回来提交；授权成功后即可同步用量。', 52);
await pause(2200);
await dialog.getByRole('button', { name: '关闭弹窗' }).click();

await caption('2 / 查看消费与账单', '进入「用量明细」，按日期、平台和账号筛选，查看平台账单、本人应收、下级应付与利润。', 61);
await page.goto(`${base}/usage`);
await page.locator('h1').filter({ hasText: '用量明细' }).waitFor({ state: 'visible' });
await pause(1800);
await page.getByLabel('筛选平台').selectOption('ai008');
await waitFor(1000);
await caption('按平台筛选核对', '示例中 AI008 的账单为 $100.0000，系统同时展示冻结折扣、本人应收和本层利润。', 66);
await pause(1800);
await page.getByLabel('筛选平台').selectOption('');
await waitFor(800);

let financeDemo = true;
let withdrawalSubmitted = false;
await page.route('**/api/finance*', async (route) => {
  const response = await route.fetch();
  const data = await response.json();
  if (financeDemo && data.balance) {
    data.balance.available = withdrawalSubmitted ? '36.50000000' : '86.50000000';
    data.balance.pending = withdrawalSubmitted ? '50.00000000' : '0.00000000';
    data.pendingProfit = '0.00000000';
    if (withdrawalSubmitted) data.withdrawals = [{ id: 'demo-withdrawal', user_id: 'owner', user_name: '平台管理员', amount_usd: '50.00000000', method: 'USDT · TRC20', destination: 'TRC20_demo_wallet_123', created_at: new Date().toISOString(), state: 'pending', payer_id: null, reference: null }];
  }
  await route.fulfill({ response, json: data });
});
await page.route('**/api/withdrawals', async (route) => {
  withdrawalSubmitted = true;
  await route.fulfill({ json: { id: 'demo-withdrawal', state: 'pending' } });
});

await caption('3 / 提交提现申请', '进入「利润提现」，确认可提现余额，填写金额、收款方式和收款信息，提交后金额会先进入冻结。', 72);
await page.goto(`${base}/withdrawals`);
await page.locator('h1').filter({ hasText: '利润提现' }).waitFor({ state: 'visible' });
await page.getByText('$86.50', { exact: true }).waitFor({ state: 'visible' });
await pause(1400);
await page.getByRole('button', { name: '提取平台利润', exact: true }).click();
dialog = page.getByRole('dialog', { name: '提取平台利润' });
await dialog.locator('input[name="amount"]').fill('50');
await dialog.locator('select[name="method"]').selectOption('USDT · TRC20');
await dialog.locator('textarea[name="destination"]').fill('TRC20_demo_wallet_123');
await pause(1600);
await caption('确认收款信息后提交', '系统只记录申请、冻结、付款凭证或驳回原因；实际转账由直属上级线下完成。', 78);
await dialog.getByRole('button', { name: '创建利润提取记录' }).click();
await page.getByText('提现申请已提交，金额已冻结').waitFor({ state: 'visible' });
await pause(1500);

await caption('4 / 创建直属下级用户', '进入「代理团队」，可直接创建下级 CCMAX 用户并为每个平台设置初始结算折扣。', 84);
await page.goto(`${base}/team`);
await page.getByRole('button', { name: '创建直属下级', exact: true }).click();
dialog = page.getByRole('dialog', { name: '创建直属下级' });
await dialog.getByLabel('成员名称').fill('演示合作团队');
await dialog.getByLabel('登录邮箱').fill('demo-partner@example.com');
await dialog.getByLabel('初始登录密码').fill('DemoPartner123!');
await dialog.getByLabel('Gatelink 结算折扣', { exact: true }).fill('0.4000');
await dialog.getByLabel('AI008 结算折扣', { exact: true }).fill('0.4000');
await dialog.getByLabel('Mini CC Gateway 结算折扣', { exact: true }).fill('0.4000');
await pause(1100);
await dialog.getByRole('button', { name: '创建下级账号' }).click();
await page.getByText('下级账号已创建，请将登录邮箱和密码交给对方').waitFor({ state: 'visible' });
await page.getByRole('row').filter({ hasText: 'demo-partner@example.com' }).waitFor({ state: 'visible' });
await page.locator('.team-members-panel').scrollIntoViewIfNeeded();
await pause(1600);

await caption('创建专属团队邀请链接', '同一页面还可按客户设置独立报价；复制链接后，对方自行注册并自动归属你的直属团队。', 92);
await page.getByRole('button', { name: '创建邀请链接', exact: true }).click();
dialog = page.getByRole('dialog', { name: '创建邀请链接' });
await dialog.getByLabel('链接名称').fill('演示合作客户');
await dialog.getByLabel('Gatelink 结算折扣', { exact: true }).fill('0.3500');
await dialog.getByLabel('AI008 结算折扣', { exact: true }).fill('0.3500');
await dialog.getByLabel('Mini CC Gateway 结算折扣', { exact: true }).fill('0.3500');
await dialog.locator('select[name="expiresInDays"]').selectOption('30');
await dialog.locator('input[name="maxUses"]').fill('1');
await dialog.getByRole('button', { name: '生成邀请链接' }).click();
await page.getByRole('row').filter({ hasText: '演示合作客户' }).waitFor({ state: 'visible' });
await page.getByRole('row').filter({ hasText: '演示合作客户' }).scrollIntoViewIfNeeded();
await pause(2200);

await caption('演示完成', '从账号接入到消费、提现和团队发展，CCMAX 将报价、账单与资金流水串成一条可追溯流程。', 100);
await page.goto(`${base}/`);
await pause(2200);
await page.screenshot({ path: path.join(outDir, 'poster.png'), fullPage: false });

await page.close();
const videoPath = await page.video().path();
await context.close();
await browser.close();
console.log(videoPath);
