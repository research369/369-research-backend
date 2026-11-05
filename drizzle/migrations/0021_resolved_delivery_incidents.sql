-- Preserve historical delivery failures while recording an operator's completed
-- address correction. Future provider retries remain journalled but no longer
-- send duplicate operational alerts for the already-resolved incident.
ALTER TABLE customer_communications
  ADD COLUMN IF NOT EXISTS delivery_issue_resolved_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS delivery_issue_resolution VARCHAR(500),
  ADD COLUMN IF NOT EXISTS delivery_issue_resolved_by VARCHAR(100);
