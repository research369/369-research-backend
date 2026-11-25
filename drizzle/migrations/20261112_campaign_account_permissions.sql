-- Additive authorization for ONE existing account; no role-wide or admin grant.
-- Run after 20261106_permissions_hardening.sql, whose original CHECK stays unchanged.
-- Replace and validate the CHECK atomically; never delete or rewrite grant rows.
BEGIN;
ALTER TABLE operations_account_capability_grants
  DROP CONSTRAINT IF EXISTS operations_account_capability_grants_capability_check;
ALTER TABLE operations_account_capability_grants
  ADD CONSTRAINT operations_account_capability_grants_capability_check
  CHECK (capability IN ('operations_read','partner_credit_adjust','order_cleanup','campaign_settings')) NOT VALID;
ALTER TABLE operations_account_capability_grants
  VALIDATE CONSTRAINT operations_account_capability_grants_capability_check;

-- Permanent authorization; replay preserves an existing grant, including revocation.
INSERT INTO operations_account_capability_grants (user_id, username, required_role, capability, grant_reason)
SELECT account.id, account.username, account.role::text, 'campaign_settings',
       '2026-11-12 Userauthorize at 13:42:36: Pakko explicitly authorized existing account id=2 username=product_manager role=product_manager to permanently read/save global campaign and promotion presets ONLY; no full admin, shop master toggle, all settings, other configuration, new customers, payments or users rights'
FROM users AS account
WHERE account.id = 2 AND account.username = 'product_manager' AND account.role::text = 'product_manager'
ON CONFLICT DO NOTHING;
COMMIT;
