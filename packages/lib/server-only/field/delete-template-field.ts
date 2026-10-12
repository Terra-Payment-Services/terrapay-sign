import { prisma } from '@documenso/prisma';
import { EnvelopeType, FieldType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { buildTeamWhereQuery } from '../../utils/teams';
import { lockFieldsSparingSeals, refuseCompanySeal } from '../company-seal/company-seal-field';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';

export interface DeleteTemplateFieldOptions {
  userId: number;
  teamId: number;
  fieldId: number;
}

export const deleteTemplateField = async ({ userId, teamId, fieldId }: DeleteTemplateFieldOptions): Promise<void> => {
  const field = await prisma.field.findFirst({
    where: {
      id: fieldId,
      envelope: {
        type: EnvelopeType.TEMPLATE,
        team: buildTeamWhereQuery({ teamId, userId }),
      },
    },
  });

  if (!field) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Field not found',
    });
  }

  // Additional validation to check visibility.
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: {
      type: 'envelopeId',
      id: field.envelopeId,
    },
    type: EnvelopeType.TEMPLATE,
    userId,
    teamId,
  });

  await prisma.$transaction(async (tx) => {
    // A hidden template answers NOT_FOUND whatever the field is, so a seal id
    // tells the caller nothing. Only the V1 routes delete through here, and
    // they cannot delete a company seal.
    if ((await tx.envelope.count({ where: envelopeWhereInput })) === 0) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Field not found',
      });
    }

    if (field.type === FieldType.COMPANY_SEAL) {
      throw refuseCompanySeal();
    }

    await lockFieldsSparingSeals(tx, [field]);

    await tx.field.delete({
      where: {
        id: field.id,
        envelope: envelopeWhereInput,
      },
    });
  });
};
