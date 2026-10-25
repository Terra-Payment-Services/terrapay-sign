-- Last accepted TOTP step per user (#197): an account-route code is refused once its step has been used.
--
-- Additive only. Existing users start at NULL, which accepts their next valid code.
ALTER TABLE "User" ADD COLUMN "lastTotpCounter" INTEGER;
