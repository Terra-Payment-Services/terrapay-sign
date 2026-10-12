-- Company seals: a visual seal an organisation's managers upload and its
-- members apply to V2 documents.
--
-- Additive only. Nothing is backfilled and no existing row changes. Roll
-- forward only: ALTER TYPE ... ADD VALUE cannot be undone without rebuilding
-- the type, and once a COMPANY_SEAL field exists a build without the value
-- cannot read that envelope.

-- AlterEnum
ALTER TYPE "FieldType" ADD VALUE 'COMPANY_SEAL';

-- CreateTable
CREATE TABLE "CompanySeal" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalEntityName" TEXT NOT NULL,
    "imageData" JSONB NOT NULL,
    "imageSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" INTEGER NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdFromIp" TEXT,
    "createdUserAgent" TEXT,

    CONSTRAINT "CompanySeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanySeal_organisationId_idx" ON "CompanySeal"("organisationId");

-- AddForeignKey
ALTER TABLE "CompanySeal" ADD CONSTRAINT "CompanySeal_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
