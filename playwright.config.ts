import { defineConfig } from '@playwright/test';
const host=process.env.E2E_HOST||'127.0.0.1',port=process.env.E2E_PORT||'4319';
const baseURL=`http://${host.includes(':')?`[${host}]`:host}:${port}`;
export default defineConfig({
  testDir:'./tests',testMatch:'**/*.spec.ts',workers:1,
  use:{baseURL,headless:true,trace:'retain-on-failure'},
  webServer:{command:'node --import tsx tests/e2e-server.ts',url:baseURL+'/health',reuseExistingServer:false,timeout:30000},
});
