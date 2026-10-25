import { getSafeBrandingUrl } from '@documenso/email/utils/branding-url';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

/**
 * #155: the Brand Website must be an absolute http(s) URL. The organisation and team settings
 * mutations refuse anything else, and a refused request writes nothing. The branding form
 * refuses it before it sends a request.
 */
const baseUrl = NEXT_PUBLIC_WEBAPP_URL();

const REFUSED_URLS: Array<[string, string]> = [
  ['javascript lowercase', 'javascript:alert(1)'],
  ['javascript mixed case', 'JavaScript:alert(1)'],
  ['javascript leading space', ' javascript:alert(1)'],
  ['javascript tab inside the scheme', 'java\tscript:alert(1)'],
  ['javascript html entity colon', 'javascript&colon;alert(1)'],
  ['data url', 'data:text/html,<script>alert(1)</script>'],
  ['vbscript', 'vbscript:msgbox(1)'],
  ['file', 'file:///etc/passwd'],
  ['ftp', 'ftp://example.com'],
  ['protocol relative', '//evil.example'],
  ['relative path', '/relative/path'],
  ['no scheme', 'example.com'],
  ['single slash', 'http:/example.com'],
  ['no host', 'https://'],
  ['percent encoded scheme', '%6A%61%76%61script:alert(1)'],
  ['userinfo before the host', 'https://trusted.com@evil.com'],
  ['tab inside the host', 'https://example.com\t.evil.com'],
];

const ACCEPTED_URLS: Array<[string, string]> = [
  ['https', 'https://example.com'],
  ['http with path, query and fragment', 'http://example.com/path?q=1#frag'],
  ['uppercase scheme and host', 'HTTPS://EXAMPLE.COM'],
  ['punycode host', 'https://xn--bcher-kva.example/'],
];

/**
 * `/api/trpc` is limited to 100 requests a minute per IP, and a 429 would read as a refusal.
 * Wait out the window and retry so that only the validator's own answer is ever asserted.
 */
const callTrpc = async (page: Page, procedure: string, json: unknown) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await page.context().request.post(`${baseUrl}/api/trpc/${procedure}`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({ json }),
    });

    if (response.status() !== 429) {
      return response;
    }

    await page.waitForTimeout(10_000);
  }

  throw new Error(`${procedure} stayed rate limited`);
};

const BRANDING_URL_MESSAGE = 'Enter a web address that starts with http:// or https://';

/**
 * A refused request is a tRPC 400 whose message carries the zod issues, so the failing path
 * (`data.brandingUrl`) and the validator's message must both be in the body.
 */
const expectBrandingUrlRefused = async (response: Awaited<ReturnType<typeof callTrpc>>) => {
  expect(response.status()).toBe(400);

  const body = await response.text();

  expect(body).toContain('brandingUrl');
  expect(body).toContain(BRANDING_URL_MESSAGE);
};

const seedOwner = async (page: Page) => {
  const { user, organisation, team } = await seedUser({ isPersonalOrganisation: false });

  await apiSignin({ page, email: user.email });

  return { organisation, team };
};

const readOrganisationSettings = async (organisationGlobalSettingsId: string) => {
  return await prisma.organisationGlobalSettings.findUniqueOrThrow({ where: { id: organisationGlobalSettingsId } });
};

const readTeamSettings = async (teamGlobalSettingsId: string) => {
  return await prisma.teamGlobalSettings.findUniqueOrThrow({ where: { id: teamGlobalSettingsId } });
};

const updateOrganisation = async (page: Page, organisationId: string, data: Record<string, unknown>) => {
  return await callTrpc(page, 'organisation.settings.update', { organisationId, data });
};

const updateTeam = async (page: Page, teamId: number, data: Record<string, unknown>) => {
  return await callTrpc(page, 'team.settings.update', { teamId, data });
};

