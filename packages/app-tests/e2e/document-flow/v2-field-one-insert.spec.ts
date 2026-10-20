/**
 * One V2 field, one insert.
 *
 * Written from the G1 specification (terrapay-sign-evidence/campaign-2026-10-17/G1/spec.md)
 * before any fix, without reading the V2 field sign route. B signs through
 * envelope.field.sign, the route the V2 signing page uses; an assistant
 * prefills through the same route. Assertions read the Field and Signature rows
 * and the DOCUMENT_FIELD_INSERTED / DOCUMENT_FIELD_PREFILLED audit rows, matched
 * on the field's secondaryId.
 *
 * | Criterion | Test                                                                         |
 * | --------- | ---------------------------------------------------------------------------- |
 * | C21       | C21 signing an inserted SIGNATURE or TEXT field again is refused               |
 * | C22       | C22 two signs of one uninserted field together: exactly one lands (SIGNATURE, TEXT) |
 * | C23       | C23 control: CHECKBOX and RADIO change in place (API, races, signing page); re-sign after un-insert; V1 duplicate refused |
 * | C24       | C24 the assistant's two prefills of B's TEXT field together: exactly one lands |
 *
 * Runs in the `ui` project: C23 drives the V2 signing page.
 */
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import {
  AUDIT,
  dataOf,
  expectOk,
  expectRefused,
  fieldAuditRows,
  fieldRow,
  isClientError,
  isSuccess,
  keepRecord,
  type Outcome,
  type Reply,
  rateLimited,
  replyVerdict,
  runIterations,
  type Seeded,
  seedEnvelope,
  signFieldV2,
  trpcRaw,
  verdictOf,
} from '../fixtures/reject-seal';

test.describe.configure({ mode: 'default' });

const CHECKBOX_META = {
  type: 'checkbox',
  label: 'Pick any',
  values: [
    { id: 1, value: 'Check A', checked: false },
    { id: 2, value: 'Check B', checked: false },
  ],
};

const RADIO_META = {
  type: 'radio',
  label: 'Pick one',
  values: [
    { id: 1, value: 'Option A', checked: false },
    { id: 2, value: 'Option B', checked: false },
  ],
};

const BOXES = {
  text: { positionX: 50, positionY: 10, width: 30, height: 6 },
  checkbox: { positionX: 50, positionY: 22, width: 30, height: 12 },
  radio: { positionX: 50, positionY: 40, width: 30, height: 12 },
};

const seedWithFields = async (request: APIRequestContext) => {
  const seeded = await seedEnvelope(request, {
    bFields: [
      { type: FieldType.TEXT, fieldMeta: { type: 'text', label: 'Text' }, box: BOXES.text },
      { type: FieldType.CHECKBOX, fieldMeta: CHECKBOX_META, box: BOXES.checkbox },
      { type: FieldType.RADIO, fieldMeta: RADIO_META, box: BOXES.radio },
    ],
  });

  const extra = (type: FieldType) => {
    const field = seeded.bExtra.find((candidate) => candidate.type === type);

    if (!field) {
      throw new Error(`No ${type} field for B`);
    }

    return field;
  };

  return {
    seeded,
    text: extra(FieldType.TEXT),
    checkbox: extra(FieldType.CHECKBOX),
    radio: extra(FieldType.RADIO),
  };
};

type Kind = 'SIGNATURE' | 'TEXT';

const fieldOf = (fixture: Awaited<ReturnType<typeof seedWithFields>>, kind: Kind) =>
  kind === 'SIGNATURE'
    ? { id: fixture.seeded.b.fieldId, secondaryId: fixture.seeded.b.fieldSecondaryId }
    : { id: fixture.text.id, secondaryId: fixture.text.secondaryId };

const signAs = async (
  seeded: Seeded,
  request: APIRequestContext,
  kind: Kind,
  fieldId: number,
  value: string,
  retry = true,
) => await signFieldV2(request, seeded.b.token, fieldId, { type: kind, value }, retry);

