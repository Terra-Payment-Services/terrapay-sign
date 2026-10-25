import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { hashString } from '@documenso/lib/server-only/auth/hash';
import { alphaid } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, TeamMemberRole } from '@documenso/prisma/client';
import { seedOrganisationMembers } from '@documenso/prisma/seed/organisations';
import { seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

const baseUrl = NEXT_PUBLIC_WEBAPP_URL();

const TEAM_LANGUAGE = 'de';
const TEAM_DATE_FORMAT = 'dd/MM/yyyy';
const ORG_TIMEZONE = 'Asia/Dubai';
const ORG_REPLY_TO = 'org-reply-c8@policy-c8.example.com';
const ORG_BRANDING_CSS = '.policy-c8-org-marker{color:#123456}';
const ORG_COMPANY_DETAILS = 'Policy C8 Org Company Details';
const TEAM_REPLY_TO = 'team-reply-c8@policy-c8.example.com';
const TEAM_BRANDING_CSS = '.policy-c8-team-marker{color:#654321}';
// One id per runner process, so a restarted worker derives the same values as the seed that wrote them.
const RUN_ID = `${process.ppid}`;
const SUBSCRIPTION_PLAN_ID = `plan_policy_c9_${RUN_ID}`;
const SUBSCRIPTION_PRICE_ID = `price_policy_c9_${RUN_ID}`;
const SUBSCRIPTION_CUSTOMER_ID = `cus_policy_c9_${RUN_ID}`;
const ORGANISATION_CUSTOMER_ID = `cus_org_policy_c9_${RUN_ID}`;

const SETTINGS_MARKERS = [
  ORG_TIMEZONE,
  ORG_REPLY_TO,
  ORG_BRANDING_CSS,
  ORG_COMPANY_DETAILS,
  TEAM_REPLY_TO,
  TEAM_BRANDING_CSS,
  TEAM_DATE_FORMAT,
];

const BILLING_MARKERS = [
  SUBSCRIPTION_PLAN_ID,
  SUBSCRIPTION_PRICE_ID,
  SUBSCRIPTION_CUSTOMER_ID,
  ORGANISATION_CUSTOMER_ID,
];

const formFieldsPdf = fs.readFileSync(path.join(__dirname, '../../../../assets/form-fields-test.pdf'));

type Role = 'orgMember' | 'orgManager' | 'orgAdmin' | 'teamManager' | 'teamAdmin' | 'outsider';

type Seed = {
  organisationId: string;
  organisationUrl: string;
  organisationName: string;
  teamId: number;
  teamUrl: string;
  teamName: string;
  subscriptionId: number;
  emails: Record<Role, string>;
  userIds: Record<Role, number>;
};

type SessionOrganisation = {
  id: string;
  name: string;
  customerId: string | null;
  currentOrganisationRole: string;
  subscription: { id: number; status: string } | null;
  teams: { id: number }[];
};

type Session = { page: Page; close: () => Promise<void> };

const input = (value: unknown) => encodeURIComponent(JSON.stringify({ json: value }));

const getOrganisation = async (page: Page, organisationId: string) => {
  return await page.request.get(
    `${baseUrl}/api/trpc/organisation.get?input=${input({ organisationReference: organisationId })}`,
  );
};

const getTeam = async (page: Page, teamId: number) => {
  return await page.request.get(`${baseUrl}/api/trpc/team.get?input=${input({ teamReference: teamId })}`);
};

const unwrap = async (response: Awaited<ReturnType<Page['request']['get']>>) => {
  expect(response.status()).toBe(200);

  const body = await response.json();

  return body.result.data.json;
};

const seedPolicyData = async (): Promise<Seed> => {
  const { organisation, team } = await seedUser({ isPersonalOrganisation: false });

  const [orgMember, orgManager, orgAdmin] = await seedOrganisationMembers({
    members: [
      { name: 'Org member', organisationRole: 'MEMBER' },
      { name: 'Org manager', organisationRole: 'MANAGER' },
      { name: 'Org admin', organisationRole: 'ADMIN' },
    ],
    organisationId: organisation.id,
  });

  const teamManager = await seedTeamMember({ teamId: team.id, name: 'Team manager', role: TeamMemberRole.MANAGER });
  const teamAdmin = await seedTeamMember({ teamId: team.id, name: 'Team admin', role: TeamMemberRole.ADMIN });
  const { user: outsider } = await seedUser({ isPersonalOrganisation: false });

  const organisationSettings = await prisma.organisation.findFirstOrThrow({
    where: { id: organisation.id },
    select: { organisationGlobalSettingsId: true },
  });

  await prisma.organisationGlobalSettings.update({
    where: { id: organisationSettings.organisationGlobalSettingsId },
    data: {
      documentTimezone: ORG_TIMEZONE,
      emailReplyTo: ORG_REPLY_TO,
      brandingCss: ORG_BRANDING_CSS,
      brandingCompanyDetails: ORG_COMPANY_DETAILS,
    },
  });

  await prisma.organisation.update({
    where: { id: organisation.id },
    data: { customerId: ORGANISATION_CUSTOMER_ID },
  });

  const subscription = await prisma.subscription.create({
    data: {
      organisationId: organisation.id,
      status: 'ACTIVE',
      planId: SUBSCRIPTION_PLAN_ID,
      priceId: SUBSCRIPTION_PRICE_ID,
      customerId: SUBSCRIPTION_CUSTOMER_ID,
    },
  });

  const teamRow = await prisma.team.findFirstOrThrow({
    where: { id: team.id },
    select: { teamGlobalSettingsId: true },
  });

  await prisma.teamGlobalSettings.update({
    where: { id: teamRow.teamGlobalSettingsId },
    data: {
      documentLanguage: TEAM_LANGUAGE,
      documentDateFormat: TEAM_DATE_FORMAT,
      emailReplyTo: TEAM_REPLY_TO,
      brandingCss: TEAM_BRANDING_CSS,
    },
  });

  const users = { orgMember, orgManager, orgAdmin, teamManager, teamAdmin, outsider };

  return {
    organisationId: organisation.id,
    organisationUrl: organisation.url,
    organisationName: organisation.name,
    teamId: team.id,
    teamUrl: team.url,
    teamName: team.name,
    subscriptionId: subscription.id,
    emails: Object.fromEntries(Object.entries(users).map(([role, user]) => [role, user.email])) as Seed['emails'],
    userIds: Object.fromEntries(Object.entries(users).map(([role, user]) => [role, user.id])) as Seed['userIds'],
  };
};

// A failing test restarts the Playwright worker, which would reseed and sign in again each time.
// The seed and the signed-in cookie state are cached in a file keyed by the runner process, so one
// run seeds once and signs each role in once, which keeps it under the local login rate limit.
const cachePath = path.join(os.tmpdir(), `settings-read-policy-${process.ppid}.json`);

type Cache = { seed?: Seed; states: Partial<Record<Role, Awaited<ReturnType<BrowserContext['storageState']>>>> };

const readCache = (): Cache => {
  return fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : { states: {} };
};

const writeCache = (cache: Cache) => {
  fs.writeFileSync(cachePath, JSON.stringify(cache));
};

const openSession = async (browser: Browser, role: Role, email: string): Promise<Session> => {
  const cache = readCache();
  const storedState = cache.states[role];
  const context = await browser.newContext(storedState ? { storageState: storedState } : {});
  const page = await context.newPage();

  if (!storedState) {
    await apiSignin({ page, email });

    const latest = readCache();

    latest.states[role] = await context.storageState();
    writeCache(latest);
  }

  return { page, close: async () => await context.close() };
};

test.describe('[SETTINGS_READ_POLICY]: organisation.get and team.get', () => {
  let seed: Seed;
  const sessions: Partial<Record<Role, Session>> = {};

  const getSeed = async () => {
    const cache = readCache();

    if (!cache.seed) {
      cache.seed = await seedPolicyData();
      writeCache(cache);
    }

    seed = cache.seed;

    return seed;
  };

  const as = async (browser: Browser, role: Role) => {
    const current = await getSeed();

    sessions[role] ??= await openSession(browser, role, current.emails[role]);

    return (sessions[role] as Session).page;
  };

  test.beforeEach(async () => {
    await getSeed();
  });

  test.afterAll(async () => {
    for (const session of Object.values(sessions)) {
      await session?.close();
    }
  });

  test('C1: an organisation member gets no settings and no subscription from organisation.get', async ({ browser }) => {
    const data = await unwrap(await getOrganisation(await as(browser, 'orgMember'), seed.organisationId));

    expect(data.organisationGlobalSettings).toBeNull();
    expect(data.subscription).toBeNull();
    expect(data.customerId).toBeNull();

    expect(data.id).toBe(seed.organisationId);
    expect(data.name).toBe(seed.organisationName);
    expect(data.url).toBe(seed.organisationUrl);
    expect(data.organisationClaim).toBeTruthy();
    expect(data.members.length).toBe(6);
    expect(data.teams.map((team: { id: number }) => team.id)).toContain(seed.teamId);
  });

  for (const role of ['orgManager', 'orgAdmin'] as const) {
    test(`C2: an organisation ${role} gets full settings from organisation.get`, async ({ browser }) => {
      const data = await unwrap(await getOrganisation(await as(browser, role), seed.organisationId));

      expect(data.organisationGlobalSettings).not.toBeNull();
      expect(data.organisationGlobalSettings.documentTimezone).toBe(ORG_TIMEZONE);
      expect(data.organisationGlobalSettings.documentLanguage).toBeTruthy();
      expect(data.subscription).not.toBeNull();
      expect(data.subscription.id).toBe(seed.subscriptionId);
      expect(data.id).toBe(seed.organisationId);
      expect(data.organisationClaim).toBeTruthy();
    });
  }

  test('C3: a team member gets no settings from team.get', async ({ browser }) => {
    const data = await unwrap(await getTeam(await as(browser, 'orgMember'), seed.teamId));

    expect(data.teamSettings).toBeNull();
    expect(data.derivedSettings).toBeNull();

    expect(data.id).toBe(seed.teamId);
    expect(data.name).toBe(seed.teamName);
    expect(data.url).toBe(seed.teamUrl);
    expect(data.currentTeamRole).toBe('MEMBER');
  });

  for (const role of ['teamManager', 'teamAdmin'] as const) {
    test(`C4: a ${role} gets full settings from team.get`, async ({ browser }) => {
      const data = await unwrap(await getTeam(await as(browser, role), seed.teamId));

      expect(data.currentTeamRole).toBe(role === 'teamManager' ? 'MANAGER' : 'ADMIN');
      expect(data.teamSettings).not.toBeNull();
      expect(data.teamSettings.documentLanguage).toBe(TEAM_LANGUAGE);
      expect(data.teamSettings.documentDateFormat).toBe(TEAM_DATE_FORMAT);
      expect(data.derivedSettings).not.toBeNull();
      expect(data.derivedSettings.documentLanguage).toBe(TEAM_LANGUAGE);
      expect(data.derivedSettings.documentTimezone).toBe(ORG_TIMEZONE);
    });
  }

  for (const role of ['orgManager', 'orgAdmin'] as const) {
    test(`C4: an organisation ${role} reaching the team by inheritance is judged by currentTeamRole`, async ({
      browser,
    }) => {
      const data = await unwrap(await getTeam(await as(browser, role), seed.teamId));

      expect(['ADMIN', 'MANAGER']).toContain(data.currentTeamRole);
      expect(data.teamSettings).not.toBeNull();
      expect(data.derivedSettings).not.toBeNull();
    });
  }

  test('C5: an outsider gets 404 from organisation.get and team.get', async ({ browser }) => {
    const organisationResponse = await getOrganisation(await as(browser, 'outsider'), seed.organisationId);
    const teamResponse = await getTeam(await as(browser, 'outsider'), seed.teamId);

    expect(organisationResponse.status()).toBe(404);
    expect(teamResponse.status()).toBe(404);
  });

  test('C5: an outsider gets 404 when addressing the team and organisation by url', async ({ browser }) => {
    const organisationResponse = await (await as(browser, 'outsider')).request.get(
      `${baseUrl}/api/trpc/organisation.get?input=${input({ organisationReference: seed.organisationUrl })}`,
    );
    const teamResponse = await (await as(browser, 'outsider')).request.get(
      `${baseUrl}/api/trpc/team.get?input=${input({ teamReference: seed.teamUrl })}`,
    );

    expect(organisationResponse.status()).toBe(404);
    expect(teamResponse.status()).toBe(404);
  });

  test('C7: a batched call with both procedures withholds the settings from a member', async ({ browser }) => {
    const batchInput = encodeURIComponent(
      JSON.stringify({
        '0': { json: { organisationReference: seed.organisationId } },
        '1': { json: { teamReference: seed.teamId } },
      }),
    );

    const response = await (await as(browser, 'orgMember')).request.get(
      `${baseUrl}/api/trpc/organisation.get,team.get?batch=1&input=${batchInput}`,
    );

    expect(response.status()).toBe(200);

    const [organisationResult, teamResult] = await response.json();
    const organisation = organisationResult.result.data.json;
    const team = teamResult.result.data.json;

    expect(organisation.organisationGlobalSettings).toBeNull();
    expect(organisation.subscription).toBeNull();
    expect(organisation.customerId).toBeNull();
    expect(team.teamSettings).toBeNull();
    expect(team.derivedSettings).toBeNull();
    expect(organisation.id).toBe(seed.organisationId);
    expect(team.id).toBe(seed.teamId);
  });

  test('C7: a batched call returns full settings to a manager', async ({ browser }) => {
    const batchInput = encodeURIComponent(
      JSON.stringify({
        '0': { json: { organisationReference: seed.organisationId } },
        '1': { json: { teamReference: seed.teamId } },
      }),
    );

    const response = await (await as(browser, 'orgAdmin')).request.get(
      `${baseUrl}/api/trpc/organisation.get,team.get?batch=1&input=${batchInput}`,
    );

    expect(response.status()).toBe(200);

    const [organisationResult, teamResult] = await response.json();

    expect(organisationResult.result.data.json.organisationGlobalSettings).not.toBeNull();
    expect(organisationResult.result.data.json.subscription.id).toBe(seed.subscriptionId);
    expect(teamResult.result.data.json.teamSettings).not.toBeNull();
    expect(teamResult.result.data.json.derivedSettings).not.toBeNull();
  });

  test('C7: the serialised member responses carry none of the settings values', async ({ browser }) => {
    const organisationText = await (await getOrganisation(await as(browser, 'orgMember'), seed.organisationId)).text();
    const teamText = await (await getTeam(await as(browser, 'orgMember'), seed.teamId)).text();

    expect(organisationText).not.toContain(ORG_TIMEZONE);
    expect(organisationText).not.toContain('brandingCss');

    for (const marker of [...SETTINGS_MARKERS, ...BILLING_MARKERS]) {
      expect(organisationText).not.toContain(marker);
      expect(teamText).not.toContain(marker);
    }
    expect(teamText).not.toContain(TEAM_DATE_FORMAT);
    expect(teamText).not.toContain(ORG_TIMEZONE);
  });

  const getSession = async (page: Page) => {
    const response = await page.request.get(`${baseUrl}/api/trpc/organisation.internal.getOrganisationSession`);

    expect(response.status()).toBe(200);

    const text = await response.text();

    return { text, organisations: JSON.parse(text).result.data.json as SessionOrganisation[] };
  };

  const findSessionOrganisation = (organisations: SessionOrganisation[]) => {
    const found = organisations.find((organisation) => organisation.id === seed.organisationId);

    expect(found).toBeDefined();

    return found as SessionOrganisation;
  };

  test('C8: the root loader payload of a member page carries no settings, subscription or customer', async ({
    browser,
  }) => {
    const page = await as(browser, 'orgMember');

    const response = await page.goto(`${baseUrl}/t/${seed.teamUrl}/documents`);

    expect(response?.status()).toBe(200);

    const html = await response?.text();

    // Positive control: the serialised root loader session does carry the member's organisation.
    expect(html).toContain(seed.organisationId);
    expect(html).toContain(seed.organisationName);
    expect(html).toContain('currentOrganisationRole');

    expect(html).not.toContain('organisationGlobalSettings');
    expect(html).not.toContain('teamGlobalSettings');

    for (const marker of [...SETTINGS_MARKERS, ...BILLING_MARKERS]) {
      expect(html).not.toContain(marker);
    }

    // The hydrated router state holds the decoded root loader payload.
    const rootData = await page.evaluate(() => {
      const context = (window as unknown as { __reactRouterContext?: { state?: { loaderData?: { root?: unknown } } } })
        .__reactRouterContext;

      return context?.state?.loaderData?.root ?? null;
    });

    expect(rootData).not.toBeNull();

    const organisations = (rootData as { session: { organisations: SessionOrganisation[] } }).session.organisations;
    const organisation = findSessionOrganisation(organisations);

    expect(organisation.currentOrganisationRole).toBe('MEMBER');
    expect(organisation.subscription).toBeNull();
    expect(organisation.customerId).toBeNull();
  });

  test('C8: organisation.internal.getOrganisationSession gives a member no settings, subscription or customer', async ({
    browser,
  }) => {
    const { text, organisations } = await getSession(await as(browser, 'orgMember'));
    const organisation = findSessionOrganisation(organisations);

    expect(organisation.currentOrganisationRole).toBe('MEMBER');
    expect(organisation.name).toBe(seed.organisationName);
    expect(organisation.teams.map((team) => team.id)).toContain(seed.teamId);

    expect(text).not.toContain('organisationGlobalSettings');
    expect(text).not.toContain('teamGlobalSettings');
    expect(organisation.subscription).toBeNull();
    expect(organisation.customerId).toBeNull();

    for (const marker of [...SETTINGS_MARKERS, ...BILLING_MARKERS]) {
      expect(text).not.toContain(marker);
    }
  });

  test('C9: a member gets null subscription and customerId from organisation.get and the session', async ({
    browser,
  }) => {
    const page = await as(browser, 'orgMember');
    const data = await unwrap(await getOrganisation(page, seed.organisationId));

    expect(data.subscription).toBeNull();
    expect(data.customerId).toBeNull();

    const organisation = findSessionOrganisation((await getSession(page)).organisations);

    expect(organisation.subscription).toBeNull();
    expect(organisation.customerId).toBeNull();
  });

  for (const role of ['orgManager', 'orgAdmin'] as const) {
    test(`C9: an organisation ${role} gets the seeded subscription and customerId from organisation.get and the session`, async ({
      browser,
    }) => {
      const page = await as(browser, role);
      const data = await unwrap(await getOrganisation(page, seed.organisationId));

      expect(data.subscription.id).toBe(seed.subscriptionId);
      expect(data.subscription.status).toBe('ACTIVE');
      expect(data.subscription.planId).toBe(SUBSCRIPTION_PLAN_ID);
      expect(data.customerId).toBe(ORGANISATION_CUSTOMER_ID);

      const organisation = findSessionOrganisation((await getSession(page)).organisations);

      expect(organisation.subscription?.id).toBe(seed.subscriptionId);
      expect(organisation.subscription?.status).toBe('ACTIVE');
      expect(organisation.customerId).toBe(ORGANISATION_CUSTOMER_ID);
    });
  }

  test('C10: organisation.getMany gives a member a null customerId and no seeded customer id in the raw text', async ({
    browser,
  }) => {
    const response = await (await as(browser, 'orgMember')).request.get(`${baseUrl}/api/trpc/organisation.getMany`);
    const text = await response.text();

    expect(response.status()).toBe(200);

    const organisation = findSessionOrganisation(JSON.parse(text).result.data.json);

    expect(organisation.customerId).toBeNull();

    for (const marker of BILLING_MARKERS) {
      expect(text).not.toContain(marker);
    }
  });

  for (const role of ['orgManager', 'orgAdmin'] as const) {
    test(`C10: an organisation ${role} gets the seeded customerId from organisation.getMany`, async ({ browser }) => {
      const response = await (await as(browser, role)).request.get(`${baseUrl}/api/trpc/organisation.getMany`);

      expect(response.status()).toBe(200);

      const organisation = findSessionOrganisation((await response.json()).result.data.json);

      expect(organisation.customerId).toBe(ORGANISATION_CUSTOMER_ID);
    });
  }

  test('C6: a member still loads the team documents and templates pages', async ({ browser }) => {
    const page = await as(browser, 'orgMember');

    const documents = await page.goto(`${baseUrl}/t/${seed.teamUrl}/documents`);

    expect(documents?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Documents' }).first()).toBeVisible();

    const templates = await page.goto(`${baseUrl}/t/${seed.teamUrl}/templates`);

    expect(templates?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Templates' }).first()).toBeVisible();
  });

  test('C6: an organisation manager still sees every organisation settings page render', async ({ browser }) => {
    const page = await as(browser, 'orgManager');

    const pages: [string, string][] = [
      ['document', 'Document Preferences'],
      ['branding', 'Branding Preferences'],
      ['email', 'Email Preferences'],
      ['certificates', 'Certificates'],
      ['reminders', 'Reminders'],
    ];

    for (const [slug, heading] of pages) {
      await page.goto(`${baseUrl}/o/${seed.organisationUrl}/settings/${slug}`);

      await expect(page.getByText(heading, { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Organisation not found')).toHaveCount(0);
    }
  });

  test('C6: an organisation manager still opens the create team dialog', async ({ browser }) => {
    const page = await as(browser, 'orgManager');

    await page.goto(`${baseUrl}/o/${seed.organisationUrl}/settings/teams`);
    await page.getByRole('button', { name: 'Create team' }).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('Team Name*')).toBeVisible();
  });

  test('C6: a team manager still sees every team settings page render', async ({ browser }) => {
    const page = await as(browser, 'teamManager');

    const pages: [string, string][] = [
      ['general', 'General settings'],
      ['document', 'Document Preferences'],
      ['branding', 'Branding Preferences'],
      ['email', 'Email Preferences'],
      ['certificates', 'Certificates'],
      ['reminders', 'Reminders'],
    ];

    for (const [slug, heading] of pages) {
      await page.goto(`${baseUrl}/t/${seed.teamUrl}/settings/${slug}`);

      await expect(page.getByText(heading, { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Team not found')).toHaveCount(0);
    }
  });

  test('C6: a document created by a team member still takes the team derived settings', async ({ request }) => {
    // Members cannot mint tokens, so the row is inserted directly, as the member, for the team.
    const token = `api_${alphaid(16)}`;

    await prisma.apiToken.create({
      data: {
        name: 'settings-read-policy',
        token: hashString(token),
        expires: null,
        userId: seed.userIds.orgMember,
        teamId: seed.teamId,
      },
    });

    const formData = new FormData();

    formData.append('payload', JSON.stringify({ type: EnvelopeType.DOCUMENT, title: 'Member document' }));
    formData.append('files', new File([formFieldsPdf], 'form-fields-test.pdf', { type: 'application/pdf' }));

    const response = await request.post(`${baseUrl}/api/v2-beta/envelope/create`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: formData,
    });

    expect(response.status()).toBe(200);

    const { id } = await response.json();

    const envelope = await prisma.envelope.findUniqueOrThrow({
      where: { id },
      include: { documentMeta: true },
    });

    expect(envelope.documentMeta.language).toBe(TEAM_LANGUAGE);
    expect(envelope.documentMeta.dateFormat).toBe(TEAM_DATE_FORMAT);
    expect(envelope.documentMeta.timezone).toBe(ORG_TIMEZONE);
  });
});
