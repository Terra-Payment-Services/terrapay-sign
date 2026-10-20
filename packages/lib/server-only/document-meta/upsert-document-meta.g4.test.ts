import path from 'node:path';

import dotenv from 'dotenv';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * G4 C28: updateDocumentMeta refuses a call whose merged
 * signature-method flags are all false, so a future caller cannot bypass the
 * route checks of C25 and C26. Written from the G4 specification before any
 * fix, without reading updateDocumentMeta. No route passes the flags to it
 * today (spec 1.4), so E2E cannot reach the behaviour; this is the isolated
 * test the spec asks for.
 *
 * Failure modes:
 * 1. All three flags sent false on an envelope with all three on is stored.
 * 2. One flag sent false on an envelope whose other two are already false is
 *    stored: the check looks only at the incoming values, not the merged ones.
 * 3. A refused call still writes some of the flags (partial write).
 * 4. The refusal is a plain Error rather than AppError INVALID_REQUEST, so the
 *    routes would answer 500.
 * 5. A valid change (one method left on) is refused (over-refusal).
 *
 * Seam: the real function against the real database of the local stack, with
 * rows seeded through Prisma. Nothing is mocked, because a fake of the Prisma
 * surface would have to be written from the implementation's call shapes. It
 * catches the merge and the write; it misses route wiring, which C25-C26 cover.
 *
 * The database comes from the worktree's .env (NEXT_PRIVATE_DATABASE_URL). With
 * no database configured at all the suite is skipped and says so; with one
 * configured but unreachable it fails.
 */
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

const hasDatabase = Boolean(process.env.NEXT_PRIVATE_DATABASE_URL);

type Flags = { typedSignatureEnabled: boolean; drawSignatureEnabled: boolean; uploadSignatureEnabled: boolean };

const ALL_ON: Flags = { typedSignatureEnabled: true, drawSignatureEnabled: true, uploadSignatureEnabled: true };

describe.skipIf(!hasDatabase)('G4 C28 updateDocumentMeta refuses a merged policy with no method', () => {
  let prisma: typeof import('@documenso/prisma').prisma;
  let updateDocumentMeta: typeof import('./upsert-document-meta').updateDocumentMeta;
  let owner: { userId: number; teamId: number };

  const requestMetadata = {
    requestMetadata: { ipAddress: '127.0.0.1', userAgent: 'g4-c28' },
    source: 'app' as const,
    auth: 'session' as const,
  };

  beforeAll(async () => {
    ({ prisma } = await import('@documenso/prisma'));
    ({ updateDocumentMeta } = await import('./upsert-document-meta'));

    const { seedUser } = await import('@documenso/prisma/seed/users');
    const { user, team } = await seedUser();

    owner = { userId: user.id, teamId: team.id };
  });

  const seedDraft = async (flags: Flags) => {
    const { seedBlankDocument } = await import('@documenso/prisma/seed/documents');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
    const envelope = await seedBlankDocument(user, owner.teamId, { internalVersion: 2 });

    await prisma.documentMeta.update({ where: { id: envelope.documentMetaId }, data: flags });

    return envelope;
  };

  const storedFlags = async (documentMetaId: string) => {
    const meta = await prisma.documentMeta.findUniqueOrThrow({ where: { id: documentMetaId } });

    return {
      typedSignatureEnabled: meta.typedSignatureEnabled,
      drawSignatureEnabled: meta.drawSignatureEnabled,
      uploadSignatureEnabled: meta.uploadSignatureEnabled,
    };
  };

  const callWith = async (envelopeId: string, flags: Partial<Flags>) =>
    await updateDocumentMeta({
      userId: owner.userId,
      teamId: owner.teamId,
      id: { type: 'envelopeId', id: envelopeId },
      ...flags,
      requestMetadata,
    });

  const expectInvalidRequest = async (call: Promise<unknown>) => {
    const outcome = await call.then(
      () => ({ refused: false as const }),
      (error: unknown) => ({ refused: true as const, error }),
    );

    expect(outcome.refused, 'the call is refused').toBe(true);

    if (outcome.refused) {
      const { AppError, AppErrorCode } = await import('../../errors/app-error');

      expect(outcome.error, 'the refusal is an AppError').toBeInstanceOf(AppError);
      expect((outcome.error as InstanceType<typeof AppError>).code).toBe(AppErrorCode.INVALID_REQUEST);
    }
  };

  it('control: a change that leaves a method on is stored', async () => {
    const envelope = await seedDraft(ALL_ON);

    await callWith(envelope.id, { drawSignatureEnabled: false });

    expect(await storedFlags(envelope.documentMetaId)).toEqual({ ...ALL_ON, drawSignatureEnabled: false });
  });

  it('refuses all three sent false and stores nothing', async () => {
    const envelope = await seedDraft(ALL_ON);

    await expectInvalidRequest(
      callWith(envelope.id, {
        typedSignatureEnabled: false,
        drawSignatureEnabled: false,
        uploadSignatureEnabled: false,
      }),
    );

    expect(await storedFlags(envelope.documentMetaId)).toEqual(ALL_ON);
  });

  it('refuses draw sent false when typed and upload are already false (the merged result)', async () => {
    const seeded = { typedSignatureEnabled: false, drawSignatureEnabled: true, uploadSignatureEnabled: false };
    const envelope = await seedDraft(seeded);

    await expectInvalidRequest(callWith(envelope.id, { drawSignatureEnabled: false }));

    expect(await storedFlags(envelope.documentMetaId)).toEqual(seeded);
  });
});