/** The value a SIGNATURE or TEXT field holds: the typed signature, or the text. */
const heldValue = async (kind: Kind, fieldId: number) => {
  const field = await fieldRow(fieldId);

  return kind === 'SIGNATURE' ? (field?.signature?.typedSignature ?? null) : (field?.customText ?? null);
};

/** The value an insert or prefill audit row records for the field. */
const auditValue = (row: { data: unknown }) => (dataOf(row).field as { data?: unknown } | undefined)?.data;

const auditMentions = (row: { data: unknown }, value: string) => auditValue(row) === value;

/** The rows sharing the latest timestamp: rows written in the same millisecond cannot be ordered. */
const latestRows = <T extends { createdAt: Date }>(rows: T[]) => {
  const last = Math.max(...rows.map((row) => row.createdAt.getTime()));

  return rows.filter((row) => row.createdAt.getTime() === last);
};

// ---------------------------------------------------------------------------
// C21
// ---------------------------------------------------------------------------

test('C21 signing an inserted SIGNATURE or TEXT field a second time is refused', async ({ request }) => {
  test.setTimeout(120_000);

  for (const kind of ['SIGNATURE', 'TEXT'] as const) {
    const fixture = await seedWithFields(request);
    const field = fieldOf(fixture, kind);

    expectOk(await signAs(fixture.seeded, request, kind, field.id, 'First value'), `${kind}: the first sign`);

    const second = await signAs(fixture.seeded, request, kind, field.id, 'Second value');

    expect
      .soft(second.status, `${kind}: the second sign is refused with a 4xx: ${second.body.slice(0, 300)}`)
      .toBeGreaterThanOrEqual(400);
    expect
      .soft(second.status, `${kind}: the second sign is refused with a 4xx: ${second.body.slice(0, 300)}`)
      .toBeLessThan(500);
    expect.soft(await heldValue(kind, field.id), `${kind}: the field holds the first value`).toBe('First value');
    expect
      .soft(
        await fieldAuditRows(fixture.seeded.envelopeId, AUDIT.FIELD_INSERTED, field.secondaryId),
        `${kind}: one DOCUMENT_FIELD_INSERTED row`,
      )
      .toHaveLength(1);
  }
});

// ---------------------------------------------------------------------------
// C22
// ---------------------------------------------------------------------------

for (const kind of ['SIGNATURE', 'TEXT'] as const) {
  test(`C22 two signs of B's uninserted ${kind} field together: exactly one lands`, async ({ request }) => {
    test.setTimeout(15 * 60_000);

    await runIterations(`C22-${kind}`, async (): Promise<Outcome> => {
      const fixture = await seedWithFields(request);
      const field = fieldOf(fixture, kind);
      const values = { first: `${kind} one`, second: `${kind} two` };

      const [firstReply, secondReply] = await Promise.all([
        signAs(fixture.seeded, request, kind, field.id, values.first, false),
        signAs(fixture.seeded, request, kind, field.id, values.second, false),
      ]);

      const limited = rateLimited(fixture.seeded, { firstReply, secondReply });

      if (limited) {
        return limited;
      }

      const held = await heldValue(kind, field.id);
      const inserts = await fieldAuditRows(fixture.seeded.envelopeId, AUDIT.FIELD_INSERTED, field.secondaryId);
      const successes = [firstReply, secondReply].filter(isSuccess).length;

      return {
        verdict: verdictOf(
          successes === 1 ? null : `${successes} of the two signs succeeded, expected exactly 1`,
          inserts.length === 1 ? null : `${inserts.length} insert rows, expected 1`,
          inserts.length === 1 && held !== null && !auditMentions(inserts[0], held)
            ? `the insert row does not match the held value "${held}"`
            : null,
          replyVerdict(firstReply, held === values.first, 'the first sign'),
          replyVerdict(secondReply, held === values.second, 'the second sign'),
        ),
        record: {
          envelopeId: fixture.seeded.envelopeId,
          firstReply: firstReply.status,
          secondReply: secondReply.status,
          held,
          insertRows: inserts.map(dataOf),
        },
      };
    });
  });
}

