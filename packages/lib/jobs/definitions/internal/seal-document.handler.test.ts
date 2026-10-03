import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobRunIO } from '../../client/_internal/job';

/**
 * Two ways the seal job damages a contract, both covered here.
 *
 * The first is what gets drawn. Sealing normally refuses to run while a
 * required field is unsigned, so a blank signature field never reaches the
 * renderer. On rejection that check is skipped deliberately, and the V2 draw
 * path grouped every field on the page regardless of whether anybody had filled
 * it in. The export renderer has no translations, so it labels an empty
 * signature field with its own field type, and a rejected contract reached the
 * SharePoint archive with the word SIGNATURE printed where a signature would
 * be.
 *
 * The second is who the job asks for team settings. It asked as the document's
 * author, whose access may have lapsed by the time the recipients get round to
 * signing. Membership here comes from Entra groups and is reconciled on a
 * schedule, so an ordinary leaver could strand every contract they ever sent at
 * PENDING.
 *
 * The PDF machinery is all stubbed out. What these tests watch is which fields
 * the renderer gets handed, and whether the job reaches the point of committing
 * a sealed envelope.
 */

const insertFieldInPDFV2 = vi.fn();
const signPdf = vi.fn();
const putPdfFileServerSide = vi.fn();
const teamFindFirst = vi.fn();
const triggerTeamWebhook = vi.fn();
const envelopeUpdates: Record<string, unknown>[] = [];

/** A PDF that answers every call the handler makes on it and holds no bytes. */
const stubPdfDocument = () => ({
  flattenAll: () => {},
  upgradeVersion: () => {},
  getPageCount: () => 1,
  getPage: () => ({ width: 595, height: 842, rotation: 0, drawPage: () => {} }),
  embedPage: async () => ({}),
  copyPagesFrom: async () => {},
  reload: async () => {},
  canSaveIncrementally: () => null,
  save: async () => new Uint8Array([1, 2, 3, 4]),
});

vi.mock('@libpdf/core', () => ({
  PDF: {
    load: async () => stubPdfDocument(),
  },
}));

vi.mock('@cantoo/pdf-lib', () => ({
  PDFDocument: { load: async () => ({ getForm: () => ({ flatten: () => {} }), save: async () => new Uint8Array() }) },
}));

vi.mock('@documenso/signing', () => ({
  signPdf: async (...args: unknown[]) => await signPdf(...args),
}));

vi.mock('@documenso/lib/server-only/pdf/existing-signatures', () => ({
  inspectExistingSignatures: () => ({ signedFieldCount: 0, canPreserve: true, blocker: null }),
}));

vi.mock('@documenso/lib/server-only/pdf/add-rejection-stamp-to-pdf', () => ({
  addRejectionStampToPdf: async () => {},
}));

vi.mock('@documenso/lib/server-only/pdf/generate-certificate-pdf', () => ({
  generateCertificatePdf: async () => stubPdfDocument(),
}));

vi.mock('@documenso/lib/server-only/pdf/generate-audit-log-pdf', () => ({
  generateAuditLogPdf: async () => stubPdfDocument(),
}));

vi.mock('@documenso/lib/server-only/pdf/get-page-size', () => ({
  getLastPageDimensions: () => ({ width: 595, height: 842 }),
}));

vi.mock('../../../server-only/pdf/insert-field-in-pdf-v2', () => ({
  insertFieldInPDFV2: async (...args: unknown[]) => {
    insertFieldInPDFV2(...args);

    return new Uint8Array([5, 6, 7, 8]);
  },
}));

vi.mock('../../../server-only/pdf/insert-field-in-pdf-v1', () => ({
  insertFieldInPDFV1: async () => {},
}));

vi.mock('../../../server-only/pdf/legacy-insert-field-in-pdf', () => ({
  legacy_insertFieldInPDF: async () => {},
}));

vi.mock('../../../server-only/htmltopdf/get-certificate-pdf', () => ({
  getCertificatePdf: async () => new Uint8Array(),
}));

vi.mock('../../../server-only/htmltopdf/get-audit-logs-pdf', () => ({
  getAuditLogsPdf: async () => new Uint8Array(),
}));

vi.mock('../../../server-only/webhooks/trigger/trigger-webhook', () => ({
  triggerWebhook: async () => {},
  triggerTeamWebhook: async (...args: unknown[]) => await triggerTeamWebhook(...args),
}));

vi.mock('../../../types/webhook-payload', () => ({
  mapEnvelopeToWebhookDocumentPayload: (envelope: unknown) => envelope,
  ZWebhookDocumentSchema: { parse: (value: unknown) => value },
}));

