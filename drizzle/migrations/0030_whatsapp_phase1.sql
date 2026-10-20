-- EXPLICIT MAINTENANCE MIGRATION. No startup execution. Pause all legacy customer writers first.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN IF to_regprocedure('next_order_id()') IS NULL THEN RAISE EXCEPTION 'existing_order_number_function_required'; END IF; END $$;
LOCK TABLE customers IN SHARE ROW EXCLUSIVE MODE;
CREATE UNIQUE INDEX IF NOT EXISTS customers_customer_number_phase1_unique ON customers(customer_number);
CREATE SEQUENCE IF NOT EXISTS customer_number_seq AS bigint MINVALUE 1210 START WITH 1210;
-- Never rewind on retry or after rolled-back inserts. Reject out-of-range historical values rather than renumbering.
SELECT setval('customer_number_seq',GREATEST(1210,
 (SELECT coalesce(max(customer_number::bigint)+1,1210) FROM customers WHERE customer_number ~ '^[0-9]+$'),
 (SELECT last_value + CASE WHEN is_called THEN 1 ELSE 0 END FROM customer_number_seq)),false);
CREATE OR REPLACE FUNCTION next_customer_number() RETURNS text LANGUAGE sql VOLATILE AS $$ SELECT nextval('customer_number_seq')::text $$;
CREATE OR REPLACE FUNCTION normalize_whatsapp_contact_phone(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 WITH d AS (SELECT regexp_replace(coalesce(value,''),'[^0-9]','','g') AS n), p AS (SELECT CASE WHEN n LIKE '00%' THEN substring(n FROM 3) ELSE n END AS n FROM d) SELECT CASE WHEN n LIKE '490%' THEN '49'||substring(n FROM 4) WHEN n LIKE '0%' THEN '49'||regexp_replace(n,'^0+','') ELSE n END FROM p $$;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS preferred_delivery_type varchar(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_origin varchar(32);
CREATE TABLE IF NOT EXISTS whatsapp_order_provenance (
 execution_id uuid PRIMARY KEY, order_id varchar(32) NOT NULL UNIQUE REFERENCES orders(order_id),
 quote_id uuid NOT NULL UNIQUE, quote_revision integer NOT NULL, quote_hash varchar(64) NOT NULL,
 conversation_hash varchar(64) NOT NULL, owner_actor text NOT NULL,
 email_requested boolean NOT NULL DEFAULT false CHECK(email_requested=false),created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
