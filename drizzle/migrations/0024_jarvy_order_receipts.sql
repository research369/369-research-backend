-- Additive, explicitly applied before enabling JARVY_WRITE_KEY.
CREATE TABLE IF NOT EXISTS jarvy_order_receipts (
 id uuid PRIMARY KEY,
 actor_id integer NOT NULL REFERENCES users(id),
 request_hash varchar(64) NOT NULL,
 payload_hash varchar(64) NOT NULL,
 state varchar(16) NOT NULL CHECK(state IN ('executing','succeeded','unknown')),
 order_id varchar(64),
 created_at timestamptz NOT NULL DEFAULT now()
);
