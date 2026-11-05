-- ============================================================
-- Packfoto-Historie: zusätzliche Nachweise ohne Überschreiben
-- Datum: 2026-09-10 | Additiv und idempotent
-- Bestehende orders.packing_photo_* Felder bleiben für Kompatibilität erhalten.
-- ============================================================

CREATE TABLE IF NOT EXISTS "packing_photo_history" (
  "id" serial PRIMARY KEY,
  "order_id" varchar(32) NOT NULL,
  "photo_data" text NOT NULL,
  "photo_at" timestamp NOT NULL DEFAULT now(),
  "source" varchar(16) NOT NULL DEFAULT 'retake',
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "packing_photo_history_source_check" CHECK ("source" IN ('initial', 'retake'))
);

CREATE INDEX IF NOT EXISTS "packing_photo_history_order_created_idx"
  ON "packing_photo_history" ("order_id", "created_at" DESC);

-- Das bislang einzige Packfoto jeder Bestellung wird genau einmal in die neue
-- Historie übertragen. Eine erneute Ausführung erzeugt keine Duplikate.
INSERT INTO "packing_photo_history" ("order_id", "photo_data", "photo_at", "source", "created_at")
SELECT
  o."order_id",
  o."packing_photo_data",
  COALESCE(o."packing_photo_at", o."updated_at", now()),
  'initial',
  COALESCE(o."packing_photo_at", o."updated_at", now())
FROM "orders" o
WHERE o."packing_photo_data" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "packing_photo_history" h
    WHERE h."order_id" = o."order_id"
  );