// ---------------------------------------------------------------------------
// C23, controls
// ---------------------------------------------------------------------------

const checkboxValue = async (fieldId: number) => (await fieldRow(fieldId))?.customText ?? null;

test('C23 control: CHECKBOX and RADIO change in place, a SIGNATURE re-signs after un-insert, V1 refuses a duplicate', async ({
  request,
}) => {
  test.setTimeout(20 * 60_000);

  // Sequential, through the API.
  const fixture = await seedWithFields(request);
  const { seeded } = fixture;

  expectOk(
    await signFieldV2(request, seeded.b.token, fixture.checkbox.id, { type: 'CHECKBOX', value: [0] }),
    'tick the first box',
  );
  const firstTick = await checkboxValue(fixture.checkbox.id);

  expectOk(
    await signFieldV2(request, seeded.b.token, fixture.checkbox.id, { type: 'CHECKBOX', value: [0, 1] }),
    'tick a second box on the inserted CHECKBOX',
  );
  expect(await checkboxValue(fixture.checkbox.id), 'the CHECKBOX value changed').not.toBe(firstTick);

  expectOk(
    await signFieldV2(request, seeded.b.token, fixture.radio.id, { type: 'RADIO', value: 0 }),
    'pick the first option',
  );
  const firstPick = await checkboxValue(fixture.radio.id);

  expectOk(
    await signFieldV2(request, seeded.b.token, fixture.radio.id, { type: 'RADIO', value: 1 }),
    'pick another option on the inserted RADIO',
  );
  expect(await checkboxValue(fixture.radio.id), 'the RADIO value changed').not.toBe(firstPick);

  expectOk(await signAs(seeded, request, 'SIGNATURE', seeded.b.fieldId, 'Before un-insert'), 'sign the SIGNATURE');
  expectOk(
    await signFieldV2(request, seeded.b.token, seeded.b.fieldId, { type: 'SIGNATURE', value: null }),
    'un-insert the SIGNATURE',
  );
  expectOk(await signAs(seeded, request, 'SIGNATURE', seeded.b.fieldId, 'After un-insert'), 'sign it again');
  expect(await heldValue('SIGNATURE', seeded.b.fieldId)).toBe('After un-insert');

  // V1 still refuses a duplicate sign (earlier criterion C20). The API seeds V2 envelopes, which field.signFieldWithToken now
  // refuses whatever the field (G4 C64, #142), so this envelope is marked V1, the version the route serves.
  const v1 = await seedEnvelope(request);

  await prisma.envelope.update({ where: { id: v1.envelopeId }, data: { internalVersion: 1 } });

  expectOk(
    await trpcRaw(request, 'field.signFieldWithToken', {
      token: v1.b.token,
      fieldId: v1.b.fieldId,
      value: 'V1 one',
      isBase64: false,
    }),
    'V1: the first sign',
  );
  expectRefused(
    await trpcRaw(request, 'field.signFieldWithToken', {
      token: v1.b.token,
      fieldId: v1.b.fieldId,
      value: 'V1 two',
      isBase64: false,
    }),
    'V1: the second sign',
  );

  // Two CHECKBOX or RADIO writes together both succeed; the field equals the latest insert row.
  for (const kind of ['CHECKBOX', 'RADIO'] as const) {
    await runIterations(`C23-${kind}`, async (): Promise<Outcome> => {
      const raced = await seedWithFields(request);
      const field = kind === 'CHECKBOX' ? raced.checkbox : raced.radio;
      const first = kind === 'CHECKBOX' ? { type: kind, value: [0] } : { type: kind, value: 0 };
      const second = kind === 'CHECKBOX' ? { type: kind, value: [1] } : { type: kind, value: 1 };

      const [firstReply, secondReply] = await Promise.all([
        signFieldV2(request, raced.seeded.b.token, field.id, first, false),
        signFieldV2(request, raced.seeded.b.token, field.id, second, false),
      ]);

      const limited = rateLimited(raced.seeded, { firstReply, secondReply });

      if (limited) {
        return limited;
      }

      const held = await checkboxValue(field.id);
      const inserts = await fieldAuditRows(raced.seeded.envelopeId, AUDIT.FIELD_INSERTED, field.secondaryId);

      return {
        verdict: verdictOf(
          isSuccess(firstReply) ? null : `the first write answered ${firstReply.status}`,
          isSuccess(secondReply) ? null : `the second write answered ${secondReply.status}`,
          held !== null && latestRows(inserts).some((row) => auditMentions(row, held))
            ? null
            : `the field holds "${held}", which the latest insert row does not record`,
        ),
        record: {
          envelopeId: raced.seeded.envelopeId,
          firstReply: firstReply.status,
          secondReply: secondReply.status,
          held,
          insertRows: inserts.map(dataOf),
        },
      };
    });
  }
});

