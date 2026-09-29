ALTER TABLE deliveries ADD COLUMN failure_reason TEXT;

ALTER TABLE driver_assignments DROP CONSTRAINT driver_assignments_status_check;
ALTER TABLE driver_assignments ADD CONSTRAINT driver_assignments_status_check
  CHECK (status IN ('OFFERED', 'ACCEPTED', 'REJECTED', 'REASSIGNED', 'COMPLETED', 'CANCELLED', 'FAILED'));
