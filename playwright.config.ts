import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests',testMatch:'**/*.spec.ts',workers:1,
  use:{baseURL:'http://127.0.0.1:4319',headless:true,trace:'retain-on-failure'},
  webServer:{command:'node --import tsx tests/e2e-server.ts',url:'http://127.0.0.1:4319/health',reuseExistingServer:false,timeout:30000},
});
