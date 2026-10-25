/**
 * Nothing the ui project leaves behind is work for the seal sweep (#177, S1).
 *
 * The sweep (packages/lib/jobs/definitions/internal/seal-document-sweep.handler.ts)
 * reseals a PENDING DOCUMENT envelope, not deleted and with at least one
 * recipient, when some recipient is REJECTED or every recipient is SIGNED or
 * CC, no recipient has signedAt within the last 15 minutes, and some recipient
 * has signedAt within the last 6 hours. Each one it picks up sends rejection or
 * cancellation mail mid-run. This check applies the same predicate without the
 * 15-minute rule, so it counts what the sweep would mail once that quarter of
 * an hour has passed.
 *
 * It runs in its own project after api, ui and remote; see playwright.config.ts.
 */
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';
import { DocumentStatus, EnvelopeType, RecipientRole, SigningStatus } from '@prisma/client';
import { DateTime } from 'luxon';

test('the ui project leaves no envelope for the seal sweep', async () => {
  const sixHoursAgo = DateTime.now().minus({ hours: 6 }).toJSDate();

  const offenders = await prisma.envelope.findMany({
    where: {
      status: DocumentStatus.PENDING,
      type: EnvelopeType.DOCUMENT,
      deletedAt: null,
      AND: [
        { recipients: { some: {} } },
        {
          OR: [
            {
              recipients: {
                none: { signingStatus: { not: SigningStatus.SIGNED }, role: { not: RecipientRole.CC } },
              },
            },
            { recipients: { some: { signingStatus: SigningStatus.REJECTED } } },
          ],
        },
        { recipients: { some: { signedAt: { gt: sixHoursAgo } } } },
      ],
    },
    select: { id: true, secondaryId: true, title: true },
    orderBy: { createdAt: 'asc' },
  });

  const listed = offenders.map(
    (envelope) => `${mapSecondaryIdToDocumentId(envelope.secondaryId)} ${envelope.id} ${envelope.title}`,
  );

  expect(listed, `${offenders.length} envelope(s) the seal sweep would pick up`).toEqual([]);
});
