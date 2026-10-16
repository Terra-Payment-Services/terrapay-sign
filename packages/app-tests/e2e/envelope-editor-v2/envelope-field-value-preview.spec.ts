/**
 * The V2 editor previews each signer's name and the signing date in their fields.
 *
 * Written from the specification alone, before any implementation
 * exists. Every verdict comes from the Konva node tree of the live editor or signing page,
 * or from the database.
 *
 * | Test                                                               | Acceptance | Fails on main |
 * | ------------------------------------------------------------------ | ---------- | ------------- |
 * | NAME field shows the recipient's name at font size 12              | A          | yes           |
 * | DATE field shows now in the document's format and time zone        | A          | yes           |
 * | DATE field uses the signing defaults when the document sets none   | A          | yes           |
 * | crop (default): editor text node lays out as the signing page does| B          | yes           |
 * | overflow auto: editor text node lays out as the signing page does  | B          | yes           |
 * | renaming the recipient updates the NAME preview                    | C          | yes           |
 * | changing the field font size updates the NAME preview              | C          | yes           |
 * | changing the document date format updates the DATE preview         | C          | yes           |
 * | a recipient with an empty name shows "Name"                        | D          | no            |
 * | fields with a label show the label                                 | D          | no            |
 * | after the editor and the send, fields are uninserted, signing as is| E          | no            |
 *
 * Deviation from the specification: acceptance C names a NAME font size of 6. The editor's
 * font size input and ZBaseFieldMeta both enforce min 8 (field-form-fontSize min={8},
 * z.number().min(8)), so 6 cannot be entered. The test uses 24.
 *
 * Expected date strings are computed in the test with luxon, the library the signing page
 * uses (envelope-signing-provider.tsx prefillDateFields):
 * DateTime.now().setZone(timezone).toFormat(dateFormat), with the document's own timezone
 * and dateFormat. The clock is read before and after the page is read, and either minute is
 * accepted, so a minute boundary cannot fail a run.
 */
import { DEFAULT_DOCUMENT_DATE_FORMAT } from '@documenso/lib/constants/date-formats';
import { DEFAULT_DOCUMENT_TIME_ZONE } from '@documenso/lib/constants/time-zones';
import { prisma } from '@documenso/prisma';
import { expect, type Page, test } from '@playwright/test';
import { FieldType } from '@prisma/client';
import { DateTime } from 'luxon';

import {
  type ApiSeedContext,
  apiCreateTestContext,
  apiDistributeEnvelope,
  apiSeedDraftDocument,
  apiSeedPendingDocument,
} from '../fixtures/api-seeds';
import { apiSignin } from '../fixtures/authentication';
import { clickEnvelopeEditorStep, getRecipientNameInputs, setRecipientName } from '../fixtures/envelope-editor';
import { expectToastTextToBeVisible } from '../fixtures/generic';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const FULL_NAME = 'Ramakrishnan Sundaram';
const DOC_TIMEZONE = 'Australia/Melbourne';
const DOC_DATE_FORMAT = 'EEEE, MMMM dd, yyyy HH:mm';

const NAME_Y = 10;
const DATE_Y = 30;
const SIGNATURE_Y = 50;

type FieldMeta = Record<string, unknown>;

type TextNode = {
  text: string;
  fontSize: number;
  width: number;
  height: number;
  wrap: string;
  ellipsis: boolean | undefined;
  x: number;
  y: number;
  align: string;
  verticalAlign: string;
  lineHeight: number;
  letterSpacing: number;
};

type Group = { id: string; groupX: number; groupY: number; text: TextNode | null };

const LAYOUT_KEYS = ['width', 'height', 'wrap', 'ellipsis', 'x', 'y', 'fontSize'] as const;

const fieldBox = (y: number, width: number) => ({ page: 1, positionX: 10, positionY: y, width, height: 5 });

const buildFields = (opts: { nameWidth?: number; nameMeta?: FieldMeta; dateMeta?: FieldMeta }) => [
  {
    type: FieldType.NAME,
    ...fieldBox(NAME_Y, opts.nameWidth ?? 40),
    ...(opts.nameMeta && { fieldMeta: opts.nameMeta }),
  },
  { type: FieldType.DATE, ...fieldBox(DATE_Y, 40), ...(opts.dateMeta && { fieldMeta: opts.dateMeta }) },
  { type: FieldType.SIGNATURE, ...fieldBox(SIGNATURE_Y, 20) },
];

