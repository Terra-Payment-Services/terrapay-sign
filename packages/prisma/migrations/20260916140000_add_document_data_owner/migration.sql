-- Records who put the bytes in each DocumentData row.
--
-- Until now the only thing establishing provenance was EnvelopeItem, which is
-- unique per row. Bytes an envelope holds belong to that envelope's team. Bytes
-- nothing holds belonged to nobody, so whoever learned the ID returned by
-- POST /api/files/upload-pdf could name it as an item of their own envelope and
-- read another tenant's contract. There was nothing recorded to refuse them
-- with.
--
-- Both columns are nullable, and neither one is knowable at every creation
-- site. The upload endpoint authenticates a person and is told no team, so its
-- rows carry a user alone. The sealing job and the direct-link template path
-- run with no signed-in person, so their rows carry a team alone. Every row
-- written before this migration carries neither. A row carrying neither is
-- refused to everybody, which is why the backfill matters.
--
-- createdAt is added without a default and given one afterwards, so rows that
-- predate the column read as null instead of claiming they were written at the
-- moment this migration ran. New rows get CURRENT_TIMESTAMP.
--
-- AFTER DEPLOYING THIS, AN OPERATOR MUST:
--   1. Run the backfill, which derives the owner from EnvelopeItem -> Envelope
--      and reads nothing else:
--        npm run backfill:document-data-owner        (add --commit to write)
--   2. Deal with the rows it lists. A row no envelope item holds has no owner
--      recorded anywhere in the data, and no query will find one. Those rows
--      are unfinished uploads. Delete them, or ask the person who uploaded
--      them. Do not stamp them with a plausible team, because that guess is the
--      hole this column exists to close.
--   3. Expect a draft started before this migration and finished after it to be
--      refused. The document data ID the browser is holding carries no owner.
--      Re-uploading the file fixes it. This is the reason to deploy before
--      there is production data rather than after.

-- AlterTable
ALTER TABLE "DocumentData" ADD COLUMN     "createdAt" TIMESTAMP(3),
ADD COLUMN     "teamId" INTEGER,
ADD COLUMN     "userId" INTEGER;

ALTER TABLE "DocumentData" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "DocumentData_userId_idx" ON "DocumentData"("userId");

-- CreateIndex
CREATE INDEX "DocumentData_teamId_idx" ON "DocumentData"("teamId");

-- CreateIndex
CREATE INDEX "DocumentData_createdAt_idx" ON "DocumentData"("createdAt");

-- AddForeignKey
ALTER TABLE "DocumentData" ADD CONSTRAINT "DocumentData_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentData" ADD CONSTRAINT "DocumentData_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
