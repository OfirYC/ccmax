import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const base = process.env.DEMO_BASE || 'http://127.0.0.1:4320';
const outDir = path.resolve('artifacts/ccmax-demo-en');
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
  localStorage.setItem('ccmax.locale', 'en');
  window.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = `
      #ccmax-demo-caption { position: fixed; z-index: 2147483647; left: 34px; right: 34px; bottom: 24px; display: flex; align-items: center; gap: 18px; padding: 14px 20px; border: 1px solid rgba(128, 211, 205, .34); border-radius: 16px; color: #effffc; background: linear-gradient(100deg, rgba(7, 17, 31, .95), rgba(12, 31, 45, .92)); box-shadow: 0 12px 34px rgba(0,0,0,.28); font-family: "DM Sans", -apple-system, BlinkMacSystemFont, sans-serif; pointer-events: none; }
      #ccmax-demo-caption .demo-kicker { min-width: 120px; color: #87e5d6; font-size: 11px; letter-spacing: .13em; text-transform: uppercase; font-weight: 700; }
      #ccmax-demo-caption .demo-title { font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
      #ccmax-demo-caption .demo-detail { margin-top: 3px; color: #b8c9d2; font-size: 13px; }
      #ccmax-demo-caption .demo-watermark { margin-left: auto; color: rgba(226,247,246,.66); font-size: 12px; white-space: nowrap; }
      #ccmax-demo-caption .demo-bar { position: absolute; left: 0; right: 0; bottom: -6px; height: 3px; border-radius: 3px; background: linear-gradient(90deg, #81e5d3 var(--demo-progress, 0%), rgba(129,229,211,.18) var(--demo-progress, 0%)); }
      @keyframes ccmax-demo-pulse { from { transform: scale(1); opacity: .78; } to { transform: scale(1.025); opacity: 1; } }
    `;
    document.head.appendChild(style);
    const box = document.createElement('div');
    box.id = 'ccmax-demo-caption';
    box.innerHTML = '<div class="demo-kicker">CCMAX · PRODUCT DEMO</div><div><div class="demo-title"></div><div class="demo-detail"></div></div><div class="demo-watermark">Demo environment · No real credentials</div><div class="demo-bar"></div>';
    document.body.appendChild(box);
    window.setDemoCaption = (title, detail, progress = 0) => {
      box.querySelector('.demo-title').textContent = title;
      box.querySelector('.demo-detail').textContent = detail;
      box.style.setProperty('--demo-progress', `${progress}%`);
    };
    window.clearDemoMark = () => document.querySelector('#ccmax-demo-mark')?.remove();
    window.markDemo = (element, label = 'Important') => {
      window.clearDemoMark();
      const target = typeof element === 'string' ? document.querySelector(element) : element;
      if (!target) return false;
      const r = target.getBoundingClientRect();
      const padX = Math.max(8, Math.min(18, r.width * .08));
      const padY = Math.max(8, Math.min(14, r.height * .18));
      const ring = document.createElement('div');
      ring.id = 'ccmax-demo-mark';
      ring.style.cssText = `position:fixed;z-index:2147483646;left:${r.left - padX}px;top:${r.top - padY}px;width:${r.width + padX * 2}px;height:${r.height + padY * 2}px;border:3px solid #ff2538;border-radius:999px;box-shadow:0 0 0 4px rgba(255,37,56,.18),0 0 18px rgba(255,37,56,.65);pointer-events:none;box-sizing:border-box;animation:ccmax-demo-pulse 1.15s ease-in-out infinite alternate;`;
      const tag = document.createElement('span');
      tag.textContent = label;
      tag.style.cssText = `position:absolute;left:4px;top:-27px;padding:4px 8px;border-radius:999px;background:#ff2538;color:white;font:700 11px/1 -apple-system,BlinkMacSystemFont,"DM Sans",sans-serif;white-space:nowrap;box-shadow:0 4px 10px rgba(110,0,12,.25);`;
      ring.appendChild(tag);
      document.body.appendChild(ring);
      return true;
    };
  });
});

