import { prisma } from '@documenso/prisma';
import type { CompanySeal, Envelope, Field, Prisma, Recipient } from '@prisma/client';
import { FieldType, RecipientRole } from '@prisma/client';
import { base64 } from '@scure/base';

import { AppError, AppErrorCode } from '../../errors/app-error';
import {
  COMPANY_SEAL_V2_ONLY_MESSAGE,
  type TCompanySealFieldMeta,
  ZCompanySealFieldMeta,
} from '../../types/field-meta';
import { getFileServerSide } from '../../universal/upload/get-file.server';

export const formatCompanySealLabel = (seal: Pick<CompanySeal, 'name' | 'legalEntityName'>) =>
  `${seal.name} (${seal.legalEntityName})`;

const normaliseEmail = (email: string) => email.trim().toLowerCase();

/** The seal, if it belongs to the organisation that owns the team. */
const findSealForTeam = async (sealId: string, teamId: number) =>
  await prisma.companySeal.findFirst({
    where: {
      id: sealId,
      organisation: { teams: { some: { id: teamId } } },
    },
  });

export type ResolveCompanySealFieldMetaOptions = {
  envelope: Pick<Envelope, 'internalVersion' | 'teamId'>;
  recipient: Pick<Recipient, 'role'>;
  fieldMeta: unknown;
};

/**
 * Validate a COMPANY_SEAL field about to be written and return its meta with
 * `sealLabel` taken from the seal, never from the client.
 *
 * Every field writer calls this, so the rules live in one place: V2 envelopes
 * only, a SIGNER recipient, and a seal of the envelope's organisation.
 */
export const resolveCompanySealFieldMeta = async ({
  envelope,
  recipient,
  fieldMeta,
}: ResolveCompanySealFieldMetaOptions): Promise<TCompanySealFieldMeta> => {
  if (envelope.internalVersion !== 2) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: COMPANY_SEAL_V2_ONLY_MESSAGE });
  }

  if (recipient.role !== RecipientRole.SIGNER) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'A company seal field can only be given to a signer',
    });
  }

  const parsed = ZCompanySealFieldMeta.safeParse(fieldMeta);

  if (!parsed.success) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'A company seal field needs a sealId' });
  }

  const seal = await findSealForTeam(parsed.data.sealId, envelope.teamId);

  if (!seal) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'The company seal does not belong to this organisation',
    });
  }

  return { ...parsed.data, sealLabel: formatCompanySealLabel(seal) };
};

export type AssertCompanySealApplicableOptions = {
  envelope: Pick<Envelope, 'internalVersion' | 'teamId'>;
  field: Pick<Field, 'type' | 'recipientId' | 'fieldMeta'>;
  /** The recipient whose token made the request. */
  recipient: Pick<Recipient, 'id' | 'role' | 'email'>;
  /** The Sign session's user, if the request carried one. */
  user?: { id: number; email: string } | null;
};

/**
 * Throws unless the request may apply (or remove) this seal: the field's own
 * SIGNER, signed in to Sign as the recipient's email, and a current member of
 * the seal's organisation. Returns the seal.
 */
export const assertCompanySealApplicable = async ({
  envelope,
  field,
  recipient,
  user,
}: AssertCompanySealApplicableOptions) => {
  if (field.type !== FieldType.COMPANY_SEAL) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'The field is not a company seal field' });
  }

  if (envelope.internalVersion !== 2) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: COMPANY_SEAL_V2_ONLY_MESSAGE });
  }

  if (recipient.id !== field.recipientId || recipient.role !== RecipientRole.SIGNER) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: "Only the field's own signer can apply a company seal",
    });
  }

  if (!user) {
    throw new AppError(AppErrorCode.COMPANY_SEAL_LOGIN_REQUIRED, {
      message: 'Sign in to your Sign account to apply this company seal',
      statusCode: 401,
    });
  }

  if (normaliseEmail(user.email) !== normaliseEmail(recipient.email)) {
    throw new AppError(AppErrorCode.COMPANY_SEAL_NOT_AUTHORISED, {
      message: 'You must be signed in as the recipient to apply this company seal',
      statusCode: 403,
    });
  }

  const parsed = ZCompanySealFieldMeta.safeParse(field.fieldMeta);
  const seal = parsed.success ? await findSealForTeam(parsed.data.sealId, envelope.teamId) : null;

  if (!seal) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'The company seal does not belong to this organisation',
    });
  }

  const membership = await prisma.organisationMember.findFirst({
    where: { organisationId: seal.organisationId, userId: user.id },
  });

  if (!membership) {
    throw new AppError(AppErrorCode.COMPANY_SEAL_NOT_AUTHORISED, {
      message: 'Only members of the organisation can apply its company seal',
      statusCode: 403,
    });
  }

  return seal;
};

type SealFieldShape = { type: FieldType; fieldMeta?: unknown };

/** The error the V1 field writers throw when a call would touch a company seal. */
export const refuseCompanySeal = () =>
  new AppError(AppErrorCode.COMPANY_SEAL_V2_ONLY, { message: COMPANY_SEAL_V2_ONLY_MESSAGE });

export const isCompanySealRefusal = (err: unknown) =>
  AppError.parseError(err).code === AppErrorCode.COMPANY_SEAL_V2_ONLY;

