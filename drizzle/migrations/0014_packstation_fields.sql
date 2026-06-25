-- ============================================================
-- PACKSTATION: delivery_type + dhl_post_number in orders
-- Datum: 2026-06-25 | Rein additiv – nur ALTER TABLE ADD COLUMN
-- ZERO RISK: Keine bestehenden Felder verändert, keine Daten gelöscht
-- Bestehende Bestellungen erhalten automatisch delivery_type = 'home'
-- ============================================================

-- delivery_type: 'home' (Standard-Hauslieferung) oder 'packstation'
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_type" varchar(20) NOT NULL DEFAULT 'home';

-- dhl_post_number: DHL-Postnummer des Kunden (6–10 Ziffern, nur bei Packstation)
-- Bei Hauslieferung bleibt dieses Feld NULL
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "dhl_post_number" varchar(20);
