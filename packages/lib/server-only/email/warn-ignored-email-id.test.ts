import { describe, expect, it, vi } from 'vitest';

import { warnIgnoredEmailId } from './warn-ignored-email-id';

const createLogger = () => ({ warn: vi.fn() });

describe('warnIgnoredEmailId', () => {
  it('warns once with the caller team when a sender is named', () => {
    const logger = createLogger();

    const ignored = warnIgnoredEmailId({ emailId: 'email_123', teamId: 7, logger });

    expect(ignored).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ emailId: 'email_123', teamId: 7 }));
  });

  it('warns with the organisation when the caller is an organisation', () => {
    const logger = createLogger();

    warnIgnoredEmailId({ emailId: 'email_123', organisationId: 'org_1', logger });

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ organisationId: 'org_1' }));
  });

  it.each([null, undefined])('stays silent for the default sender (%s)', (emailId) => {
    const logger = createLogger();

    expect(warnIgnoredEmailId({ emailId, teamId: 7, logger })).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
