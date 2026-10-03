import type { Logger } from 'pino';

import { logger as defaultLogger } from '../../utils/logger';

export type WarnIgnoredEmailIdOptions = {
  emailId: string | null | undefined;
  teamId?: number;
  organisationId?: string;
  logger?: Pick<Logger, 'warn'>;
};

/**
 * Sender addresses (organisation email domains) were removed. Request schemas still accept
 * `emailId` for one release, but the value is never stored or used. A caller that still names a
 * sender is logged at warn level so any real use shows up before the field is dropped.
 *
 * `null` and `undefined` mean "default sender" and are not logged.
 *
 * @returns true when a sender was named and ignored.
 */
export const warnIgnoredEmailId = ({
  emailId,
  teamId,
  organisationId,
  logger = defaultLogger,
}: WarnIgnoredEmailIdOptions): boolean => {
  if (typeof emailId !== 'string') {
    return false;
  }

  logger.warn({
    msg: 'Ignoring emailId: organisation sender addresses are no longer supported',
    emailId,
    teamId,
    organisationId,
  });

  return true;
};
