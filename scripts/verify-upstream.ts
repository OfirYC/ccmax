import { ProviderClient, type ProviderKey } from '../server/providers.js';

const checks: [ProviderKey,string|undefined,string|undefined][] = [
  ['gatelink',process.env.GATELINK_USERNAME,process.env.GATELINK_PASSWORD],
  ['ai008',process.env.AI008_USERNAME,process.env.AI008_PASSWORD],
  ['minicc',process.env.MINICC_USERNAME,process.env.MINICC_PASSWORD],
  ['maxchat',process.env.MAXCHAT_USERNAME,process.env.MAXCHAT_PASSWORD],
];
for (const [provider,username,password] of checks) {
  if (!username || !password) { console.log(`${provider}: skipped (set ${provider.toUpperCase()}_USERNAME and _PASSWORD)`); continue; }
  const client=new ProviderClient(provider,{username,password});
  try {
    const login=await client.login();
    const accounts=await client.listAccounts();
    console.log(`${provider}: login ok (${login.role}); ${accounts.length} accounts readable`);
  } catch (error) {
    console.error(`${provider}: failed — ${error instanceof Error?error.message:'unknown error'}`);
    process.exitCode=1;
  }
}
