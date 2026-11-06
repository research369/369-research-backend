import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import * as schema from "../drizzle/schema.js";
import { ENV } from "./env.js";
import { closeDb } from "./db.js";
import { permissionsSchemaSql, ensurePermissionsSchema, isPermissionsSchemaReady } from "./permissionsSchema.js";
import { ensureCustomerDataChangeSchema, resolveCheckoutCustomerDataChange, createCustomerDataChangeConfirmation, consumeCustomerDataChangeConfirmation, persistConfirmedCustomerDataChange } from "./customerDataChangeService.js";
import { readCrmOrderContext, linkCrmExistingOrder } from "./crmOrderCustomerService.js";
import { reassignOrderCustomer } from "./orderCustomerAssignmentService.js";

const socket = process.env.PERMISSIONS_TEST_PG_SOCKET;
const port = Number(process.env.PERMISSIONS_TEST_PG_PORT || "55436");
if (socket && (!socket.startsWith("/tmp/369-permissions-pg") || port !== 55436)) throw Error("Only dedicated local permissions PostgreSQL allowed");
const fixtureCustomer = { name: "Synthetic One", firstName: "Synthetic", lastName: "One", email: "one@fixture.invalid", phone: "0171 1111111", street: "Old Street", houseNumber: "1", zip: "00000", city: "Fixture", country: "ZZ", communicationLanguage: "de" };
const fixtureOrder = (id: string, customerId: number | null = null) => ({ orderId: id, ...fixtureCustomer, customerId, subtotal: "50", discount: "0", shipping: "0", shippingCountry: "ZZ", total: "50", paymentMethod: "Bar" as const, orderDate: new Date("2026-11-06T08:00:00Z") });