const page = await context.newPage();
page.setDefaultTimeout(15000);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const caption = async (title, detail, progress) => {
  await page.evaluate(({ title, detail, progress }) => window.setDemoCaption?.(title, detail, progress), { title, detail, progress });
};
const mark = async (locator, label) => {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((element, text) => window.markDemo?.(element, text), label);
};
const waitFor = async (ms = 500) => { await page.waitForTimeout(ms); };

// Safe, local-only mocks for the authorization UI. The rest of the product is live.
const connectionsResponse = await page.goto(`${base}/`);
await page.getByLabel('Email address').fill('owner@example.com');
await page.getByLabel('Password', { exact: true }).fill('e2e-owner-password');
await page.getByRole('button', { name: 'Enter workspace' }).click();
await page.locator('h1').filter({ hasText: 'Hello' }).waitFor({ state: 'visible' });
const connections = await page.evaluate(() => fetch('/api/connections', { headers: { 'x-ccmax-request': '1' } }).then((r) => r.json()));
const gatelink = connections.connections.find((c) => c.provider === 'gatelink');
const ai008 = connections.connections.find((c) => c.provider === 'ai008');
let authorizationStarted = false;
const englishize = (value) => {
  if (typeof value === 'string') return value.replaceAll('平台管理员', 'Platform administrator').replaceAll('测试代理', 'Test agent').replaceAll('测试下级', 'Test member');
  if (Array.isArray(value)) return value.map(englishize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, englishize(item)]));
  return value;
};
for (const pattern of ['**/api/auth/me', '**/api/accounts', '**/api/usage*', '**/api/team*']) {
  await page.route(pattern, async (route) => {
    const response = await route.fetch();
    const data = englishize(await response.json());
    await route.fulfill({ response, json: data });
  });
}
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

await caption('CCMAX Account Earnings Platform', 'Demo: account onboarding · usage review · withdrawals · team growth', 0);
await pause(2400);

await caption('Sign in to your workspace', 'Use your CCMAX login to manage accounts, bills, team members, and earnings in one place.', 8);
await pause(1200);
await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'x-ccmax-request': '1' } }));
await page.goto(`${base}/`);
await page.getByLabel('Email address').fill('owner@example.com');
await page.getByLabel('Password', { exact: true }).fill('e2e-owner-password');
await mark(page.getByRole('button', { name: 'Enter workspace', exact: true }), '1. Sign in');
await pause(500);
await page.getByRole('button', { name: 'Enter workspace' }).click();
await page.locator('h1').filter({ hasText: 'Hello' }).waitFor({ state: 'visible' });
await pause(1400);

await caption('1 / Add a Claude Max account', 'Open Accounts, click Add account / Connect platforms, and enter the Claude account email.', 20);
await page.goto(`${base}/accounts`);
await mark(page.getByRole('button', { name: 'Add account / Connect platforms', exact: true }), '2. Add account');
await page.getByRole('button', { name: 'Add account / Connect platforms', exact: true }).click();
let dialog = page.getByRole('dialog', { name: 'Authorize each platform' });
await dialog.getByLabel('Claude account email').fill('demo-max-account@example.com');
await dialog.locator('input[name="label"]').fill('Demo Max account');
await mark(dialog.getByLabel('Claude account email'), 'Enter Claude email');
await pause(1400);
await caption('Register account ownership', 'The email creates the CCMAX ownership record. Earnings begin only after upstream authorization and email verification.', 27);
await mark(dialog.getByRole('button', { name: 'Next: select platforms' }), 'Next');
await dialog.getByRole('button', { name: 'Next: select platforms' }).click();
await dialog.getByText('Bind a dedicated account proxy first').waitFor({ state: 'visible' });
await pause(1200);

