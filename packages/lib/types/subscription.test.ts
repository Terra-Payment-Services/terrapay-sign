import { describe, expect, it } from 'vitest';

import { ADMIN_CLAIM_FEATURE_FLAGS, SUBSCRIPTION_CLAIM_FEATURE_FLAGS, ZClaimFlagsSchema } from './subscription';

describe('admin claim feature flags', () => {
  const offered = ADMIN_CLAIM_FEATURE_FLAGS.map(({ key }) => key);

  it.each([
    'hipaa',
    'authenticationPortal',
    'emailDomains',
    'cscQesSigning',
    'embedAuthoring',
    'embedAuthoringWhiteLabel',
  ] as const)('does not offer %s, which nothing reads', (key) => {
    expect(offered).not.toContain(key);

    // Still known, so claims already stored with it keep parsing.
    expect(SUBSCRIPTION_CLAIM_FEATURE_FLAGS[key].key).toBe(key);
    expect(ZClaimFlagsSchema.parse({ [key]: true })).toEqual({ [key]: true });
  });

  it('still offers the flags that are used, cfr21 among them', () => {
    expect(offered).toEqual(expect.arrayContaining(['cfr21', 'allowCustomBranding', 'embedSigning', 'disableEmails']));
  });
});
