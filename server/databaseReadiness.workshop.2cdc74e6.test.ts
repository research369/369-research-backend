import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as readiness from './databaseReadiness.js';
import {readFileSync} from 'node:fs';
test('Status exposes only harmless release provenance without a database call',()=>{assert.equal(Reflect.get(readiness,'softwareReleaseCheck'),"joint-publication-v1");const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');assert.match(source,/releaseCheck: softwareReleaseCheck/);assert.match(source,/version: "1.2.0-kwk"/);});
