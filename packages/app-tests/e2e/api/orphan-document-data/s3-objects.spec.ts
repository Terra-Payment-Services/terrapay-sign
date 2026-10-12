/**
 * Object storage under S3 (criterion 12, F2, F3).
 *
 * Written from the specification and its Decisions section. Decision 3 keeps
 * every storage object: nothing in this change may delete an object under S3,
 * so these tests check that objects the rows name are still there, that a use
 * of a template writes N objects and no more, and that a branding logo, which
 * no DocumentData row names, survives the cleanup script.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | a template use writes N objects; after use, duplicate, seal and    | 12       | F2            |
 * |   reseal every key a row names is present in the bucket            |          |               |
 * | a branding logo object survives the cleanup script                 |          | F3            |
 *
 * Criteria 1 to 3 and 7 under S3 are the same tests as under the database
 * transport, in template-use.spec.ts, template-use-custom-file.spec.ts and
 * supersede-paths.spec.ts, which read the object listing where the criterion
 * asks for it. Run them with the S3 variables set, as the red-s3 run does.
 *
 * The first test describes behaviour that must not change, so it passes on the
 * unfixed server: today's use writes N objects and nothing deletes one. The
 * branding test needs the cleanup script and fails until it exists.
 *
 * Skips, with the reason, unless NEXT_PUBLIC_UPLOAD_TRANSPORT is "s3". MinIO is
 * read with the server's own credentials; the bucket is shared with other
 * specs, so the run is one worker and the new-object count is taken as a
 * difference of listings around a single call.
 */
import fs from 'node:fs';
import path from 'node:path';

import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';
import { DocumentStatus } from '@prisma/client';

import { apiSignin } from '../../fixtures/authentication';
import {
  distribute,
  IS_S3,
  itemsOfEnvelope,
  jsonBearer,
  listObjects,
  type Owner,
  readObject,
  resealAsAdmin,
  rowsOf,
  runCleanup,
  seedTemplate,
  signAndComplete,
  UPLOAD_TRANSPORT,
  USE_CALLERS,
  uniqueEmail,
  V2,
  WEBAPP_URL,
  waitForStatus,
} from '../../fixtures/orphan-document-data';
import { assertVerifierToolsPresent } from '../../fixtures/protected-pdfs';

test.skip(
  !IS_S3,
  `Needs the S3 upload transport and MinIO; NEXT_PUBLIC_UPLOAD_TRANSPORT is ${JSON.stringify(UPLOAD_TRANSPORT)}.`,
);

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

/** Every key any row of the owner names in either column. */
const namedKeys = async (owner: Owner) => {
  const keys = new Set<string>();

  for (const row of await rowsOf(owner)) {
    if (row.type === 'S3_PATH') {
      keys.add(row.data);
      keys.add(row.initialData);
    }
  }

  return [...keys];
};

const expectAllKeysPresent = async (owner: Owner, context: string) => {
  const missing: string[] = [];

  for (const key of await namedKeys(owner)) {
    if ((await readObject(key)).status !== 200) {
      missing.push(key);
    }
  }

  expect(missing, `${context}: every key a row names is present in the bucket`).toEqual([]);
};

test('criterion_12_a_use_writes_n_objects_and_every_key_a_row_names_stays_present_through_the_whole_flow', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);

  const itemCount = 2;
  const tpl = await seedTemplate(request, itemCount, { label: 's3-flow' });
  const email = uniqueEmail('s3-flow');
  const usingEnvelope = USE_CALLERS.find((caller) => caller.name === 'API v2 envelope/use');

  const listingBefore = new Set((await listObjects()).map((object) => object.key));

  await usingEnvelope?.use(request, tpl, { email });

  const created = (await listObjects()).filter((object) => !listingBefore.has(object.key));

  expect(created, `a template use of ${itemCount} items writes exactly ${itemCount} new objects`).toHaveLength(
    itemCount,
  );
  await expectAllKeysPresent(tpl.owner, 'after the use');

  const doc = await prisma.envelope.findFirstOrThrow({
    where: { teamId: tpl.ctx.team.id, type: 'DOCUMENT', recipients: { some: { email } } },
    include: { recipients: true },
  });

  const duplicate = await request.post(`${V2}/envelope/duplicate`, {
    headers: jsonBearer(tpl.ctx.token),
    data: { envelopeId: doc.id },
  });

  expect(duplicate.ok(), `envelope/duplicate: ${await duplicate.text()}`).toBeTruthy();
  await expectAllKeysPresent(tpl.owner, 'after the duplicate');

  const { recipients } = await distribute(request, tpl.ctx.token, doc.id);
  const fields = await prisma.field.findMany({ where: { envelopeId: doc.id } });
  const before = await itemsOfEnvelope(doc.id);

  await signAndComplete(
    request,
    recipients[0].token,
    fields.map((field) => field.id),
    Number(doc.secondaryId.replace('document_', '')),
  );
  await waitForStatus(doc.id, DocumentStatus.COMPLETED);
  await expect
    .poll(
      async () => (await itemsOfEnvelope(doc.id)).every((item, i) => item.documentDataId !== before[i].documentDataId),
      {
        timeout: 90_000,
        intervals: [1_000],
      },
    )
    .toBe(true);
  await expectAllKeysPresent(tpl.owner, 'after the seal');

  const sealed = await itemsOfEnvelope(doc.id);
  const { user: admin } = await seedUser({ isAdmin: true });

  await resealAsAdmin(page, admin.email, doc.id, sealed[0].id);
  await expectAllKeysPresent(tpl.owner, 'after the reseal');
});

test('F3_a_branding_logo_object_that_no_documentdata_row_names_survives_the_cleanup_script', async ({ page }) => {
  const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

  await prisma.organisationClaim.update({
    where: { id: organisation.organisationClaim.id },
    data: { flags: { allowLegacyEnvelopes: true, allowCustomBranding: true } },
  });
  await apiSignin({ page, email: user.email });

  const logo = fs.readFileSync(path.join(__dirname, '../../../../assets/logo.png'));

  const res = await page.context().request.post(`${WEBAPP_URL}/api/trpc/organisation.settings.updateBrandingLogo`, {
    multipart: {
      payload: JSON.stringify({ organisationId: organisation.id }),
      brandingLogo: { name: 'logo.png', mimeType: 'image/png', buffer: logo },
    },
  });

  expect(res.ok(), `updateBrandingLogo: ${res.status()} ${await res.text()}`).toBeTruthy();

  const settings = await prisma.organisationGlobalSettings.findUniqueOrThrow({
    where: { id: organisation.organisationGlobalSettingsId },
  });
  const { type, data } = JSON.parse(settings.brandingLogo) as { type: string; data: string };

  expect(type, 'premise: under S3 the logo is stored as an object key').toBe('S3_PATH');
  expect((await readObject(data)).status, 'premise: the logo object is in the bucket').toBe(200);
  expect(
    await prisma.documentData.count({ where: { OR: [{ data }, { initialData: data }] } }),
    'premise: no DocumentData row names the logo object',
  ).toBe(0);

  const run = await runCleanup(['--commit', '--older-than-days', '1']);

  expect(run.code, `the cleanup script ran: ${run.stderr}`).toBe(0);
  expect((await readObject(data)).status, 'the logo object is still in the bucket after the run').toBe(200);
});
