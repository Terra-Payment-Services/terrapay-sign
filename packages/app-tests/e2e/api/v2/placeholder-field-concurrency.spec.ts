/**
 * Concurrent placeholder field requests on one envelope item (criteria 1 and 2).
 *
 * Written from the specification alone, without reading the implementation of
 * create-envelope-fields.ts.
 *
 * Adding a field on a text placeholder whites the placeholder out and stores
 * the result as a new revision of the item's PDF. Two such requests on the
 * same item that run together must not lose either whiteout: whatever the
 * final revision is, every saved field's placeholder must be gone from it.
 *
 * Each round seeds a fresh draft holding one PDF with placeholders A
 * (`{{signature}}`) and B (`{{initials}}`), fires one request per placeholder
 * with Promise.all, then reads the item's current PDF and checks the
 * rectangle of every saved field for ink. The race is provoked over HTTP
 * alone; no test hook is used.
 *
 * The oracle is a pdftoppm rendering rather than pdftotext, for the reason
 * given in fixtures/placeholder-fields.ts: pdftotext reads text under a white
 * rectangle, so it reports a placeholder even after a correct whiteout.
 *
 * "Retryable error" is read as one of 409, 423, 429 or 503. A refused request
 * must have saved none of its fields, and at most one of the pair may be
 * refused.
 *
 * | Test                                                          | Criteria | Failure modes |
 * | ------------------------------------------------------------- | -------- | ------------- |
 * | concurrent A and B requests, 10 rounds: no saved field's       | 1, 2     | F1, F2        |
 * |   placeholder shows in the final PDF                           |          |               |
 * | sequential A then B (control): both placeholders blank, which  | 1        | oracle check  |
 * |   shows the oracle sees a whiteout when there is no race       |          |               |
 */
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';

import {
  bodyOf,
  buildPlaceholderPdf,
  createFields,
  inkInRect,
  PLACEHOLDER_A,
  PLACEHOLDER_B,
  PLACEHOLDER_FIELD_TYPE,
  placeholderField,
  RETRYABLE_STATUSES,
  readCurrentItemPdf,
  renderPageGrey,
  seedPlaceholderDraft,
  uniqueMarker,
} from '../../fixtures/placeholder-fields';
import { assertVerifierToolsPresent } from '../../fixtures/protected-pdfs';

const ROUNDS = 10;

const PLACEHOLDER_OF_TYPE = Object.fromEntries(
  Object.entries(PLACEHOLDER_FIELD_TYPE).map(([placeholder, type]) => [type, placeholder]),
);

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

/**
 * Every saved field on the item, with the ink found in its rectangle on the
 * item's current PDF and on the original upload. The original must show ink
 * there, or the rectangle is not where the placeholder was and a zero proves
 * nothing.
 */
const inspectSavedFields = async (envelopeItemId: string, original: Buffer) => {
  const fields = await prisma.field.findMany({ where: { envelopeItemId }, orderBy: { id: 'asc' } });
  const current = renderPageGrey((await readCurrentItemPdf(envelopeItemId)).bytes);
  const before = renderPageGrey(new Uint8Array(original));

  return fields.map((field) => ({
    id: field.id,
    type: field.type,
    placeholder: PLACEHOLDER_OF_TYPE[field.type],
    inkBefore: inkInRect(before, field),
    inkNow: inkInRect(current, field),
  }));
};

