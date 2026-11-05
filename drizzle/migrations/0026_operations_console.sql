BEGIN;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS ops_version bigint NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS ops_console_previews (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL, operation_type text NOT NULL,
 target_id integer NOT NULL, target_sku text NOT NULL, before_snapshot jsonb NOT NULL,
 planned_mutation jsonb NOT NULL, expected_hash text NOT NULL,
 idempotency_key uuid UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, confirmed_at timestamptz, status text NOT NULL DEFAULT 'ready_for_confirmation'
);
CREATE TABLE IF NOT EXISTS ops_console_receipts (
 id uuid PRIMARY KEY, preview_id uuid NOT NULL UNIQUE REFERENCES ops_console_previews(id),
 actor_id uuid NOT NULL, target_id integer NOT NULL, state text NOT NULL,
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS ops_console_fences (
 target_id integer PRIMARY KEY, receipt_id uuid NOT NULL UNIQUE REFERENCES ops_console_receipts(id)
);
CREATE TABLE IF NOT EXISTS ops_console_events (
 id bigserial PRIMARY KEY, receipt_id uuid, preview_id uuid, actor_id uuid NOT NULL,
 event_type text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION ops_console_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ops_audit_append_only'; END $$;
DROP TRIGGER IF EXISTS ops_audit_append_only ON ops_console_events;
CREATE TRIGGER ops_audit_append_only BEFORE UPDATE OR DELETE ON ops_console_events FOR EACH ROW EXECUTE FUNCTION ops_console_event_immutable();
CREATE OR REPLACE FUNCTION ops_console_article_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fence uuid;
BEGIN
 SELECT receipt_id INTO fence FROM ops_console_fences WHERE target_id=OLD.id;
 IF fence IS NOT NULL AND coalesce(current_setting('ops.receipt_id',true),'')<>fence::text THEN
  RAISE EXCEPTION 'ops_target_outcome_pending' USING ERRCODE='40001';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF (to_jsonb(NEW)-'updated_at'-'ops_version') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at'-'ops_version') THEN
  NEW.ops_version := OLD.ops_version+1;
 ELSE NEW.ops_version := OLD.ops_version; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ops_console_article_guard ON articles;
CREATE TRIGGER ops_console_article_guard BEFORE UPDATE OR DELETE ON articles FOR EACH ROW EXECUTE FUNCTION ops_console_article_guard();
COMMIT;
