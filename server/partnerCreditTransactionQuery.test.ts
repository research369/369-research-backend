import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { createPartnerCreditTransactionQueryClient, parameterizePartnerCreditQuery } from "./partnerCreditTransactionQuery.js";

const dialect = new PgDialect();

test("ledger SQL adapter binds reordered/repeated placeholders and never embeds values as raw SQL", () => {
  const hostile = "x'); UPDATE partners SET credit_balance=999; --";
  const query = dialect.sqlToQuery(parameterizePartnerCreditQuery(
    "SELECT * FROM partners WHERE id=$3 OR partner_number=$2 OR code=$1 OR code=$1", [hostile, "OWN", 9],
  ));
  assert.equal(query.sql, "SELECT * FROM partners WHERE id=$1 OR partner_number=$2 OR code=$3 OR code=$4");
  assert.deepEqual(query.params, [9, "OWN", hostile, hostile]);
  assert.ok(!query.sql.includes(hostile));
});

test("ledger SQL adapter handles casts, tenth placeholders, nulls and missing parameters", () => {
  const values = [null, 2, 3, 4, 5, 6, 7, 8, 9, "ten"];
  const query = dialect.sqlToQuery(parameterizePartnerCreditQuery("SELECT $10::text, $1::numeric", values));
  assert.equal(query.sql, "SELECT $1::text, $2::numeric");
  assert.deepEqual(query.params, ["ten", null]);
  assert.throws(() => parameterizePartnerCreditQuery("SELECT $2", [1]), /PARAMETER_MISSING/);
  assert.throws(() => parameterizePartnerCreditQuery("SELECT $0", [1]), /PARAMETER_MISSING/);
});

test("transaction query client uses only supplied executor and returns rows without transaction control", async () => {
  const seen: string[] = [];
  const client = createPartnerCreditTransactionQueryClient(async query => {
    seen.push(dialect.sqlToQuery(query).sql);
    return { rows: [{ balance: "12.06" }] };
  });
  const result = await client.query<{ balance: string }>("SELECT credit_balance AS balance FROM partners WHERE id=$1 FOR UPDATE", [9]);
  assert.deepEqual(result.rows, [{ balance: "12.06" }]);
  assert.deepEqual(seen, ["SELECT credit_balance AS balance FROM partners WHERE id=$1 FOR UPDATE"]);
});

test("transaction executor rejection propagates unchanged for caller-owned rollback", async () => {
  const failure = new Error("locked_balance_rejected");
  const client = createPartnerCreditTransactionQueryClient(async () => { throw failure; });
  await assert.rejects(client.query("SELECT id FROM partners FOR UPDATE"), error => error === failure);
});
