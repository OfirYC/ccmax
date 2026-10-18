import { defineConfig } from 'tsup';

export default defineConfig({
  entry:{index:'server/index.ts','audit-finance':'scripts/audit-finance.ts','audit-attribution':'scripts/audit-attribution.ts'},
  format:['esm'],platform:'node',target:'node22',outDir:'dist/server',clean:true,
  external:['@electric-sql/pglite','vite','lightningcss'],
});