vi.mock('../../../universal/upload/get-file.server', () => ({
  getFileServerSide: async () => new Uint8Array([9, 9, 9, 9]),
}));

vi.mock('../../../universal/upload/put-file.server', () => ({
  putPdfFileServerSide: async (...args: unknown[]) => {
    putPdfFileServerSide(...args);

    return { documentData: { id: 'document_data_new' } };
  },
}));

vi.mock('../../client', () => ({
  jobs: {
    triggerJob: async () => undefined,
  },
}));

const transactionClient = {
  envelopeItem: { update: async () => ({}) },
  envelope: {
    update: async ({ data }: { data: Record<string, unknown> }) => {
      envelopeUpdates.push(data);

      return {};
    },
  },
  documentAuditLog: { create: async () => ({}) },
};

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: {
      findFirstOrThrow: async ({ where }: { where: Record<string, unknown> }) =>
        where.secondaryId ? currentEnvelope : { ...currentEnvelope, userId: 9, teamId: 1 },
      update: async () => ({}),
    },
    team: {
      findFirst: async (...args: unknown[]) => await teamFindFirst(...args),
    },
    recipient: {
      updateMany: async () => ({ count: 0 }),
    },
    $transaction: async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      await callback(transactionClient),
  },
}));

const { run } = await import('./seal-document.handler');

/**
 * Settings with the certificate and the audit log switched off, so the test is
 * about the fields on the page rather than about the pages appended after them.
 */
const teamRow = () => ({
  id: 1,
  organisation: {
    organisationGlobalSettings: {
      includeSigningCertificate: false,
      includeAuditLog: false,
      brandingEnabled: false,
      brandingLogo: '',
      brandingUrl: '',
      brandingCompanyDetails: '',
      brandingColors: null,
      brandingCss: '',
    },
  },
  teamGlobalSettings: {
    includeSigningCertificate: null,
    includeAuditLog: null,
    brandingEnabled: false,
    brandingLogo: null,
    brandingUrl: null,
    brandingCompanyDetails: null,
    brandingColors: null,
    brandingCss: null,
  },
});

const signatureField = (id: number, inserted: boolean) => ({
  id,
  envelopeId: 'envelope_abc123',
  envelopeItemId: 'envelope_item_1',
  recipientId: 2,
  type: 'SIGNATURE',
  page: 1,
  positionX: '10',
  positionY: '10',
  width: '40',
  height: '10',
  customText: '',
  inserted,
  fieldMeta: null,
  signature: inserted ? { id, typedSignature: 'A. Counterparty', signatureImageAsBase64: null } : null,
});

/** A rejected envelope: one signer signed, the next one refused. */
const rejectedEnvelope = () => {
  const fields = [signatureField(101, true), signatureField(102, false)];

  return {
    id: 'envelope_abc123',
    secondaryId: 'envelope_document_7',
    title: 'Master Services Agreement',
    status: 'PENDING',
    signatureLevel: 'SES',
    internalVersion: 2,
    useLegacyFieldInsertion: false,
    qrToken: 'qr_existing',
    userId: 9,
    teamId: 1,
    user: { name: 'Author', email: 'author@example.com' },
    documentMeta: { language: 'en' },
    recipients: [
      { id: 1, role: 'SIGNER', signingStatus: 'SIGNED', rejectionReason: null },
      { id: 2, role: 'SIGNER', signingStatus: 'REJECTED', rejectionReason: 'Terms are wrong' },
    ],
    fields,
    envelopeItems: [
      {
        id: 'envelope_item_1',
        title: 'Agreement.pdf',
        documentData: { id: 'document_data_1', data: 'data', initialData: 'initial' },
        field: fields,
      },
    ],
  };
};

let currentEnvelope = rejectedEnvelope();

const createIo = (): JobRunIO => {
  const completed = new Set<string>();

  return {
    runTask: async (cacheKey, callback) => {
      if (completed.has(cacheKey)) {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        return undefined as never;
      }

      const result = await callback();

      completed.add(cacheKey);

      return result;
    },
    triggerJob: async () => undefined,
    logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn(), warn: vi.fn() },
    wait: async () => {},
  };
};

/** The fields the renderer was handed, flattened across every page it drew. */
const fieldsDrawn = () =>
  insertFieldInPDFV2.mock.calls.flatMap((call) => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const options = call[0] as { fields: Array<{ id: number; type: string; inserted: boolean }> };

    return options.fields;
  });