test("actual isolated PostgreSQL permission, snapshot and assignment contracts", { skip: !socket }, async t => {
  assert.equal(process.env.DATABASE_URL, ""); assert.equal(ENV.resendApiKey, "");
  const name = `permissions_${process.pid}`;
  const admin = new pg.Pool({ host: socket, port, user: "ubuntu", database: "postgres" });
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, port, user: "ubuntu", database: name, max: 8 });
  const db = drizzle(pool);
  // ENV points only at the reserved socket, never at DATABASE_URL/external host.
  ENV.databaseUrl = `postgresql://ubuntu@localhost:${port}/${name}?host=${encodeURIComponent(socket!)}`;
  const dialect = new PgDialect();
  try {
    const tables = [schema.customers, schema.orders, schema.orderItems, schema.articles, schema.stockHistory, schema.shopSettings, schema.customerCommunications];
    const enums = new Map<string, string[]>();
    for (const table of tables) for (const column of getTableConfig(table).columns) if (column.enumValues) enums.set(column.getSQLType(), column.enumValues);
    for (const [enumName, values] of enums) await pool.query(`CREATE TYPE "${enumName}" AS ENUM (${values.map(value => `'${value}'`).join(",")})`);
    for (const table of tables) {
      const config = getTableConfig(table);
      const columns = config.columns.map(column => {
        let result = `"${column.name}" ${column.getSQLType()}`;
        if (column.primary) result += " PRIMARY KEY";
        if (column.notNull) result += " NOT NULL";
        if (column.default !== undefined) {
          const value = column.default;
          result += " DEFAULT " + (value && typeof value === "object" ? dialect.sqlToQuery(value as any).sql : typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : typeof value === "boolean" ? String(value) : String(value));
        }
        return result;
      });
      await pool.query(`CREATE TABLE "${config.name}" (${columns.join(",")})`);
    }
    // Simulate existing production NOT NULL before applying the additive migration.
    await pool.query("ALTER TABLE customer_communications ALTER COLUMN customer_id SET NOT NULL; ALTER TABLE customer_communications DROP COLUMN customer_link_review");
    await ensurePermissionsSchema(); await ensurePermissionsSchema();
    await ensureCustomerDataChangeSchema();
    await pool.query("CREATE SEQUENCE local_customer_seq START 9001; CREATE FUNCTION next_customer_number() RETURNS bigint LANGUAGE SQL AS $$ SELECT nextval('local_customer_seq') $$; CREATE SEQUENCE local_order_seq; CREATE FUNCTION next_order_id() RETURNS text LANGUAGE SQL AS $$ SELECT 'LOCAL-' || nextval('local_order_seq') $$; CREATE TABLE customer_order_blocks(id serial, customer_id integer,status text,email_normalized text,phone_normalized text); CREATE TABLE substitution_config(id integer,enabled integer,updated_at timestamp); INSERT INTO substitution_config VALUES(1,0,NOW())");
    const [customer] = await db.insert(schema.customers).values({ ...fixtureCustomer, customerNumber: "9000" }).returning();
    const [other] = await db.insert(schema.customers).values({ ...fixtureCustomer, email: "two@fixture.invalid", phone: "0172 2222222", customerNumber: "9001" }).returning();
    await db.insert(schema.orders).values([fixtureOrder("LOCAL-LINKED", customer.id), fixtureOrder("LOCAL-UNLINKED")]);

    await t.test("migration idempotent, no reassignment, ready true, null customer audit allowed", async () => {
      assert(isPermissionsSchemaReady());
      assert.equal((await pool.query("SELECT customer_id FROM orders WHERE order_id='LOCAL-UNLINKED'")).rows[0].customer_id, null);
      await db.insert(schema.customerCommunications).values({ customerId: null, customerLinkReview: 1, type: "email", orderId: "LOCAL-UNLINKED" });
      assert.equal((await pool.query("SELECT customer_link_review FROM customer_communications")).rows[0].customer_link_review, 1);
      assert.equal((await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_name='customer_communications' AND column_name='customer_id'")).rows[0].is_nullable, "YES");
    });
    const changed = resolveCheckoutCustomerDataChange([customer], { ...fixtureCustomer, street: "New Street", communicationLanguage: "en" } as any);
    assert.equal(changed.kind, "matched");
    if (changed.kind !== "matched") throw Error("fixture matching failed");
    const persist = async (tx: any, token: string, orderId: string, fail = false) => {
      await consumeCustomerDataChangeConfirmation(tx, token, changed);
      await tx.insert(schema.orders).values({ ...fixtureOrder(orderId, customer.id), street: changed.submittedSnapshot.street });
      await persistConfirmedCustomerDataChange(tx, { customerId: customer.id, orderId, matchedBy: changed.matchedBy, previousSnapshot: changed.previousSnapshot, submittedSnapshot: changed.submittedSnapshot, changedFields: changed.changedFields });
      if (fail) throw Error("SYNTHETIC_ROLLBACK");
    };
    await t.test("confirmation/order audit rollback fully, token reusable only after rollback, then replay denied", async () => {
      const { confirmationToken } = await createCustomerDataChangeConfirmation(db, changed);
      await assert.rejects(db.transaction(tx => persist(tx, confirmationToken, "LOCAL-ROLLBACK", true)), /SYNTHETIC_ROLLBACK/);
      assert.equal((await pool.query("SELECT count(*)::int n FROM orders WHERE order_id='LOCAL-ROLLBACK'")).rows[0].n, 0);
      assert.equal((await pool.query("SELECT count(*)::int n FROM customer_data_change_events")).rows[0].n, 0);
      await db.transaction(tx => persist(tx, confirmationToken, "LOCAL-CONSENT"));
      await assert.rejects(db.transaction(tx => persist(tx, confirmationToken, "LOCAL-REPLAY")), /RECONFIRMATION/);
      assert.equal((await pool.query("SELECT street, communication_language FROM customers WHERE id=$1", [customer.id])).rows[0].street, "Old Street");
      assert.equal((await pool.query("SELECT communication_language FROM customers WHERE id=$1", [customer.id])).rows[0].communication_language, "de");
      assert.equal((await pool.query("SELECT street FROM orders WHERE order_id='LOCAL-CONSENT'")).rows[0].street, "New Street");
    });
    await t.test("real simultaneous token consumers: exactly one committed snapshot/audit", async () => {
      const { confirmationToken } = await createCustomerDataChangeConfirmation(db, changed);
      const result = await Promise.allSettled([db.transaction(tx => persist(tx, confirmationToken, "LOCAL-RACE-1")), db.transaction(tx => persist(tx, confirmationToken, "LOCAL-RACE-2"))]);
      assert.equal(result.filter(x => x.status === "fulfilled").length, 1);
      assert.equal((await pool.query("SELECT count(*)::int n FROM orders WHERE order_id LIKE 'LOCAL-RACE-%'")).rows[0].n, 1);
      assert.equal((await pool.query("SELECT count(*)::int n FROM customer_data_change_events WHERE order_id LIKE 'LOCAL-RACE-%'")).rows[0].n, 1);
    });
    await t.test("CRM read-only transaction permits query, creates/links nothing; exact unique explicit link idempotent", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        const context = await readCrmOrderContext(drizzle(client), "LOCAL-UNLINKED");
        assert.equal(context.matchState, "unique_match"); await client.query("COMMIT");
      } finally { client.release(); }
      assert.equal((await pool.query("SELECT customer_id FROM orders WHERE order_id='LOCAL-UNLINKED'")).rows[0].customer_id, null);
      const result = await Promise.all([linkCrmExistingOrder(db, "LOCAL-UNLINKED"), linkCrmExistingOrder(db, "LOCAL-UNLINKED")]);
      assert(result.every(x => x.customerId === customer.id));
      assert.equal((await pool.query("SELECT count(*)::int n FROM customers")).rows[0].n, 2);
    });
    await t.test("mixed ambiguity, wildcard, stale explicit links require review without mutation", async () => {
      await db.insert(schema.customers).values({ ...fixtureCustomer, phone: "0173 3333333", customerNumber: "9002" });
      await db.insert(schema.orders).values([fixtureOrder("LOCAL-AMBIGUOUS"), { ...fixtureOrder("LOCAL-WILDCARD"), email: "%@fixture.invalid", phone: "" }, fixtureOrder("LOCAL-STALE", 99999)]);
      for (const id of ["LOCAL-AMBIGUOUS", "LOCAL-WILDCARD", "LOCAL-STALE"]) {
        assert.equal((await readCrmOrderContext(db, id)).customerId, null);
        await assert.rejects(linkCrmExistingOrder(db, id), /manuelle Prüfung/);
      }
    });
    await t.test("F32 missing target fails closed; injected audit failure rolls assignment back; repeated concurrent same-target creates one audit", async () => {
      await assert.rejects(reassignOrderCustomer(db, { orderId: "LOCAL-LINKED", newCustomerId: 99999 }, 1), /Zielkunde/);
      await pool.query("CREATE FUNCTION local_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END; $$; CREATE TRIGGER local_fail_audit BEFORE INSERT ON order_customer_assignment_events FOR EACH ROW EXECUTE FUNCTION local_fail_audit()");
      await assert.rejects(reassignOrderCustomer(db, { orderId: "LOCAL-LINKED", newCustomerId: other.id }, 1), (e: any) => /SYNTHETIC_AUDIT_FAILURE/.test(e.cause?.message || e.message));
      assert.equal((await pool.query("SELECT customer_id FROM orders WHERE order_id='LOCAL-LINKED'")).rows[0].customer_id, customer.id);
      await pool.query("DROP TRIGGER local_fail_audit ON order_customer_assignment_events");
      await Promise.all([reassignOrderCustomer(db, { orderId: "LOCAL-LINKED", newCustomerId: other.id }, 1), reassignOrderCustomer(db, { orderId: "LOCAL-LINKED", newCustomerId: other.id }, 1)]);
      assert.equal((await pool.query("SELECT count(*)::int n FROM order_customer_assignment_events")).rows[0].n, 1);
      assert.equal((await pool.query("SELECT total_orders FROM customers WHERE id=$1", [other.id])).rows[0].total_orders, 1);
    });
  } finally {
    await closeDb(); ENV.databaseUrl = ""; await pool.end();
    await admin.query(`DROP DATABASE ${name}`); await admin.end();
  }
});
