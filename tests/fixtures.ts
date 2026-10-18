import { createHash } from 'node:crypto';
import { test as base, expect } from '@playwright/test';

// Each browser scenario represents a different client behind the trusted proxy.
// Keep production limits enabled without sharing one IP budget across the suite.
export const test = base.extend({
  context: async ({ context }, use, testInfo) => {
    const bytes = createHash('sha256').update(testInfo.testId).digest();
    await context.setExtraHTTPHeaders({ 'X-Forwarded-For': `198.18.${bytes[0]}.${bytes[1]}` });
    await use(context);
  },
});
export { expect };
