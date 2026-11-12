import test from "node:test";
import assert from "node:assert/strict";
import { findIslandPostalRule, normalizeIslandPostal, type IslandPostalRule } from "./islandPostalRules.js";

const fixture: IslandPostalRule[] = [
  { id:"fixture-es",country:"ES",kind:"prefix",value:"07",label:"Synthetic provincial postal rule",sources:["https://example.invalid/synthetic"],reviewedAt:"2026-11-12" },
  { id:"fixture-de",country:"DE",kind:"exact",value:"25980",label:"Synthetic exact postal rule",sources:["https://example.invalid/synthetic"],reviewedAt:"2026-11-12" },
  { id:"fixture-pt",country:"PT",kind:"range",value:"9000000",end:"9999999",label:"Synthetic island-only postal range",sources:["https://example.invalid/synthetic"],reviewedAt:"2026-11-12" },
];

test("only exact documented country/postal formatting; no garbage truncation or loss of leading zero",()=>{
  for(const country of ["DE","ES","FR","IT"]){
    assert.equal(normalizeIslandPostal(country," 07001 "),"07001");
    assert.equal(normalizeIslandPostal(country,"07 001"),"07001");
    for(const value of ["0701","070001","ES-07001","07001 Berlin","7e003","0x7001","https://test/07001","07001\nBerlin","","000000000000000000000"])
      assert.equal(normalizeIslandPostal(country,value),null);
  }
  for(const value of ["9000-001","9000 001","9000001"])assert.equal(normalizeIslandPostal("PT",value),"9000001");
  for(const value of ["9000","9000-01","9000--001","PT9000-001","9000–001"])
    assert.equal(normalizeIslandPostal("PT",value),null);
  assert.equal(normalizeIslandPostal("US","07001"),null);
});

test("country isolation, exact instead of adjacent or broad prefix matching",()=>{
  assert.equal(findIslandPostalRule("ES","07001",fixture)?.id,"fixture-es");
  assert.equal(findIslandPostalRule("FR","07001",fixture),null);
  assert.equal(findIslandPostalRule("DE","25980",fixture)?.id,"fixture-de");
  assert.equal(findIslandPostalRule("DE","25981",fixture),null);
  assert.equal(findIslandPostalRule("DE","25900",fixture),null);
  assert.equal(findIslandPostalRule("ES","28001",fixture),null);
  assert.equal(findIslandPostalRule("PT","9000-001",fixture)?.id,"fixture-pt");
  assert.equal(findIslandPostalRule("PT","8999-999",fixture),null);
});

test("unreviewed/invalid rules cannot accidentally deny the full postal namespace",()=>{
  const invalid: IslandPostalRule[] = [
    {...fixture[0],value:""},
    {...fixture[0],sources:[]},
    {...fixture[0],value:".*"},
    {...fixture[2],value:"9999999",end:"9000000"},
  ];
  assert.equal(findIslandPostalRule("ES","07001",invalid),null);
  assert.equal(findIslandPostalRule("PT","9500-001",invalid),null);
});

import { getColdShippingAvailability } from "./coldShippingAvailability.js";
import { REVIEWED_ISLAND_POSTAL_RULES } from "./islandPostalRules.js";

test("all actual reviewed rules match and retain sources; no island-country data masquerades as worldwide coverage",()=>{
  assert.equal(REVIEWED_ISLAND_POSTAL_RULES.length,38);
  for(const rule of REVIEWED_ISLAND_POSTAL_RULES){
    const postal=rule.kind==="prefix"?rule.value.padEnd(rule.country==="PT"?7:5,"0"):rule.value;
    assert.equal(findIslandPostalRule(rule.country,postal)?.id,rule.id);
    assert(rule.sources.every(source=>source.startsWith("https://")));
  }
});

test("actual island addresses denied even with forged city text; adjacent mainland not denied",async()=>{
  for(const [country,zip] of [["Deutschland","25980"],["DE","18565"],["DE","83256"],["Spanien","07001"],["ES","35001"],["ES","38001"],["Frankreich","20000"],["FR","97133"],["FR","97400"],["Italien","07100"],["IT","90133"],["Portugal","9000-001"],["PT","9500 001"],["PT","8005-554"],["PT","8005-555"],["PT","8005-556"]]){
    const result=await getColdShippingAvailability({country,zip,city:"Berlin"});assert.equal(result.status,"island");assert.equal(result.eligible,false);
  }
  for(const [country,zip] of [["DE","18507"],["DE","17489"],["DE","18439"],["FR","50170"],["FR","56170"],["FR","97300"],["FR","98000"],["IT","89010"],["IT","20121"],["PT","8000-250"],["ES","28001"],["ES","51001"],["ES","52001"]]){
    const result=await getColdShippingAvailability({country,zip,city:"Mallorca"});assert.equal(result.status,"unknown");assert.equal(result.eligible,true);
  }
});