/**
 * The V2 signing page draws fields on a Konva canvas, so options are clicked at
 * page coordinates. The option rows are found by trying points down the field
 * box and reading which value the database records, so the test does not depend
 * on how the renderer lays the options out.
 */
test('C23 control: on the V2 signing page B ticks a second box and picks another option', async ({ page, request }) => {
  test.setTimeout(180_000);

  const fixture = await seedWithFields(request);
  const { seeded } = fixture;

  await page.goto(`/sign/${seeded.b.token}`);
  await expect(page.locator('img[data-page-number]').first()).toBeVisible({ timeout: 30_000 });

  const canvas = page.locator('.konva-container canvas').first();

  await expect(canvas).toBeVisible({ timeout: 30_000 });

  const clickAt = async (box: { positionX: number; positionY: number; width: number; height: number }, fy: number) => {
    const bounds = await canvas.boundingBox();

    if (!bounds) {
      throw new Error('Canvas bounding box not found');
    }

    const x = ((box.positionX + box.width * 0.1) / 100) * bounds.width;
    const y = ((box.positionY + box.height * fy) / 100) * bounds.height;

    await canvas.click({ position: { x, y } });
    await page.waitForTimeout(1_500);
  };

  const fieldValueOf = async (fieldId: number) => {
    const field = await fieldRow(fieldId);

    return { inserted: field?.inserted ?? false, value: field?.customText ?? '' };
  };

  const steps: Array<Record<string, unknown>> = [];

  // Tick the first box, then a second one.
  await clickAt(BOXES.checkbox, 0.25);
  const afterFirstTick = await fieldValueOf(fixture.checkbox.id);

  steps.push({ step: 'tick first box', ...afterFirstTick });
  await clickAt(BOXES.checkbox, 0.75);
  const afterSecondTick = await fieldValueOf(fixture.checkbox.id);

  steps.push({ step: 'tick second box', ...afterSecondTick });

  // Pick an option, then the other one.
  await clickAt(BOXES.radio, 0.25);
  const afterFirstPick = await fieldValueOf(fixture.radio.id);

  steps.push({ step: 'pick first option', ...afterFirstPick });
  await clickAt(BOXES.radio, 0.7);
  const afterSecondPick = await fieldValueOf(fixture.radio.id);

  steps.push({ step: 'pick second option', ...afterSecondPick });

  await keepRecord('C23-ui-steps.json', steps);
  await page.screenshot({ path: test.info().outputPath('C23-ui-final.png'), fullPage: true });

  expect(afterFirstTick.inserted, 'the first tick inserts the CHECKBOX').toBe(true);
  expect(afterSecondTick.value, 'the second tick changes the CHECKBOX value').not.toBe(afterFirstTick.value);
  expect(afterSecondTick.inserted).toBe(true);
  expect(afterFirstPick.inserted, 'the first pick inserts the RADIO').toBe(true);
  expect(afterSecondPick.value, 'picking another option changes the RADIO value').not.toBe(afterFirstPick.value);
  expect(afterSecondPick.inserted).toBe(true);
});

// ---------------------------------------------------------------------------
// C24
// ---------------------------------------------------------------------------

