import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';

const mocks = vi.hoisted(() => ({
  documentDataFindMany: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    documentData: { findMany: mocks.documentDataFindMany },
  },
}));

import { assertDocumentDataAccess } from './assert-document-data-access';

const LEGAL_TEAM_ID = 11;
const HR_TEAM_ID = 12;

const ALICE_ID = 101;
const MALLORY_ID = 102;

/** A row whose envelope item places it in the given team. */
const heldBy = (id: string, teamId: number) => ({
  id,
  userId: null,
  teamId: null,
  envelopeItem: { envelope: { teamId } },
});

/** A bare upload from the upload endpoint, which knows a person and no team. */
const uploadedBy = (id: string, userId: number) => ({
  id,
  userId,
  teamId: null,
  envelopeItem: null,
});

/** A bare upload minted server-side for a team, with nobody signed in. */
const mintedFor = (id: string, teamId: number) => ({
  id,
  userId: null,
  teamId,
  envelopeItem: null,
});

/** A row from before DocumentData carried an owner, or one the backfill gave up on. */
const unowned = (id: string) => ({
  id,
  userId: null,
  teamId: null,
  envelopeItem: null,
});

describe('assertDocumentDataAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The advisory. Legal knows the document data ID of an HR contract, because
  // the PDF routes carry it in the URL, and names it as an item of a new
  // envelope in their own team.
  it('refuses a document data ID held by another team', async () => {
    mocks.documentDataFindMany.mockResolvedValue([heldBy('data_hr_contract', HR_TEAM_ID)]);

    await expect(
      assertDocumentDataAccess({
        teamId: LEGAL_TEAM_ID,
        userId: ALICE_ID,
        documentDataIds: ['data_hr_contract'],
      }),
    ).rejects.toThrow(AppError);
  });

  // Saying "not found" rather than "not yours" keeps the endpoint from
  // confirming that the ID exists in a team the caller cannot see.
  it("refuses another team's ID as missing rather than forbidden", async () => {
    mocks.documentDataFindMany.mockResolvedValue([heldBy('data_hr_contract', HR_TEAM_ID)]);

    await expect(
      assertDocumentDataAccess({
        teamId: LEGAL_TEAM_ID,
        userId: ALICE_ID,
        documentDataIds: ['data_hr_contract'],
      }),
    ).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });
  });

  it('refuses when one ID of several belongs to another team', async () => {
    mocks.documentDataFindMany.mockResolvedValue([
      uploadedBy('data_fresh_upload', ALICE_ID),
      heldBy('data_hr_contract', HR_TEAM_ID),
    ]);

    await expect(
      assertDocumentDataAccess({
        teamId: LEGAL_TEAM_ID,
        userId: ALICE_ID,
        documentDataIds: ['data_fresh_upload', 'data_hr_contract'],
      }),
    ).rejects.toThrow(AppError);
  });

  it("allows bytes the caller's own team already holds", async () => {
    mocks.documentDataFindMany.mockResolvedValue([heldBy('data_own_template', LEGAL_TEAM_ID)]);

    await expect(
      assertDocumentDataAccess({
        teamId: LEGAL_TEAM_ID,
        userId: ALICE_ID,
        documentDataIds: ['data_own_template'],
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses an ID that matches no row at all', async () => {
    mocks.documentDataFindMany.mockResolvedValue([]);

    await expect(
      assertDocumentDataAccess({
        teamId: LEGAL_TEAM_ID,
        userId: ALICE_ID,
        documentDataIds: ['data_invented'],
      }),
    ).rejects.toThrow(AppError);
  });

  it('refuses when the query returns fewer rows than were asked for', async () => {
    mocks.documentDataFindMany.mockResolvedValue([uploadedBy('data_fresh_upload', ALICE_ID)]);

    await expect(
      assertDocumentDataAccess({
        teamId: LEGAL_TEAM_ID,
        userId: ALICE_ID,
        documentDataIds: ['data_fresh_upload', 'data_invented'],
      }),
    ).rejects.toThrow(AppError);
  });

  it('asks the database nothing when there are no IDs to check', async () => {
    await expect(
      assertDocumentDataAccess({ teamId: LEGAL_TEAM_ID, userId: ALICE_ID, documentDataIds: [] }),
    ).resolves.toBeUndefined();

    expect(mocks.documentDataFindMany).not.toHaveBeenCalled();
  });

  it('deduplicates repeated IDs before querying', async () => {
    mocks.documentDataFindMany.mockResolvedValue([uploadedBy('data_fresh_upload', ALICE_ID)]);

    await assertDocumentDataAccess({
      teamId: LEGAL_TEAM_ID,
      userId: ALICE_ID,
      documentDataIds: ['data_fresh_upload', 'data_fresh_upload'],
    });

    expect(mocks.documentDataFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['data_fresh_upload'] } } }),
    );
  });

  describe('a bare upload that no envelope holds', () => {
    // This is the whole point. Mallory watches Alice upload, learns the cuid
    // that POST /api/files/upload-pdf handed back, and names it as an item of
    // an envelope in a team Alice has never heard of. Before DocumentData
    // carried an uploader there was nothing to refuse him with.
    it('refuses one uploaded by somebody else', async () => {
      mocks.documentDataFindMany.mockResolvedValue([uploadedBy('data_alice_upload', ALICE_ID)]);

      await expect(
        assertDocumentDataAccess({
          teamId: HR_TEAM_ID,
          userId: MALLORY_ID,
          documentDataIds: ['data_alice_upload'],
        }),
      ).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });
    });

    it('allows one the caller uploaded themselves', async () => {
      mocks.documentDataFindMany.mockResolvedValue([uploadedBy('data_alice_upload', ALICE_ID)]);

      await expect(
        assertDocumentDataAccess({
          teamId: LEGAL_TEAM_ID,
          userId: ALICE_ID,
          documentDataIds: ['data_alice_upload'],
        }),
      ).resolves.toBeUndefined();
    });

    // The upload endpoint is told no team, so an upload is not tied to the team
    // the person happened to be looking at when they made it.
    it('allows one the caller uploaded while they act for another of their teams', async () => {
      mocks.documentDataFindMany.mockResolvedValue([uploadedBy('data_alice_upload', ALICE_ID)]);

      await expect(
        assertDocumentDataAccess({
          teamId: HR_TEAM_ID,
          userId: ALICE_ID,
          documentDataIds: ['data_alice_upload'],
        }),
      ).resolves.toBeUndefined();
    });

    it("allows one minted for the caller's own team", async () => {
      mocks.documentDataFindMany.mockResolvedValue([mintedFor('data_sealed_output', LEGAL_TEAM_ID)]);

      await expect(
        assertDocumentDataAccess({
          teamId: LEGAL_TEAM_ID,
          userId: MALLORY_ID,
          documentDataIds: ['data_sealed_output'],
        }),
      ).resolves.toBeUndefined();
    });

    it('refuses one minted for another team, whoever the caller is', async () => {
      mocks.documentDataFindMany.mockResolvedValue([mintedFor('data_hr_seal', HR_TEAM_ID)]);

      await expect(
        assertDocumentDataAccess({
          teamId: LEGAL_TEAM_ID,
          userId: ALICE_ID,
          documentDataIds: ['data_hr_seal'],
        }),
      ).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });
    });

    // A row stamped with a team is refused outside that team even to the person
    // who caused it, because the team stamp is the stronger statement.
    it('refuses one minted for another team even to its own uploader', async () => {
      mocks.documentDataFindMany.mockResolvedValue([
        { id: 'data_hr_draft', userId: ALICE_ID, teamId: HR_TEAM_ID, envelopeItem: null },
      ]);

      await expect(
        assertDocumentDataAccess({
          teamId: LEGAL_TEAM_ID,
          userId: ALICE_ID,
          documentDataIds: ['data_hr_draft'],
        }),
      ).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });
    });

    // Rows written before the owner columns existed, and rows the backfill
    // listed rather than guessed at. Nobody can claim them.
    it('refuses one carrying no identity at all', async () => {
      mocks.documentDataFindMany.mockResolvedValue([unowned('data_legacy')]);

      await expect(
        assertDocumentDataAccess({
          teamId: LEGAL_TEAM_ID,
          userId: ALICE_ID,
          documentDataIds: ['data_legacy'],
        }),
      ).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });
    });
  });

  // The envelope is where the bytes live, so it settles the question on a held
  // row and the upload stamp is not consulted.
  it('lets the holding envelope decide even when the stamp disagrees', async () => {
    mocks.documentDataFindMany.mockResolvedValue([
      {
        id: 'data_moved',
        userId: MALLORY_ID,
        teamId: HR_TEAM_ID,
        envelopeItem: { envelope: { teamId: LEGAL_TEAM_ID } },
      },
    ]);

    await expect(
      assertDocumentDataAccess({
        teamId: LEGAL_TEAM_ID,
        userId: ALICE_ID,
        documentDataIds: ['data_moved'],
      }),
    ).resolves.toBeUndefined();
  });

  // If a later edit drops these from the select, every unheld row reads as
  // unowned and the guard starts refusing work it should allow. Catch it here
  // rather than in production.
  it('reads the owner columns back from the database', async () => {
    mocks.documentDataFindMany.mockResolvedValue([uploadedBy('data_fresh_upload', ALICE_ID)]);

    await assertDocumentDataAccess({
      teamId: LEGAL_TEAM_ID,
      userId: ALICE_ID,
      documentDataIds: ['data_fresh_upload'],
    });

    expect(mocks.documentDataFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ userId: true, teamId: true }),
      }),
    );
  });
});
