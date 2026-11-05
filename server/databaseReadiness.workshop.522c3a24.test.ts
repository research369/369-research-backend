import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as readiness from './databaseReadiness.js';
import {readFileSync} from 'node:fs';
test('Status exposes only harmless release provenance without a database call',()=>{assert.equal(Reflect.get(readiness,'serverSoftwareReleaseCheck'),"server-joint-publication-20261018-v1");const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');assert.match(source,/serverReleaseCheck: serverSoftwareReleaseCheck/);assert.match(source,/version: "1.2.0-kwk"/);});