const seedDraft = async (
  request: Parameters<typeof apiSeedDraftDocument>[0],
  opts: {
    recipientName?: string;
    meta?: { timezone?: string; dateFormat?: string };
    nameWidth?: number;
    nameMeta?: FieldMeta;
    dateMeta?: FieldMeta;
    context?: ApiSeedContext;
  } = {},
) => {
  const email = `preview-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.documenso.com`;

  const seeded = await apiSeedDraftDocument(request, {
    title: '[TEST] editor value preview',
    context: opts.context,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    meta: opts.meta as never,
    recipients: [{ email, name: opts.recipientName ?? FULL_NAME, role: 'SIGNER' }],
    fieldsPerRecipient: [buildFields(opts)],
  });

  return { ...seeded, email };
};

const openFieldsStep = async (page: Page, seeded: Awaited<ReturnType<typeof seedDraft>>) => {
  await apiSignin({
    page,
    email: seeded.user.email,
    redirectPath: `/t/${seeded.team.url}/documents/${seeded.envelope.id}/edit?step=addFields`,
  });

  await expect(page.getByText('Selected Recipient')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.konva-container canvas').first()).toBeVisible({ timeout: 30_000 });
};

/** Every field group on page 1 with its text node, read from the live Konva stage, top to bottom. */
const readGroups = async (page: Page): Promise<Group[]> => {
  const groups = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const konva = (window as unknown as { Konva: typeof import('konva').default }).Konva;
    const stage = konva.stages.find((s) => s.attrs.id === 'page-1');

    if (!stage) {
      return [];
    }

    return stage.find('.field-group').map((node) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const group = node as import('konva').default.Group;
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const text = group.findOne('.field-text') as import('konva').default.Text | undefined;

      return {
        id: group.id(),
        groupX: group.x(),
        groupY: group.y(),
        text: text
          ? {
              text: text.text(),
              fontSize: text.fontSize(),
              width: text.width(),
              height: text.height(),
              wrap: text.wrap(),
              ellipsis: text.attrs.ellipsis as boolean | undefined,
              x: text.x(),
              y: text.y(),
              align: text.align(),
              verticalAlign: text.verticalAlign(),
              lineHeight: text.lineHeight(),
              letterSpacing: text.letterSpacing(),
            }
          : null,
      };
    });
  });

  return groups.sort((a, b) => a.groupY - b.groupY);
};

/**
 * The editor's text nodes by field. The fields sit at distinct heights (NAME above DATE above
 * SIGNATURE), and the Konva group id in the editor is a client form id, so the order is the key.
 */
const readEditorFields = async (page: Page) => {
  const groups = await readGroups(page);

  expect(groups, 'the editor draws three fields on page 1').toHaveLength(3);

  const [name, date, signature] = groups;

  return { name: name.text as TextNode, date: date.text as TextNode, signature: signature.text as TextNode };
};

const formatNow = (timezone: string, dateFormat: string) => DateTime.now().setZone(timezone).toFormat(dateFormat);

/** Polls a text node until it reads the current time in the given format and zone, minute boundary safe. */
const expectDateText = async (read: () => Promise<string>, timezone: string, dateFormat: string) => {
  await expect
    .poll(
      async () => {
        const before = formatNow(timezone, dateFormat);
        const actual = await read();
        const after = formatNow(timezone, dateFormat);

        return [before, after].includes(actual)
          ? 'matches now'
          : `read "${actual}", expected "${before}" or "${after}"`;
      },
      { timeout: 15_000 },
    )
    .toBe('matches now');
};

const pickLayout = (node: TextNode) => Object.fromEntries(LAYOUT_KEYS.map((key) => [key, node[key]]));

const canvasPoint = async (page: Page, xPercent: number, yPercent: number) => {
  const box = await page.locator('.konva-container canvas').first().boundingBox();

  if (!box) {
    throw new Error('The canvas has no bounding box');
  }

  return { x: (xPercent / 100) * box.width, y: (yPercent / 100) * box.height };
};

/**
 * Seeds the same field geometry on a pending document, signs the NAME field through the real
 * signing page, and returns the text node the signing page draws for it.
 */
const readSigningNameNode = async (
  page: Page,
  request: Parameters<typeof apiSeedPendingDocument>[0],
  opts: { nameWidth: number; nameMeta?: FieldMeta },
): Promise<TextNode> => {
  const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
    recipients: [
      { email: `signing-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.documenso.com`, name: FULL_NAME },
    ],
    fieldsPerRecipient: [buildFields(opts)],
  });

  const { token } = distributeResult.recipients[0];
  const nameField = envelope.fields.find((field) => field.type === FieldType.NAME);

  if (!nameField) {
    throw new Error('The pending document has no NAME field');
  }

  await page.goto(`/sign/${token}`);
  await expect(page.locator('.konva-container canvas').first()).toBeVisible({ timeout: 30_000 });

  const point = await canvasPoint(page, 10 + opts.nameWidth / 2, NAME_Y + 2.5);

  await page.locator('.konva-container canvas').first().click({ position: point });

  const dialog = page.getByRole('dialog');

  if (await dialog.isVisible().catch(() => false)) {
    await dialog.locator('input[type="text"], input[name="name"]').first().fill(FULL_NAME);
    await dialog.getByRole('button', { name: 'Save' }).click();
  }

  await expect
    .poll(
      async () => {
        const groups = await readGroups(page);

        return groups.find((group) => group.id === String(nameField.id))?.text?.text ?? null;
      },
      { message: 'the signing page draws the inserted NAME value', timeout: 20_000 },
    )
    .toBe(FULL_NAME);

  const groups = await readGroups(page);
  const node = groups.find((group) => group.id === String(nameField.id))?.text;

  if (!node) {
    throw new Error('The signing page has no text node for the NAME field');
  }

  return node;
};