test.describe('[BRAND_URL] C1: the server refuses a Brand Website that is not http or https', () => {
  for (const [label, brandingUrl] of REFUSED_URLS) {
    test(`organisation.settings.update refuses ${label}`, async ({ page }) => {
      const { organisation } = await seedOwner(page);
      const before = await readOrganisationSettings(organisation.organisationGlobalSettingsId);

      const response = await updateOrganisation(page, organisation.id, {
        brandingEnabled: true,
        brandingCompanyDetails: 'SHOULD NOT BE STORED',
        brandingUrl,
      });

      await expectBrandingUrlRefused(response);

      const after = await readOrganisationSettings(organisation.organisationGlobalSettingsId);

      expect(after).toEqual(before);
    });

    test(`team.settings.update refuses ${label}`, async ({ page }) => {
      const { team } = await seedOwner(page);
      const before = await readTeamSettings(team.teamGlobalSettingsId);

      const response = await updateTeam(page, team.id, {
        brandingEnabled: true,
        brandingCompanyDetails: 'SHOULD NOT BE STORED',
        brandingUrl,
      });

      await expectBrandingUrlRefused(response);

      const after = await readTeamSettings(team.teamGlobalSettingsId);

      expect(after).toEqual(before);
    });
  }
});

test.describe('[BRAND_URL] C2: the server accepts http and https and the empty value', () => {
  for (const [label, brandingUrl] of ACCEPTED_URLS) {
    test(`organisation.settings.update accepts ${label}`, async ({ page }) => {
      const { organisation } = await seedOwner(page);

      const response = await updateOrganisation(page, organisation.id, { brandingEnabled: true, brandingUrl });

      expect(response.ok(), await response.text()).toBe(true);

      const after = await readOrganisationSettings(organisation.organisationGlobalSettingsId);

      expect(getSafeBrandingUrl(after.brandingUrl)).not.toBeNull();
    });

    test(`team.settings.update accepts ${label}`, async ({ page }) => {
      const { team } = await seedOwner(page);

      const response = await updateTeam(page, team.id, { brandingEnabled: true, brandingUrl });

      expect(response.ok(), await response.text()).toBe(true);

      const after = await readTeamSettings(team.teamGlobalSettingsId);

      expect(getSafeBrandingUrl(after.brandingUrl)).not.toBeNull();
    });
  }

  test('organisation.settings.update clears the URL with an empty string', async ({ page }) => {
    const { organisation } = await seedOwner(page);

    const set = await updateOrganisation(page, organisation.id, { brandingUrl: 'https://example.com' });

    expect(set.ok()).toBe(true);

    const cleared = await updateOrganisation(page, organisation.id, { brandingUrl: '' });

    expect(cleared.ok()).toBe(true);

    const after = await readOrganisationSettings(organisation.organisationGlobalSettingsId);

    expect(after.brandingUrl).toBe('');
  });

  test('team.settings.update clears the URL with null', async ({ page }) => {
    const { team } = await seedOwner(page);

    const set = await updateTeam(page, team.id, { brandingUrl: 'https://example.com' });

    expect(set.ok()).toBe(true);

    const cleared = await updateTeam(page, team.id, { brandingUrl: null });

    expect(cleared.ok()).toBe(true);

    const after = await readTeamSettings(team.teamGlobalSettingsId);

    expect(after.brandingUrl).toBeNull();
  });
});

