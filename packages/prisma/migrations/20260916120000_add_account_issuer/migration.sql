-- Records the authority that issued the token each Account row was created
-- from. `provider` is our own label and the URL behind it is editable, so the
-- label on its own cannot tell a returning person from a token minted by an
-- authority somebody repointed the label at.
--
-- The column is nullable and every existing row starts null. Nulls do not
-- collide in a Postgres unique index, so the new constraint is inert until rows
-- carry an issuer. The old (provider, providerAccountId) constraint stays; a
-- sign in against a null-issuer row is accepted on the label and stamps the
-- issuer as it goes, so the estate converges on its own.
--
-- AFTER DEPLOYING THIS, AN OPERATOR MUST:
--   1. Run the backfill, which reads `iss` out of each row's stored id_token
--      offline and calls no authority:
--        npm run backfill:account-issuer          (add --commit to write)
--   2. Deal with the rows it lists as unbackfillable. A row with no id_token,
--      or one whose token does not parse, cannot be resolved from data and is a
--      decision for a person. Do not guess the issuer from the provider label
--      and the current configuration; that is the assumption this column exists
--      to remove.
--   3. Only once every deployment has been backfilled may a later migration
--      drop the (provider, providerAccountId) constraint. That is not this one.

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "issuer" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Account_issuer_providerAccountId_key" ON "Account"("issuer", "providerAccountId");
