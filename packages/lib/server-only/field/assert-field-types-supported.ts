import { FieldType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';

/**
 * Refuses field types the envelope's version cannot sign. A V2 envelope has no way to render or sign a
 * FREE_SIGNATURE field, so one placed there could never be completed (#242).
 */
export const assertFieldTypesSupported = (internalVersion: number, types: FieldType[]) => {
  if (internalVersion !== 1 && types.includes(FieldType.FREE_SIGNATURE)) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'FREE_SIGNATURE fields are not supported on version 2 envelopes',
    });
  }
};
