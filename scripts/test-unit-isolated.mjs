import {readdirSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
// These files still run, each in a separate job with its own fresh database.
export const dedicated = new Map([
 ['campaignAccountPermissions.postgres.test.ts','test-campaign-account-permissions.sh'],
 ['operationsPermissionsCleanup.postgres.test.ts','test-operations-permissions-cleanup.sh'],
 ['priorityOrderIntegrity.test.ts','test-priority-integrity.sh'],
 ['productDraft.postgres.test.ts','test-product-draft.sh'],
 ['productDraftFinalization.postgres.test.ts','test-product-draft-finalization.sh'],
 ['productFamily.postgres.test.ts','test-product-family.sh'],
 ['screenshotOrderContract.test.ts','test-screenshot-order.sh'],
 ['screenshotOrderService.test.ts','test-screenshot-order.sh'],
]);
for(const script of dedicated.values())if(!existsSync('scripts/'+script))throw Error('Missing isolated test runner: '+script);
const files=['server','tests'].flatMap(dir=>readdirSync(dir).filter(f=>f.endsWith('.test.ts')&&!dedicated.has(f)).map(f=>dir+'/'+f));
console.log('Unit files:',files.length,'; database-specific files assigned to dedicated jobs:',dedicated.size);
// Deliberately inherit no API/database/mail/payment credentials.
const env={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',TZ:process.env.TZ||'UTC',NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',DATABASE_URL:'',RAILWAY_DB_URL:'',JWT_SECRET:'synthetic-unit-tests-only-not-production-0123456789'};
const result=spawnSync('node_modules/.bin/tsx',['--experimental-test-module-mocks','--test',...files],{stdio:'inherit',env});
process.exit(result.status??1);
