import { test, expect } from './fixtures';
import en from '../src/locales/en.json' with { type: 'json' };
import vi from '../src/locales/vi.json' with { type: 'json' };
import hi from '../src/locales/hi.json' with { type: 'json' };

test('languages persist across login, navigation, refresh, and mobile use', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const switcher = page.locator('.language-switcher select');
  await expect(switcher).toHaveValue('en');
  await expect(switcher.locator('option')).toHaveText(['简体中文', 'English', 'Tiếng Việt', 'हिन्दी']);
  await page.getByLabel(en['登录邮箱']).fill('owner@example.com');
  await page.getByLabel(en['密码'], { exact: true }).fill('e2e-owner-password');

  // Verify the same server error changes language while the form stays filled.
  await page.route('**/api/auth/login', route => route.fulfill({ status: 401, json: { error: '邮箱或密码错误，或账号已停用' } }));
  await switcher.selectOption('en');
  await page.getByRole('button', { name: en['进入工作空间'] }).click();
  await expect(page.getByRole('alert')).toHaveText(en['邮箱或密码错误，或账号已停用']);
  for (const [locale, catalog] of [['vi', vi], ['hi', hi], ['en', en]] as const) {
    await switcher.selectOption(locale);
    await expect(page.getByRole('alert')).toHaveText(catalog['邮箱或密码错误，或账号已停用']);
    await expect(page.getByLabel(catalog['登录邮箱'])).toHaveValue('owner@example.com');
    await expect(page.getByLabel(catalog['密码'], { exact: true })).toHaveValue('e2e-owner-password');
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
  }
  await page.unroute('**/api/auth/login');
  await page.getByRole('button', { name: en['进入工作空间'] }).click();
  await expect(page.locator('h1')).toHaveText('Hello, 平台管理员');

  const routes = [
    ['/accounts', '账号管理'], ['/platforms', '平台管理'], ['/proxies', '出口代理'],
    ['/team', '代理团队'], ['/usage', '用量明细'], ['/finance', '账单结算'],
    ['/withdrawals', '利润提现'], ['/jobs', '同步任务'], ['/settings', '设置与审计'],
  ] as const;
  for (const [locale, catalog] of [['en', en], ['vi', vi], ['hi', hi]] as const) {
    await switcher.selectOption(locale);
    for (const [url, key] of routes) {
      await page.locator(`.nav-item[href="${url}"]`).click();
      await expect(page.locator('h1')).toHaveText(catalog[key]);
      await expect(page.locator('.breadcrumbs strong')).toHaveText(catalog[key]);
    }
    await page.getByLabel(catalog['当前密码']).fill('keep-this-form-value');
    await switcher.selectOption(locale === 'en' ? 'vi' : 'en');
    await expect(page.locator('input[name="currentPassword"]')).toHaveValue('keep-this-form-value');
    await switcher.selectOption(locale);
    await page.reload();
    await expect(page.locator('h1')).toHaveText(catalog['设置与审计']);
    await expect(switcher).toHaveValue(locale);
    await expect(page).toHaveTitle(catalog['CCMAX · 账号与代理工作空间']);

    // Account dialogs must be usable in each language.
    await page.locator('.nav-item[href="/accounts"]').click();
    await page.getByRole('button', { name: catalog['新增账号 / 多平台上号'], exact: true }).click();
    await page.getByLabel(catalog['Claude 账号邮箱']).fill('language-check@example.com');
    await page.keyboard.press('Escape');
    await page.locator('.nav-item[href="/withdrawals"]').click();
    await page.getByRole('button', { name: catalog['提取平台利润'], exact: true }).click();
    await page.getByLabel(catalog['收款方式']).selectOption({ label: catalog['银行转账'] });
    await expect(page.getByLabel(catalog['收款方式'])).toHaveValue('银行转账');
    await page.keyboard.press('Escape');
    await page.locator('.nav-item[href="/platforms"]').click();
    await expect(page.locator('.connection-card').first().locator('.settlement-price')).toContainText(catalog['上游给我的结算折扣']);
    await page.screenshot({ path: `test-results/platforms-${locale}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(switcher).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/platforms-${locale}-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.getByLabel(hi['退出登录']).click();
  await expect(page.getByLabel(hi['登录邮箱'])).toBeVisible();
  await expect(switcher).toHaveValue('hi');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/login-hi-mobile.png', fullPage: true });
  await switcher.selectOption('zh-CN');
  await expect(page.getByLabel('登录邮箱')).toBeVisible();
  expect(errors).toEqual([]);
});

test('invalid preferences fall back to English and storage restrictions allow switching', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ccmax.locale', 'invalid-language'));
  await page.goto('/');
  await expect(page.locator('.language-switcher select')).toHaveValue('en');
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Storage unavailable'); };
  });
  await page.locator('.language-switcher select').selectOption('vi');
  await expect(page.getByLabel(vi['登录邮箱'])).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
});