test.describe('[BRAND_URL] C3: the branding form refuses a Brand Website that is not http or https', () => {
  const fillAndSave = async (page: Page, brandingUrl: string) => {
    await page.getByTestId('enable-branding').click();
    await page.getByRole('option', { name: 'Yes' }).click();
    await page.getByRole('textbox', { name: 'Brand Website' }).fill(brandingUrl);
    await page.getByRole('button', { name: 'Save changes' }).first().click();
  };

  for (const brandingUrl of ['javascript:alert(1)', 'data:text/html,x']) {
    test(`shows a validation message and sends no update for ${brandingUrl}`, async ({ page }) => {
      const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

      await apiSignin({ page, email: user.email, redirectPath: `/o/${organisation.url}/settings/branding` });

      const updateRequests: string[] = [];

      page.on('request', (request) => {
        if (request.url().includes('organisation.settings.update')) {
          updateRequests.push(request.url());
        }
      });

      await fillAndSave(page, brandingUrl);

      // Scope the message to the Brand Website field: its input names the message element in aria-describedby.
      const brandWebsite = page.getByRole('textbox', { name: 'Brand Website' });

      await expect(brandWebsite).toHaveAttribute('aria-invalid', 'true');

      const describedBy = (await brandWebsite.getAttribute('aria-describedby')) ?? '';
      const messageId = describedBy.split(' ').find((id) => id.endsWith('-form-item-message'));

      expect(messageId).toBeTruthy();
      await expect(page.locator(`[id="${messageId}"]`)).toHaveText(BRANDING_URL_MESSAGE);
      await expect(page.getByText('Your branding preferences have been updated')).toHaveCount(0);

      // Give a stray request time to leave the browser before asserting that none did.
      await page.waitForTimeout(1500);

      expect(updateRequests).toEqual([]);

      const after = await readOrganisationSettings(organisation.organisationGlobalSettingsId);

      expect(after.brandingUrl).toBe('');
    });
  }

  test('still saves https://example.com', async ({ page }) => {
    const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

    await apiSignin({ page, email: user.email, redirectPath: `/o/${organisation.url}/settings/branding` });

    await fillAndSave(page, 'https://example.com');

    await expect(page.getByText('Your branding preferences have been updated').first()).toBeVisible();

    const after = await readOrganisationSettings(organisation.organisationGlobalSettingsId);

    expect(after.brandingUrl).toBe('https://example.com');
  });

  test('clears a saved URL through the organisation form', async ({ page }) => {
    const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

    await apiSignin({ page, email: user.email, redirectPath: `/o/${organisation.url}/settings/branding` });

    await fillAndSave(page, 'https://example.com');

    await expect(page.getByText('Your branding preferences have been updated').first()).toBeVisible();

    const saved = await readOrganisationSettings(organisation.organisationGlobalSettingsId);

    expect(saved.brandingUrl).toBe('https://example.com');

    await page.reload();
    await page.getByRole('textbox', { name: 'Brand Website' }).fill('');
    await page.getByRole('button', { name: 'Save changes' }).first().click();

    await expect(page.getByText('Your branding preferences have been updated').first()).toBeVisible();

    const after = await readOrganisationSettings(organisation.organisationGlobalSettingsId);

    expect(after.brandingUrl).toBe('');
  });

  test('clears a saved URL through the team form', async ({ page }) => {
    const { user, team } = await seedUser({ isPersonalOrganisation: false });

    await apiSignin({ page, email: user.email });

    const set = await updateTeam(page, team.id, { brandingEnabled: true, brandingUrl: 'https://example.com' });

    expect(set.ok()).toBe(true);

    await page.goto(`${baseUrl}/t/${team.url}/settings/branding`);

    const brandWebsite = page.getByRole('textbox', { name: 'Brand Website' });

    await expect(brandWebsite).toHaveValue('https://example.com');
    await brandWebsite.fill('');
    await page.getByRole('button', { name: 'Save changes' }).first().click();

    await expect(page.getByText('Your branding preferences have been updated').first()).toBeVisible();

    const after = await readTeamSettings(team.teamGlobalSettingsId);

    expect(after.brandingUrl).toBeNull();
  });
});

test.describe('[BRAND_URL] C6: saves that leave the Brand Website alone still succeed', () => {
  test('organisation save without brandingUrl', async ({ page }) => {
    const { organisation } = await seedOwner(page);

    const response = await updateOrganisation(page, organisation.id, { documentLanguage: 'de' });

    expect(response.ok(), await response.text()).toBe(true);
  });

  test('organisation save of other branding fields only', async ({ page }) => {
    const { organisation } = await seedOwner(page);

    const response = await updateOrganisation(page, organisation.id, {
      brandingEnabled: true,
      brandingCompanyDetails: 'Details only',
    });

    expect(response.ok(), await response.text()).toBe(true);

    const after = await readOrganisationSettings(organisation.organisationGlobalSettingsId);

    expect(after.brandingCompanyDetails).toBe('Details only');
    expect(after.brandingUrl).toBe('');
  });

  test('team save without brandingUrl', async ({ page }) => {
    const { team } = await seedOwner(page);

    const response = await updateTeam(page, team.id, { documentLanguage: 'de' });

    expect(response.ok(), await response.text()).toBe(true);
  });

  test('team save of other branding fields only', async ({ page }) => {
    const { team } = await seedOwner(page);

    const response = await updateTeam(page, team.id, {
      brandingEnabled: true,
      brandingCompanyDetails: 'Details only',
    });

    expect(response.ok(), await response.text()).toBe(true);

    const after = await readTeamSettings(team.teamGlobalSettingsId);

    expect(after.brandingCompanyDetails).toBe('Details only');
    expect(after.brandingUrl).toBeNull();
  });
});
