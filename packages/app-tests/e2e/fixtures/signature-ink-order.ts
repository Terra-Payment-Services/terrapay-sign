/**
 * Helpers for the G4 sequential order gate specs (#145), on top of
 * fixtures/signature-ink.ts. Every call goes through the recipient-token route
 * the signing pages use (V1 `field.*`, V2 `envelope.field.sign`,
 * `recipient.*WithToken`) or the owner's API v2 token; state is read from the
 * database and Inbucket.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect } from '@playwright/test';
import { type DocumentStatus, FieldType } from '@prisma/client';

import type { Reply } from './reject-seal';
import {
  completeWithToken,
  expect2xx,
  type G4Seeded,
  readInbox,
  signSignature,
  signV1,
  signV2,
  unsignV1,
  v2Api,
} from './signature-ink';

export const OUT_OF_TURN_TEXT = 'OUT OF TURN';

/** How long to let a completion's emails and jobs land before the next "nothing happens" check. */
export const SETTLE_MS = 5_000;

export const settle = async (ms = SETTLE_MS) => await new Promise((resolve) => setTimeout(resolve, ms));

/** Signs `recipientKey`'s TEXT field `fieldKey` (default `text`) with the token of `actorKey` (default the owner). */
export const signText = async (
  request: APIRequestContext,
  seeded: G4Seeded,
  actorKey: string,
  ownerKey: string,
  value = OUT_OF_TURN_TEXT,
  fieldKey = 'text',
  retry = true,
) => {
  const token = seeded.r[actorKey].token;
  const fieldId = seeded.r[ownerKey].fields[fieldKey].id;

  return seeded.internalVersion === 1
    ? await signV1(request, token, fieldId, value, false, retry)
    : await signV2(request, token, fieldId, { type: FieldType.TEXT, value }, retry);
};

/** Signs `ownerKey`'s SIGNATURE field (`sig`) with a typed name, using `actorKey`'s token. */
export const signSig = async (
  request: APIRequestContext,
  seeded: G4Seeded,
  actorKey: string,
  ownerKey: string,
  value: string,
  retry = true,
) =>
  await signSignature(request, seeded, seeded.r[actorKey].token, seeded.r[ownerKey].fields.sig.id, value, {
    isBase64: false,
    retry,
  });

/** Clears a field through the version's uninsert route (V1 removeSignedFieldWithToken, V2 value null). */
export const unsign = async (
  request: APIRequestContext,
  seeded: G4Seeded,
  key: string,
  fieldKey: string,
  retry = true,
): Promise<Reply> => {
  const recipient = seeded.r[key];
  const field = recipient.fields[fieldKey];

  return seeded.internalVersion === 1
    ? await unsignV1(request, recipient.token, field.id, retry)
    : await signV2(request, recipient.token, field.id, { type: field.type, value: null }, retry);
};

/** "Xn completes": signs the SIGNATURE field with a typed name and completes, both 200; X ends SIGNED. */
export const signAndComplete = async (
  request: APIRequestContext,
  seeded: G4Seeded,
  key: string,
  options: { nextSigner?: { email: string; name: string }; typed?: string } = {},
) => {
  const typed = options.typed ?? `S ${key}`;

  expect2xx(await signSig(request, seeded, key, key, typed), `${key} signs its SIGNATURE field`);
  expect2xx(
    await completeWithToken(request, seeded, seeded.r[key].token, { nextSigner: options.nextSigner }),
    `${key} completes`,
  );
  expect((await recipientOf(seeded, key)).signingStatus, `${key} is SIGNED after completing`).toBe('SIGNED');
};

export const recipientOf = async (seeded: G4Seeded, key: string) =>
  await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.r[key].id } });

export const envelopeStatus = async (seeded: G4Seeded) =>
  (await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } })).status;

export const waitForEnvelopeStatus = async (seeded: G4Seeded, status: DocumentStatus, timeout = 90_000) => {
  await expect
    .poll(async () => await envelopeStatus(seeded), {
      message: `envelope ${seeded.envelopeId} should reach ${status}`,
      timeout,
    })
    .toBe(status);
};

/** Sends a DRAFT envelope through API v2 (`envelope.distribute`), as the owner. */
export const distribute = async (request: APIRequestContext, seeded: G4Seeded) =>
  await v2Api(request, seeded.owner.apiToken, '/envelope/distribute', { envelopeId: seeded.envelopeId });

/** EMAIL_SENT audit rows of type SIGNING_REQUEST for one recipient. */
export const signingEmailRows = async (seeded: G4Seeded, key: string) =>
  (await prisma.documentAuditLog.findMany({ where: { envelopeId: seeded.envelopeId, type: 'EMAIL_SENT' } })).filter(
    (row) => {
      const data = (row.data ?? {}) as Record<string, unknown>;

      return data.emailType === 'SIGNING_REQUEST' && data.recipientId === seeded.r[key].id;
    },
  );

export const inboxCount = async (request: APIRequestContext, seeded: G4Seeded, key: string) =>
  (await readInbox(request, seeded.r[key].mailbox)).length;

/** Every recipient's Inbucket count, after the settle window. */
export const settledInboxCounts = async (request: APIRequestContext, seeded: G4Seeded, keys: string[]) => {
  await settle();

  const counts: Record<string, number> = {};

  for (const key of keys) {
    counts[key] = await inboxCount(request, seeded, key);
  }

  return counts;
};

export const auditCount = async (seeded: G4Seeded, types: string[]) =>
  await prisma.documentAuditLog.count({ where: { envelopeId: seeded.envelopeId, type: { in: types } } });
