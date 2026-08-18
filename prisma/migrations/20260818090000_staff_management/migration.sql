ALTER TABLE "AdminUser"
  ADD COLUMN "employeeId" VARCHAR(80),
  ADD COLUMN "dateOfBirth" DATE,
  ADD COLUMN "addressLine1" VARCHAR(250),
  ADD COLUMN "addressLine2" VARCHAR(250),
  ADD COLUMN "city" VARCHAR(100),
  ADD COLUMN "state" VARCHAR(100),
  ADD COLUMN "country" VARCHAR(100),
  ADD COLUMN "designation" VARCHAR(150),
  ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastFailedLoginAt" TIMESTAMPTZ(6),
  ADD COLUMN "blockedAt" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "AdminUser_organizationId_employeeId_key"
  ON "AdminUser"("organizationId", "employeeId");
