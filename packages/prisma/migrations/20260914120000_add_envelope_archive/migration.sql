-- CreateTable
CREATE TABLE "EnvelopeArchive" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "envelopeItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "driveId" TEXT,
    "itemId" TEXT,
    "webUrl" TEXT,
    "path" TEXT,

    CONSTRAINT "EnvelopeArchive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EnvelopeArchive_envelopeItemId_key" ON "EnvelopeArchive"("envelopeItemId");

-- CreateIndex
CREATE INDEX "EnvelopeArchive_envelopeId_idx" ON "EnvelopeArchive"("envelopeId");

-- CreateIndex
CREATE INDEX "EnvelopeArchive_archivedAt_idx" ON "EnvelopeArchive"("archivedAt");

-- AddForeignKey
ALTER TABLE "EnvelopeArchive" ADD CONSTRAINT "EnvelopeArchive_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvelopeArchive" ADD CONSTRAINT "EnvelopeArchive_envelopeItemId_fkey" FOREIGN KEY ("envelopeItemId") REFERENCES "EnvelopeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