await caption('Bind one fixed outbound proxy', 'Each Claude account uses one dedicated proxy across every connected platform.', 35);
await mark(dialog.getByRole('button', { name: 'Add new proxy' }), 'Bind dedicated proxy');
await dialog.getByRole('button', { name: 'Add new proxy' }).click();
await dialog.locator('input[name="name"]').fill('Demo account proxy');
await dialog.getByLabel('Proxy URL').fill('http://demo-proxy.example.com:8080');
await pause(700);
await dialog.getByRole('button', { name: 'Add and bind proxy' }).click();
await dialog.locator('.notice').filter({ hasText: 'Demo account proxy' }).waitFor({ state: 'visible' });
await pause(1200);

await caption('Select platforms and generate authorization links', 'Select the platforms you need. Open each OAuth link separately and submit each platform’s own callback.', 44);
const gateCard = dialog.locator('.target-card').filter({ hasText: 'Gatelink' });
const aiCard = dialog.locator('.target-card').filter({ hasText: 'AI008' });
await gateCard.locator('input[type="checkbox"]').check();
await aiCard.locator('input[type="checkbox"]').check();
await mark(dialog.getByRole('button', { name: 'Generate separate authorization links' }), 'Generate links');
await dialog.getByRole('button', { name: 'Generate separate authorization links' }).click();
await dialog.locator('.oauth-attempt').first().waitFor({ state: 'visible' });
await mark(dialog.locator('.oauth-attempt').first(), 'Paste callback after OAuth');
await pause(1400);
await caption('Complete upstream authorization', 'Authorize on each upstream platform, then paste its full callback URL or code#state to start usage sync.', 52);
await pause(2200);
await dialog.getByRole('button', { name: 'Close dialog' }).click();

await caption('2 / Review usage and bills', 'Open Usage details and filter by date, platform, or account to review bills, receivables, payables, and profit.', 61);
await page.goto(`${base}/usage`);
await page.locator('h1').filter({ hasText: 'Usage details' }).waitFor({ state: 'visible' });
await pause(1800);
await mark(page.getByLabel('Filter platforms'), 'Filter by platform');
await page.getByLabel('Filter platforms').selectOption('ai008');
await waitFor(1000);
await caption('Filter by platform', 'This example shows a $100.0000 AI008 bill with the frozen rate, receivable, and current-level profit.', 66);
await pause(1800);
await page.getByLabel('Filter platforms').selectOption('');
await waitFor(800);

let financeDemo = true;
let withdrawalSubmitted = false;
await page.route('**/api/finance*', async (route) => {
  const response = await route.fetch();
  const data = englishize(await response.json());
  if (financeDemo && data.balance) {
    data.balance.available = withdrawalSubmitted ? '36.50000000' : '86.50000000';
    data.balance.pending = withdrawalSubmitted ? '50.00000000' : '0.00000000';
    data.pendingProfit = '0.00000000';
    if (withdrawalSubmitted) data.withdrawals = [{ id: 'demo-withdrawal', user_id: 'owner', user_name: 'Platform administrator', amount_usd: '50.00000000', method: 'USDT · TRC20', destination: 'TRC20_demo_wallet_123', created_at: new Date().toISOString(), state: 'pending', payer_id: null, reference: null }];
  }
  await route.fulfill({ response, json: data });
});
await page.route('**/api/withdrawals', async (route) => {
  withdrawalSubmitted = true;
  await route.fulfill({ json: { id: 'demo-withdrawal', state: 'pending' } });
});

