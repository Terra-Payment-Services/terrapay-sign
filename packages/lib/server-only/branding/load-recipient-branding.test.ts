import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getTeamSettings: vi.fn() }));

vi.mock('../team/get-team-settings', () => ({ getTeamSettings: mocks.getTeamSettings }));

import { loadRecipientBrandingByTeamId } from './load-recipient-branding';

describe('loadRecipientBrandingByTeamId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Billing used to gate both of these on plan claim flags. With billing gone
  // they must keep the behaviour billing-off always had.
  it('applies team branding and hides "Powered by" whatever the claim flags say', async () => {
    mocks.getTeamSettings.mockResolvedValue({
      brandingEnabled: true,
      brandingColors: { primary: '#123456' },
      brandingCss: '.a { color: red; }',
    });

    const payload = await loadRecipientBrandingByTeamId({ teamId: 1 });

    expect(payload.allowCustomBranding).toBe(true);
    expect(payload.hidePoweredBy).toBe(true);
    expect(payload.css).toBe('.a { color: red; }');
  });

  it('still hides "Powered by" when the team has branding switched off', async () => {
    mocks.getTeamSettings.mockResolvedValue({ brandingEnabled: false, brandingColors: null, brandingCss: null });

    await expect(loadRecipientBrandingByTeamId({ teamId: 1 })).resolves.toEqual({
      allowCustomBranding: false,
      hidePoweredBy: true,
      colors: null,
      css: null,
    });
  });
});
