-- ISOLATED REHEARSAL ONLY. Never run on the production database.
CREATE TABLE wop_quotes(id uuid PRIMARY KEY, tenant text NOT NULL, conversation text NOT NULL, draft_id uuid NOT NULL, revision integer NOT NULL, hash text NOT NULL, snapshot jsonb NOT NULL, fingerprint text NOT NULL, expires_at timestamptz NOT NULL, challenge uuid NOT NULL, confirmation jsonb, approval_hash text, approval_actor text, executed boolean NOT NULL DEFAULT false, UNIQUE(tenant,conversation,draft_id,revision));
CREATE TABLE wop_executions(id uuid PRIMARY KEY, tenant text NOT NULL, quote_id uuid NOT NULL REFERENCES wop_quotes(id), hash text NOT NULL, result jsonb NOT NULL, UNIQUE(quote_id));
CREATE TABLE wop_intents(tenant text NOT NULL,conversation text NOT NULL,draft_id uuid NOT NULL,execution_id uuid NOT NULL,PRIMARY KEY(tenant,conversation,draft_id));
CREATE TABLE wop_test_inventory(sku text PRIMARY KEY,stock integer NOT NULL CHECK(stock>=0));
CREATE TABLE wop_test_promos(code text PRIMARY KEY,used integer NOT NULL DEFAULT 0,max_uses integer NOT NULL DEFAULT 0);
CREATE TABLE wop_test_orders(id uuid PRIMARY KEY, execution_id uuid NOT NULL UNIQUE, snapshot jsonb NOT NULL, order_origin text NOT NULL CHECK(order_origin='whatsapp_bot'),payment_method text NOT NULL CHECK(payment_method='SEPA'),email_requested boolean NOT NULL DEFAULT false CHECK(email_requested=false));