test('criterion_1_2_concurrent_placeholder_requests_leave_no_saved_fields_placeholder_visible', async ({ request }) => {
  test.setTimeout(180_000);

  const failures: string[] = [];

  for (let round = 1; round <= ROUNDS; round += 1) {
    const marker = uniqueMarker();
    const original = await buildPlaceholderPdf(marker);
    const { token, envelopeId, recipientId } = await seedPlaceholderDraft(request, `pf-race-${round}`, original);
    const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });

    const [resA, resB] = await Promise.all(
      [PLACEHOLDER_A, PLACEHOLDER_B].map(
        async (placeholder) =>
          await createFields(request, token, envelopeId, [
            placeholderField(recipientId, placeholder as keyof typeof PLACEHOLDER_FIELD_TYPE),
          ]),
      ),
    );

    const answers = [
      { placeholder: PLACEHOLDER_A, res: resA, ...(await bodyOf(resA)) },
      { placeholder: PLACEHOLDER_B, res: resB, ...(await bodyOf(resB)) },
    ];
    const saved = await inspectSavedFields(item.id, original);

    test.info().annotations.push({
      type: `round ${round}`,
      description: JSON.stringify({
        statuses: answers.map(({ placeholder, res }) => `${placeholder}=${res.status()}`),
        saved,
      }),
    });

    if (answers.every(({ res }) => !res.ok())) {
      failures.push(`round ${round}: both requests were refused; at most one may be`);
    }

    for (const { placeholder, res, text, body } of answers) {
      const type = PLACEHOLDER_FIELD_TYPE[placeholder as keyof typeof PLACEHOLDER_FIELD_TYPE];
      const savedIds = saved.filter((field) => field.type === type).map((field) => field.id);

      if (res.ok()) {
        const returned = ((body.data ?? []) as Array<{ id: number }>).map((field) => field.id);

        // F2: a 200 whose field was dropped.
        if (returned.length !== 1 || JSON.stringify(savedIds) !== JSON.stringify(returned)) {
          failures.push(
            `round ${round}: ${placeholder} answered 200 with fields ${JSON.stringify(returned)} but the item holds ${JSON.stringify(savedIds)}`,
          );
        }
      } else {
        if (!RETRYABLE_STATUSES.includes(res.status())) {
          failures.push(
            `round ${round}: ${placeholder} was refused with ${res.status()}, not a retryable status: ${text.slice(0, 300)}`,
          );
        }

        if (savedIds.length > 0) {
          failures.push(`round ${round}: ${placeholder} was refused but saved fields ${JSON.stringify(savedIds)}`);
        }
      }
    }

    for (const field of saved) {
      if (field.inkBefore === 0) {
        failures.push(`round ${round}: premise: ${field.placeholder} is not printed where field ${field.id} sits`);
      }

      // F1: the other request's revision replaced this field's whiteout.
      if (field.inkNow > 0) {
        failures.push(
          `round ${round}: field ${field.id} (${field.type}) is saved but ${field.placeholder} still shows in the final PDF (${field.inkNow} dark pixels in its rectangle)`,
        );
      }
    }
  }

  expect(failures, `violations of criteria 1 and 2 over ${ROUNDS} rounds of concurrent requests`).toEqual([]);
});

test('criterion_1_sequential_placeholder_requests_blank_both_placeholders_control', async ({ request }) => {
  const original = await buildPlaceholderPdf(uniqueMarker());
  const { token, envelopeId, recipientId } = await seedPlaceholderDraft(request, 'pf-sequential', original);
  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });

  for (const placeholder of [PLACEHOLDER_A, PLACEHOLDER_B] as const) {
    const res = await createFields(request, token, envelopeId, [placeholderField(recipientId, placeholder)]);

    expect(res.status(), `${placeholder}: ${await res.text()}`).toBe(200);
  }

  const saved = await inspectSavedFields(item.id, original);

  expect(saved.map((field) => field.type).sort(), 'one field per placeholder').toEqual(
    [PLACEHOLDER_FIELD_TYPE[PLACEHOLDER_A], PLACEHOLDER_FIELD_TYPE[PLACEHOLDER_B]].sort(),
  );

  for (const field of saved) {
    expect(field.inkBefore, `premise: ${field.placeholder} is printed where the field sits`).toBeGreaterThan(0);
    expect(field.inkNow, `${field.placeholder} is whited out once its field exists`).toBe(0);
  }
});