test.describe('editor shows each signer value in their fields', () => {
  // Acceptance A.
  test('A: the NAME field reads the recipient name at font size 12', async ({ page, request }) => {
    const seeded = await seedDraft(request, { meta: { timezone: DOC_TIMEZONE, dateFormat: DOC_DATE_FORMAT } });

    await openFieldsStep(page, seeded);

    await expect.poll(async () => (await readEditorFields(page)).name.text, { timeout: 15_000 }).toBe(FULL_NAME);

    expect((await readEditorFields(page)).name.fontSize).toBe(12);
  });

  test('A: the DATE field reads now in the document date format and time zone', async ({ page, request }) => {
    const seeded = await seedDraft(request, { meta: { timezone: DOC_TIMEZONE, dateFormat: DOC_DATE_FORMAT } });

    await openFieldsStep(page, seeded);

    await expectDateText(async () => (await readEditorFields(page)).date.text, DOC_TIMEZONE, DOC_DATE_FORMAT);
  });

  test('A: with no format or zone on the document the DATE field uses the signing defaults', async ({
    page,
    request,
  }) => {
    const seeded = await seedDraft(request);

    const meta = await prisma.documentMeta.findFirstOrThrow({ where: { envelope: { id: seeded.envelope.id } } });
    const timezone = meta.timezone ?? DEFAULT_DOCUMENT_TIME_ZONE;
    const dateFormat = meta.dateFormat ?? DEFAULT_DOCUMENT_DATE_FORMAT;

    await openFieldsStep(page, seeded);

    await expectDateText(async () => (await readEditorFields(page)).date.text, timezone, dateFormat);
  });

  // Acceptance B. The width is narrower than the 21-character name at 12 pt.
  for (const overflow of ['crop', 'auto'] as const) {
    test(`B: overflow ${overflow}: the editor text node lays out as the signing page does`, async ({
      page,
      request,
      browser,
    }) => {
      const nameWidth = 8;
      const nameMeta = { type: 'name', overflow };

      const seeded = await seedDraft(request, { nameWidth, nameMeta });

      const signingContext = await browser.newContext();
      const signingPage = await signingContext.newPage();
      const signingNode = await readSigningNameNode(signingPage, request, { nameWidth, nameMeta });

      await signingContext.close();

      // Guard: the signing side drew the whole name into a narrow box, so the comparison is real.
      expect(signingNode.text).toBe(FULL_NAME);
      expect(signingNode.width, 'the signing node is narrower than the name needs').toBeLessThan(120);

      await openFieldsStep(page, seeded);

      await expect.poll(async () => (await readEditorFields(page)).name.text, { timeout: 15_000 }).toBe(FULL_NAME);

      const editorNode = (await readEditorFields(page)).name;

      expect(pickLayout(editorNode)).toEqual(pickLayout(signingNode));
    });
  }

  // Acceptance C. Each test performs its edit first and asserts the edit took effect before it reads the preview.
  test('C: renaming the recipient in the editor updates the NAME preview', async ({ page, request }) => {
    const seeded = await seedDraft(request);

    await openFieldsStep(page, seeded);

    await clickEnvelopeEditorStep(page, 'upload');
    await setRecipientName(page, 0, 'Ann Lee');
    await expect(getRecipientNameInputs(page).first()).toHaveValue('Ann Lee');
    await clickEnvelopeEditorStep(page, 'addFields');
    await expect(page.locator('.konva-container canvas').first()).toBeVisible();
    await expect.poll(async () => (await readGroups(page)).length, { timeout: 15_000 }).toBe(3);

    await expect.poll(async () => (await readEditorFields(page)).name.text, { timeout: 15_000 }).toBe('Ann Lee');
  });

  test('C: setting the NAME field font size updates the preview size', async ({ page, request }) => {
    const seeded = await seedDraft(request);

    await openFieldsStep(page, seeded);
    await expect.poll(async () => (await readGroups(page)).length, { timeout: 15_000 }).toBe(3);

    await page.waitForTimeout(300);
    await page
      .locator('.konva-container canvas')
      .first()
      .click({ position: await canvasPoint(page, 30, NAME_Y + 2.5), force: true });

    await page.locator('[data-testid="field-form-fontSize"]').fill('24');

    await expect.poll(async () => (await readEditorFields(page)).name.fontSize, { timeout: 15_000 }).toBe(24);
    await expect.poll(async () => (await readEditorFields(page)).name.text, { timeout: 15_000 }).toBe(FULL_NAME);
  });

  test('C: changing the document date format updates the DATE preview', async ({ page, request }) => {
    const seeded = await seedDraft(request, { meta: { timezone: DOC_TIMEZONE, dateFormat: DOC_DATE_FORMAT } });

    await openFieldsStep(page, seeded);

    await page.locator('button[title="Settings"]').click();
    await expect(page.getByRole('heading', { name: 'Document Settings' })).toBeVisible();
    await page
      .locator('label:has-text("Date Format")')
      .locator('xpath=..')
      .locator('[role="combobox"]')
      .first()
      .click();
    await page.getByRole('option', { name: 'DD/MM/YYYY', exact: true }).click();
    await page.locator('[data-testid="envelope-editor-settings-dialog-header"]').click();
    await page.getByRole('button', { name: 'Update' }).click();
    await expectToastTextToBeVisible(page, 'Envelope updated');

    const meta = await prisma.documentMeta.findFirstOrThrow({ where: { envelope: { id: seeded.envelope.id } } });

    expect(meta.dateFormat, 'the settings dialog saved the new format').toBe('dd/MM/yyyy');

    await expectDateText(async () => (await readEditorFields(page)).date.text, DOC_TIMEZONE, 'dd/MM/yyyy');
  });

  // Acceptance D, behaviour that stays as it is today.
  test('D: a recipient with an empty name shows "Name"', async ({ page, request }) => {
    const seeded = await seedDraft(request, { recipientName: '' });

    await openFieldsStep(page, seeded);

    await expect.poll(async () => (await readGroups(page)).length, { timeout: 15_000 }).toBe(3);
    await page.waitForTimeout(1_000);

    expect((await readEditorFields(page)).name.text).toBe('Name');
  });

  test('D: a field with a label shows the label even when the recipient has a name', async ({ page, request }) => {
    const seeded = await seedDraft(request, {
      nameMeta: { type: 'name', label: 'Full legal name' },
      dateMeta: { type: 'date', label: 'Signed on' },
    });

    await openFieldsStep(page, seeded);

    await expect.poll(async () => (await readGroups(page)).length, { timeout: 15_000 }).toBe(3);
    await page.waitForTimeout(1_000);

    const fields = await readEditorFields(page);

    expect(fields.name.text).toBe('Full legal name');
    expect(fields.date.text).toBe('Signed on');
  });

  // Acceptance E.
  test('E: after the editor is closed and the document sent, fields are uninserted and signing is unchanged', async ({
    page,
    request,
  }) => {
    const context = await apiCreateTestContext('e2e-preview-send');
    const seeded = await seedDraft(request, {
      context,
      meta: { timezone: DOC_TIMEZONE, dateFormat: DOC_DATE_FORMAT },
    });

    await openFieldsStep(page, seeded);
    await expect.poll(async () => (await readGroups(page)).length, { timeout: 15_000 }).toBe(3);

    // Visit the recipients step and come back, then leave the editor.
    await clickEnvelopeEditorStep(page, 'upload');
    await clickEnvelopeEditorStep(page, 'addFields');
    await expect(page.locator('.konva-container canvas').first()).toBeVisible();
    await page.waitForTimeout(1_500);
    await page.goto('/');

    const distributeResult = await apiDistributeEnvelope(request, seeded.token, seeded.envelope.id);

    const fields = await prisma.field.findMany({ where: { envelopeId: seeded.envelope.id } });

    expect(fields.map((field) => field.type).sort()).toEqual(
      [FieldType.DATE, FieldType.NAME, FieldType.SIGNATURE].sort(),
    );

    for (const field of fields) {
      expect(field.inserted, `${field.type} stays uninserted`).toBe(false);
      expect(field.customText, `${field.type} customText stays empty`).toBe('');
    }

    await page.goto(`/sign/${distributeResult.recipients[0].token}`);
    await expect(page.locator('.konva-container canvas').first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await readGroups(page)).length, { timeout: 15_000 }).toBe(3);

    // The signing page as it is today: NAME is the label, DATE is prefilled with now.
    const [name, date] = await readGroups(page);

    expect(name.text?.text).toBe('Name');
    await expectDateText(async () => (await readGroups(page))[1].text?.text ?? '', DOC_TIMEZONE, DOC_DATE_FORMAT);
    expect(date.text?.text).not.toBe('Date');
  });
});