await caption('3 / Request a withdrawal', 'Open Profit withdrawals, confirm the available balance, enter the amount and payment details, then submit to place funds on hold.', 72);
await page.goto(`${base}/withdrawals`);
await page.locator('h1').filter({ hasText: 'Profit withdrawals' }).waitFor({ state: 'visible' });
await page.getByText('$86.50', { exact: true }).waitFor({ state: 'visible' });
await pause(1400);
await mark(page.getByRole('button', { name: 'Withdraw platform profit', exact: true }), 'Request withdrawal');
await page.getByRole('button', { name: 'Withdraw platform profit', exact: true }).click();
dialog = page.getByRole('dialog', { name: 'Withdraw platform profit' });
await dialog.locator('input[name="amount"]').fill('50');
await dialog.locator('select[name="method"]').selectOption('USDT · TRC20');
await dialog.locator('textarea[name="destination"]').fill('TRC20_demo_wallet_123');
await mark(dialog.getByRole('button', { name: 'Create profit withdrawal record' }), 'Submit withdrawal');
await pause(1600);
await caption('Review payment details and submit', 'CCMAX records the request, hold, payment evidence, or rejection reason. Your direct manager completes the offline payment.', 78);
await dialog.getByRole('button', { name: 'Create profit withdrawal record' }).click();
await page.getByText('Withdrawal requested; funds are on hold').waitFor({ state: 'visible' });
await pause(1500);

await caption('4 / Create a direct member', 'Open Agent team to create a CCMAX member and set initial settlement rates for each platform.', 84);
await page.goto(`${base}/team`);
await mark(page.getByRole('button', { name: 'Create direct member', exact: true }), 'Create direct member');
await page.getByRole('button', { name: 'Create direct member', exact: true }).click();
dialog = page.getByRole('dialog', { name: 'Create direct member' });
await dialog.getByLabel('Member name').fill('Demo partner team');
await dialog.getByLabel('Email address').fill('demo-partner@example.com');
await dialog.getByLabel('Initial login password').fill('DemoPartner123!');
await dialog.getByLabel('Gatelink settlement rate', { exact: true }).fill('0.4000');
await dialog.getByLabel('AI008 settlement rate', { exact: true }).fill('0.4000');
await dialog.getByLabel('Mini CC Gateway settlement rate', { exact: true }).fill('0.4000');
await pause(1100);
await dialog.getByRole('button', { name: 'Create member account' }).click();
await page.getByText('Member account created. Share the login email and password with them.').waitFor({ state: 'visible' });
await page.getByRole('row').filter({ hasText: 'demo-partner@example.com' }).waitFor({ state: 'visible' });
await page.locator('.team-members-panel').scrollIntoViewIfNeeded();
await pause(1600);

await caption('Create a team invitation link', 'Set a separate rate for each customer. Share the link so they register themselves into your direct team.', 92);
await mark(page.getByRole('button', { name: 'Create invitation link', exact: true }), 'Create invitation link');
await page.getByRole('button', { name: 'Create invitation link', exact: true }).click();
dialog = page.getByRole('dialog', { name: 'Create invitation link' });
await dialog.getByLabel('Link name').fill('Demo partner client');
await dialog.getByLabel('Gatelink settlement rate', { exact: true }).fill('0.3500');
await dialog.getByLabel('AI008 settlement rate', { exact: true }).fill('0.3500');
await dialog.getByLabel('Mini CC Gateway settlement rate', { exact: true }).fill('0.3500');
await dialog.locator('select[name="expiresInDays"]').selectOption('30');
await dialog.locator('input[name="maxUses"]').fill('1');
await mark(dialog.getByRole('button', { name: 'Generate invitation link' }), 'Generate link');
await dialog.getByRole('button', { name: 'Generate invitation link' }).click();
await page.getByRole('row').filter({ hasText: 'Demo partner client' }).waitFor({ state: 'visible' });
await page.getByRole('row').filter({ hasText: 'Demo partner client' }).scrollIntoViewIfNeeded();
await mark(page.getByRole('row').filter({ hasText: 'Demo partner client' }), 'Copy this invite URL');
await pause(2200);

await caption('Demo complete', 'CCMAX connects onboarding, usage, withdrawals, rates, bills, and the full team ledger in one traceable flow.', 100);
await page.goto(`${base}/`);
await pause(2200);
await page.screenshot({ path: path.join(outDir, 'poster.png'), fullPage: false });

await page.close();
const videoPath = await page.video().path();
await context.close();
await browser.close();
console.log(videoPath);