/**
 * An ASSISTANT (order 1) and signer B (order 2) with an uninserted optional TEXT
 * field and a SIGNATURE field, sequential, as the earlier assistant seed is.
 */
const seedAssistant = async (request: APIRequestContext) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
    title: `G1 assistant ${stamp}`,
    meta: { signingOrder: 'SEQUENTIAL' },
    recipients: [
      { email: `g1-asst-${stamp}@test.documenso.com`, name: 'Assistant', role: 'ASSISTANT', signingOrder: 1 },
      { email: `g1-b-${stamp}@test.documenso.com`, name: 'Signer B', role: 'SIGNER', signingOrder: 2 },
    ],
    fieldsPerRecipient: [
      [],
      [
        { type: FieldType.SIGNATURE, page: 1, positionX: 10, positionY: 84, width: 30, height: 8 },
        { type: FieldType.TEXT, page: 1, ...BOXES.text, fieldMeta: { type: 'text', required: false } },
      ],
    ],
  });

  const assistant = distributeResult.recipients.find((candidate) => candidate.role === 'ASSISTANT');
  const signer = distributeResult.recipients.find((candidate) => candidate.role === 'SIGNER');

  if (!assistant || !signer) {
    throw new Error('Expected an ASSISTANT and a SIGNER');
  }

  const text = await prisma.field.findFirstOrThrow({
    where: { envelopeId: envelope.id, recipientId: signer.id, type: FieldType.TEXT },
  });

  return {
    envelopeId: envelope.id,
    documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
    assistantToken: assistant.token,
    text: { id: text.id, secondaryId: text.secondaryId },
  };
};

const prefill = async (
  request: APIRequestContext,
  token: string,
  fieldId: number,
  value: string,
  retry = true,
): Promise<Reply> => await signFieldV2(request, token, fieldId, { type: 'TEXT', value }, retry);

test("C24 the assistant's two prefills of B's TEXT field together: exactly one lands", async ({ request }) => {
  test.setTimeout(15 * 60_000);

  // Control: one prefill lands with one PREFILLED row.
  const control = await seedAssistant(request);

  expectOk(
    await prefill(request, control.assistantToken, control.text.id, 'Control prefill'),
    'control: the assistant prefills',
  );
  expect(await fieldAuditRows(control.envelopeId, AUDIT.FIELD_PREFILLED, control.text.secondaryId)).toHaveLength(1);

  await runIterations('C24', async (): Promise<Outcome> => {
    const seeded = await seedAssistant(request);
    const values = { first: 'Prefill one', second: 'Prefill two' };

    const [firstReply, secondReply] = await Promise.all([
      prefill(request, seeded.assistantToken, seeded.text.id, values.first, false),
      prefill(request, seeded.assistantToken, seeded.text.id, values.second, false),
    ]);

    const limited = rateLimited(seeded, { firstReply, secondReply });

    if (limited) {
      return limited;
    }

    const held = (await fieldRow(seeded.text.id))?.customText ?? null;
    const prefills = await fieldAuditRows(seeded.envelopeId, AUDIT.FIELD_PREFILLED, seeded.text.secondaryId);
    const successes = [firstReply, secondReply].filter(isSuccess).length;

    return {
      verdict: verdictOf(
        successes === 1 ? null : `${successes} of the two prefills succeeded, expected exactly 1`,
        prefills.length === 1 ? null : `${prefills.length} DOCUMENT_FIELD_PREFILLED rows, expected 1`,
        [firstReply, secondReply].every((reply) => isSuccess(reply) || isClientError(reply))
          ? null
          : 'a prefill answered 5xx',
        replyVerdict(firstReply, held === values.first, 'the first prefill'),
        replyVerdict(secondReply, held === values.second, 'the second prefill'),
      ),
      record: {
        envelopeId: seeded.envelopeId,
        firstReply: firstReply.status,
        secondReply: secondReply.status,
        held,
        prefillRows: prefills.map(dataOf),
      },
    };
  });
});
