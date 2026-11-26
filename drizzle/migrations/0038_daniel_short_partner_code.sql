-- Owner authorization 2026-11-26: replace Daniel's public customer code only.
-- Existing login number/password, financial terms, orders, sessions and mail stay untouched.
-- Startup-only explicit data migration: no write is attached to a read API and no new rights.
CREATE TABLE IF NOT EXISTS partner_code_replacement_receipts (
  operation_key VARCHAR(100) PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  old_code_id INTEGER NOT NULL REFERENCES partner_codes(id) ON DELETE RESTRICT,
  new_code_id INTEGER NOT NULL REFERENCES partner_codes(id) ON DELETE RESTRICT,
  old_code VARCHAR(50) NOT NULL,
  new_code VARCHAR(50) NOT NULL,
  authorization_note TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$
DECLARE
  p partners%ROWTYPE;
  previous partner_codes%ROWTYPE;
  replacement_id INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM partner_code_replacement_receipts
    WHERE operation_key='20261126:daniel11:short-customer-code:v1') THEN RETURN; END IF;
  -- Fresh databases and unrelated installations must never acquire a synthetic partner.
  IF NOT EXISTS (SELECT 1 FROM partners WHERE id=11
    AND code='BEN-DANIELKREISMANN10-62E3CE90B458') THEN RETURN; END IF;
  -- Same short-lived collision lock as the established invitation approval writer.
  LOCK TABLE partners, partner_codes, promo_codes IN SHARE ROW EXCLUSIVE MODE;
  -- Another concurrent startup might have applied this while the lock was acquired.
  IF EXISTS (SELECT 1 FROM partner_code_replacement_receipts
    WHERE operation_key='20261126:daniel11:short-customer-code:v1') THEN RETURN; END IF;
  SELECT * INTO STRICT p FROM partners WHERE id=11 FOR UPDATE;
  IF p.name<>'Daniel Kreismann' OR p.partner_number<>'BEN-CEC6251E866C4B89'
    OR p.code<>'BEN-DANIELKREISMANN10-62E3CE90B458' OR p.program_key<>'creator'
    OR p.is_active<>1 OR p.commission_percent<>10 OR p.customer_discount_percent<>10 THEN
    RAISE EXCEPTION 'short_code_identity_or_terms_mismatch';
  END IF;
  IF (SELECT COUNT(*) FROM partner_codes WHERE partner_id=11 AND is_active)=1 THEN
    SELECT * INTO STRICT previous FROM partner_codes
      WHERE id=1483 AND partner_id=11
        AND code_normalized='BEN-DANIELKREISMANN10-62E3CE90B458'
        AND display_code='BEN-DANIELKREISMANN10-62E3CE90B458' AND is_active
      FOR UPDATE;
  ELSE RAISE EXCEPTION 'short_code_active_codes_mismatch'; END IF;
  IF previous.commission_percent<>10 OR previous.customer_discount_percent<>10 THEN
    RAISE EXCEPTION 'short_code_specific_terms_mismatch';
  END IF;
  IF EXISTS(SELECT 1 FROM partner_codes
      WHERE UPPER(code_normalized)='DANIEL10' OR UPPER(display_code)='DANIEL10')
    OR EXISTS(SELECT 1 FROM partners p2
      CROSS JOIN LATERAL regexp_split_to_table(COALESCE(p2.code,''), ',') c(code)
      WHERE UPPER(BTRIM(c.code))='DANIEL10')
    OR EXISTS(SELECT 1 FROM promo_codes WHERE is_active=1 AND UPPER(BTRIM(code))='DANIEL10') THEN
    RAISE EXCEPTION 'short_code_new_code_occupied';
  END IF;
  INSERT INTO partner_codes(partner_id,display_code,code_normalized,is_active,
    commission_percent,customer_discount_percent)
    VALUES(11,'DANIEL10','DANIEL10',TRUE,10,10) RETURNING id INTO replacement_id;
  -- Retain immutable code identity and snapshots; never rename/delete old code rows.
  UPDATE partner_codes SET is_active=FALSE, updated_at=NOW() WHERE id=previous.id;
  UPDATE partners SET code='DANIEL10',updated_at=NOW() WHERE id=11;
  INSERT INTO partner_code_replacement_receipts(operation_key,partner_id,old_code_id,
    new_code_id,old_code,new_code,authorization_note)
    VALUES('20261126:daniel11:short-customer-code:v1',11,previous.id,replacement_id,
      previous.display_code,'DANIEL10','Owner Pakko explicitly requested shorter customer code without BEN on 2026-11-26; no credential or financial change');
END $$;
