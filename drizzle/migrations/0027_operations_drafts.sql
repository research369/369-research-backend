BEGIN;
CREATE TABLE IF NOT EXISTS ops_console_drafts(id uuid PRIMARY KEY,actor_id uuid NOT NULL,payload jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'draft',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
COMMIT;
