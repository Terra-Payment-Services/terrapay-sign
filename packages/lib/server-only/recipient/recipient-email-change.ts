import { ReadStatus } from '@prisma/client';

import { nanoid } from '../../universal/id';

/**
 * The fields to write alongside a recipient's new email. A different person gets a new signing token, so the link
 * sent to the previous address stops working, and starts unopened; the same address in another case keeps both
 * (#150).
 */
export const getRecipientEmailChangeData = (previousEmail: string, nextEmail: string | undefined) => {
  if (nextEmail === undefined || previousEmail.toLowerCase() === nextEmail.toLowerCase()) {
    return {};
  }

  return {
    token: nanoid(),
    readStatus: ReadStatus.NOT_OPENED,
  };
};
