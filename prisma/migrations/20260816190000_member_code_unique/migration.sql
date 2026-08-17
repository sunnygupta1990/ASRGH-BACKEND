-- This migration intentionally fails if duplicate non-null member codes already exist.
-- Resolve duplicates before applying; PostgreSQL permits multiple NULL values here.
CREATE UNIQUE INDEX "Member_organizationId_memberCode_key"
ON "Member"("organizationId", "memberCode");