const sealIdOf = (field: SealFieldShape) => {
  if (field.type !== FieldType.COMPANY_SEAL) {
    return null;
  }

  const parsed = ZCompanySealFieldMeta.safeParse(field.fieldMeta);

  return parsed.success ? parsed.data.sealId : null;
};

const isSameSeal = (a: SealFieldShape, b: SealFieldShape) => a.type === b.type && sealIdOf(a) === sealIdOf(b);

/**
 * V1 set-fields may keep each stored seal, moved or resized, and do nothing
 * else with a seal. Every stored seal must be submitted exactly once as the
 * same seal; every submitted seal must be a stored one; ids are unique.
 */
export const assertLegacySetFieldsSparesSeals = (
  stored: (SealFieldShape & Pick<Field, 'id'>)[],
  submitted: { id?: number | null; type: FieldType; fieldMeta?: unknown }[],
) => {
  const ids = submitted.flatMap((field) => (typeof field.id === 'number' ? [field.id] : []));

  if (new Set(ids).size !== ids.length) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'A field is submitted more than once' });
  }

  for (const field of submitted) {
    const storedField = stored.find((s) => s.id === field.id);

    if (field.type === FieldType.COMPANY_SEAL && storedField?.type !== FieldType.COMPANY_SEAL) {
      throw refuseCompanySeal();
    }
  }

  for (const storedField of stored) {
    const field = submitted.find((s) => s.id === storedField.id);

    if (storedField.type === FieldType.COMPANY_SEAL && (!field || !isSameSeal(storedField, field))) {
      throw refuseCompanySeal();
    }
  }
};

/**
 * Called by the V1 field writers inside the transaction that writes. Locks the
 * rows the call will change or delete and refuses if any of them is gone, is a
 * seal now but was not when it was read, or was a seal and is no longer the
 * same one. A concurrent V2 write to those rows waits for the lock, so it
 * cannot land between this check and the write, and a row deleted before the
 * lock cannot be recreated by an upsert.
 */
export const lockFieldsSparingSeals = async (
  tx: Prisma.TransactionClient,
  read: (SealFieldShape & Pick<Field, 'id'>)[],
) => {
  if (read.length === 0) {
    return;
  }

  const rows = await tx.$queryRaw<(SealFieldShape & Pick<Field, 'id'>)[]>`
    SELECT "id", "type", "fieldMeta" FROM "Field" WHERE "id" = ANY(${read.map((field) => field.id)}) ORDER BY "id" FOR UPDATE
  `;

  if (rows.length !== new Set(read.map((field) => field.id)).size) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'A field was removed while the request was being processed. Send the request again.',
    });
  }

  for (const row of rows) {
    const readField = read.find((field) => field.id === row.id);
    const involvesSeal = row.type === FieldType.COMPANY_SEAL || readField?.type === FieldType.COMPANY_SEAL;

    if (readField && involvesSeal && !isSameSeal(row, readField)) {
      throw refuseCompanySeal();
    }
  }
};

/** The seal's stored PNG as bytes and as a `data:image/png;base64,` URL. */
export const getCompanySealImage = async (seal: Pick<CompanySeal, 'imageData'>) => {
  const bytes = new Uint8Array(await getFileServerSide(seal.imageData as { type: never; data: string }));

  return { bytes, dataUrl: `data:image/png;base64,${base64.encode(bytes)}` };
};

/**
 * At send: every COMPANY_SEAL field must point at a seal of the envelope's
 * organisation, and its recipient's email must belong to a member of that
 * organisation. Otherwise nobody could apply the seal.
 */
export const assertCompanySealRecipientsAreMembers = async ({
  envelope,
  fields,
  recipients,
}: {
  envelope: Pick<Envelope, 'internalVersion' | 'teamId'>;
  fields: Pick<Field, 'type' | 'recipientId' | 'fieldMeta'>[];
  recipients: Pick<Recipient, 'id' | 'email' | 'role'>[];
}) => {
  for (const field of fields) {
    if (field.type !== FieldType.COMPANY_SEAL) {
      continue;
    }

    const recipient = recipients.find((r) => r.id === field.recipientId);

    if (!recipient) {
      continue;
    }

    const { sealId } = await resolveCompanySealFieldMeta({ envelope, recipient, fieldMeta: field.fieldMeta });

    const seal = await prisma.companySeal.findFirstOrThrow({ where: { id: sealId } });

    const membership = await prisma.organisationMember.findFirst({
      where: {
        organisationId: seal.organisationId,
        // A disabled account keeps its membership row but cannot sign in, so it is not counted.
        user: { email: { equals: recipient.email.trim(), mode: 'insensitive' }, disabled: false },
      },
    });

    if (!membership) {
      throw new AppError(AppErrorCode.COMPANY_SEAL_RECIPIENT_NOT_AUTHORISED, {
        message: `${recipient.email} is not a member of the organisation, so cannot apply its company seal`,
        statusCode: 400,
      });
    }
  }
};

/** Every seal of an organisation, oldest first, each with its image as a data URL. */
export const listCompanySeals = async (organisationId: string) => {
  const seals = await prisma.companySeal.findMany({
    where: { organisationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  return await Promise.all(
    seals.map(async (seal) => ({
      id: seal.id,
      name: seal.name,
      legalEntityName: seal.legalEntityName,
      imageDataUrl: (await getCompanySealImage(seal)).dataUrl,
      createdAt: seal.createdAt,
      createdByName: seal.createdByName,
      createdByEmail: seal.createdByEmail,
    })),
  );
};