describe('seal-document', () => {
  beforeEach(() => {
    insertFieldInPDFV2.mockReset();
    signPdf.mockReset();
    putPdfFileServerSide.mockReset();
    teamFindFirst.mockReset();
    triggerTeamWebhook.mockReset();
    triggerTeamWebhook.mockResolvedValue(undefined);
    envelopeUpdates.length = 0;

    currentEnvelope = rejectedEnvelope();

    signPdf.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    teamFindFirst.mockResolvedValue(teamRow());
  });

  it('seals a rejected envelope', async () => {
    await run({ payload: { documentId: 7 }, io: createIo() });

    expect(envelopeUpdates.some((update) => update.status === 'REJECTED')).toBe(true);
  });

  it('never hands the renderer a field nobody filled in, so nothing prints the word SIGNATURE', async () => {
    await run({ payload: { documentId: 7 }, io: createIo() });

    const drawn = fieldsDrawn();

    expect(drawn.map((field) => field.id)).toEqual([101]);
    expect(drawn.every((field) => field.inserted)).toBe(true);
  });

  it('does not seal an envelope twice when a retry finds it already sealed', async () => {
    // The worker died after the seal committed and before the job recorded it,
    // so the retry starts from the top against an envelope that is finished.
    currentEnvelope = { ...rejectedEnvelope(), status: 'REJECTED' };

    await run({ payload: { documentId: 7 }, io: createIo() });

    expect(signPdf).not.toHaveBeenCalled();
    expect(putPdfFileServerSide).not.toHaveBeenCalled();
    expect(envelopeUpdates).toEqual([]);
  });

  it('still tells the team when a retry finds the envelope already sealed', async () => {
    // The fan-out may be exactly what the dead worker never reached.
    currentEnvelope = { ...rejectedEnvelope(), status: 'REJECTED' };

    await run({ payload: { documentId: 7 }, io: createIo() });

    expect(triggerTeamWebhook).toHaveBeenCalledTimes(1);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const options = triggerTeamWebhook.mock.calls[0][0] as Record<string, unknown>;

    expect(options.event).toBe('DOCUMENT_REJECTED');
  });

  it('reseals a finished envelope when asked to', async () => {
    currentEnvelope = { ...rejectedEnvelope(), status: 'REJECTED' };

    await run({ payload: { documentId: 7, isResealing: true }, io: createIo() });

    expect(signPdf).toHaveBeenCalled();
    expect(envelopeUpdates.some((update) => update.status === 'REJECTED')).toBe(true);
  });

  it('refuses an envelope that is not SES rather than sealing it with the instance certificate', async () => {
    // Remote signing through a trust service provider has gone. Sealing an AES
    // or QES envelope here would quietly re-sign it at the simple level.
    currentEnvelope = { ...rejectedEnvelope(), signatureLevel: 'QES' };

    const io = createIo();

    await expect(run({ payload: { documentId: 7 }, io })).rejects.toMatchObject({
      code: 'CSC_INSTANCE_MODE_MISMATCH',
    });

    expect(signPdf).not.toHaveBeenCalled();
    expect(insertFieldInPDFV2).not.toHaveBeenCalled();
    expect(putPdfFileServerSide).not.toHaveBeenCalled();
    expect(envelopeUpdates).toEqual([]);
    expect(triggerTeamWebhook).not.toHaveBeenCalled();
    expect(io.logger.error).toHaveBeenCalledWith(expect.stringContaining('envelope_abc123'));
  });

  it('seals when the author has lost team access', async () => {
    // The author's membership came through an Entra group that has since been
    // revoked, so any query scoped through their membership finds no team. A
    // query by team alone still does.
    teamFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.teamGroups ? null : teamRow(),
    );

    await run({ payload: { documentId: 7 }, io: createIo() });

    expect(envelopeUpdates.some((update) => update.status === 'REJECTED')).toBe(true);
    expect(teamFindFirst).toHaveBeenCalled();
  });

  it('asks for the team settings by team, not through the author', async () => {
    await run({ payload: { documentId: 7 }, io: createIo() });

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const { where } = teamFindFirst.mock.calls[0][0] as { where: Record<string, unknown> };

    expect(where.id).toBe(1);
    expect(where.teamGroups).toBeUndefined();
  });

  it('tells the team by team, so an author who has left cannot silence the completion', async () => {
    // The settings fix alone left this half done. The webhook still resolved
    // through the author's membership, which for a leaver matches nothing, and
    // an empty match returns quietly. The team sealed a contract and its
    // integration was never told.
    await run({ payload: { documentId: 7 }, io: createIo() });

    expect(triggerTeamWebhook).toHaveBeenCalledTimes(1);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const options = triggerTeamWebhook.mock.calls[0][0] as Record<string, unknown>;

    expect(options.teamId).toBe(1);
    expect(options.event).toBe('DOCUMENT_REJECTED');
    expect(options).not.toHaveProperty('userId');
  });
});
