/**
 * The sequential order gate on every recipient-token route.
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md,
 * section 5) before any fix, without reading the sign, unsign, complete, reject
 * or multi-sign handlers. Fixture S: SEQUENTIAL, SES, s1 (order 1), s2 (2),
 * s3 (3) and a CC (4), each signer with one SIGNATURE and one optional TEXT
 * field, written through Prisma. Requests carry only the recipient's token, no
 * cookie. Out-of-turn refusals assert section 4.0 in full through
 * expectOutOfTurn: 400 RECIPIENT_OUT_OF_TURN, no recipient, field or Signature
 * change, no audit row of any type, and no email to any recipient (Inbucket).
 *
 * | Criterion | Test                                                                          |
 * | --------- | ----------------------------------------------------------------------------- |
 * | C80       | C80 V1 field sign out of turn: s2 before s1, s3 after s1 only                    |
 * | C81       | C81 V1 unsign out of turn leaves s2's TEXT inserted                              |
 * | C82       | C82 V2 sign out of turn on SIGNATURE, TEXT, CHECKBOX and DATE                    |
 * | C83       | C83 V2 uninsert (value null) out of turn leaves s2's TEXT inserted                |
 * | C84       | C84 completion out of turn is refused (regression of today's check)              |
 * | C85       | C85 in turn on both versions, and any order on the PARALLEL copy                 |
 * | C86       | C86 an assistant prefills only on its own turn, never another's signature        |
 * | C87       | C87 the multi-sign embed and its query refuse an out-of-turn token               |
 * | C89       | C89 rejection out of turn is refused; in turn, same step and on-behalf are not   |
 *
 * Each multi-case test runs every case and fails once at the end with the list
 * of cases that broke, so the red run names all of them. Premises: every
 * out-of-turn case is followed, on the same envelope, by the in-turn control
 * that must succeed (the F02 lock-out half of 4.0).
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, SigningStatus } from '@prisma/client';

import { JOB, jobsFor, rejectOnBehalf, send } from '../fixtures/reject-seal';
import {
  auditValueOf,
  completeWithToken,
  describeReply,
  envelopeSnapshot,
  expect2xx,
  expectOutOfTurn,
  expectSignatureAccepted,
  fieldAuditRowsOf,
  fieldState,
  type G4Seeded,
  readInbox,
  rejectWithToken,
  seedFixtureG,
  seedFixtureS,
  seedInserted,
  signV2,
  WEBAPP_BASE_URL,
} from '../fixtures/signature-ink';
import {
  auditCount,
  envelopeStatus,
  OUT_OF_TURN_TEXT,
  recipientOf,
  settle,
  signAndComplete,
  signSig,
  signText,
  unsign,
  waitForEnvelopeStatus,
} from '../fixtures/signature-ink-order';

test.describe.configure({ mode: 'default' });

/** Runs every case, keeping the failures; the test fails once at the end with all of them. */
const cases = () => {
  const failures: string[] = [];

  return {
    run: async (what: string, body: () => Promise<unknown>) => {
      try {
        await body();
      } catch (error) {
        failures.push(`${what}: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`);
      }
    },
    /** A setup step later cases depend on: on failure the test stops at once, naming every case collected so far. */
    premise: async (what: string, body: () => Promise<unknown>) => {
      try {
        await body();
      } catch (error) {
        failures.push(`premise ${what}: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`);
        expect(failures, `${what}: a premise failed; cases collected before it`).toEqual([]);
      }
    },
    assert: (name: string) => expect(failures, `${name}: cases that broke the criterion`).toEqual([]),
  };
};

/** In-turn sign of `key`'s own SIGNATURE (typed) or TEXT field, with the 4.0 accepted checks on the stored value. */
const signOwnInTurn = async (request: APIRequestContext, s: G4Seeded, key: string, fieldKey: 'sig' | 'text') => {
  const field = s.r[key].fields[fieldKey];

  if ((await fieldState(field.id)).inserted) {
    // Inserted by an out-of-turn call above; that case has already been recorded as broken.
    return;
  }

  if (fieldKey === 'sig') {
    await expectSignatureAccepted(
      await signSig(request, s, key, key, `S ${key} in turn`),
      s,
      field,
      { typed: `S ${key} in turn` },
      `${key} signs SIGNATURE in turn`,
    );

    return;
  }

  expect2xx(await signText(request, s, key, key, `${key} in turn`), `${key} signs TEXT in turn`);

  const state = await fieldState(field.id);

  expect(state.inserted, `${key} TEXT inserted in turn`).toBe(true);
  expect(state.customText, `${key} TEXT holds the in-turn value`).toBe(`${key} in turn`);
};

const VERSIONS = [1, 2] as const;

// ---------------------------------------------------------------------------
// C80
// ---------------------------------------------------------------------------

test('C80 V1 field sign out of turn: s2 before s1 completes, s3 after s1 only', async ({ request }) => {
  test.setTimeout(180_000);

  const c = cases();
  const s = await seedFixtureS(1);

  await c.run('s2 SIGNATURE while s1 NOT_SIGNED', async () => {
    await expectOutOfTurn(request, s, async () => await signSig(request, s, 's2', 's2', 'S Two'), 's2 signs SIGNATURE');
  });
  await c.run('s2 TEXT while s1 NOT_SIGNED', async () => {
    await expectOutOfTurn(request, s, async () => await signText(request, s, 's2', 's2'), 's2 signs TEXT');
  });

  // s1 completes; s2 is now in turn, s3 is not.
  await c.premise('s1 completes', async () => {
    await signAndComplete(request, s, 's1', { typed: 'S One' });
    await settle();
  });

  await c.run('s3 SIGNATURE after s1 completed, s2 NOT_SIGNED', async () => {
    await expectOutOfTurn(
      request,
      s,
      async () => await signSig(request, s, 's3', 's3', 'S Three'),
      's3 signs SIGNATURE',
    );
  });
  await c.run('s3 TEXT after s1 completed, s2 NOT_SIGNED', async () => {
    await expectOutOfTurn(request, s, async () => await signText(request, s, 's3', 's3'), 's3 signs TEXT');
  });

  // Lock-out (4.0): s2, now in turn, can sign both fields.
  await c.run('control: s2 signs in turn', async () => {
    await signOwnInTurn(request, s, 's2', 'sig');
    await signOwnInTurn(request, s, 's2', 'text');
  });

  // Lock-out for s3: once s2 has completed, s3's refused fields can be signed.
  await c.premise('s2 completes', async () => {
    expect2xx(await completeWithToken(request, s, s.r.s2.token), 's2 completes');
    expect((await recipientOf(s, 's2')).signingStatus, 's2 SIGNED').toBe(SigningStatus.SIGNED);
  });
  await c.run('control: s3 signs in turn', async () => {
    await signOwnInTurn(request, s, 's3', 'sig');
    await signOwnInTurn(request, s, 's3', 'text');
  });

  c.assert('C80');
});

// ---------------------------------------------------------------------------
// C81
// ---------------------------------------------------------------------------

test('C81 V1 removeSignedFieldWithToken out of turn leaves s2 TEXT inserted with SEEDED', async ({ request }) => {
  test.setTimeout(120_000);

  const s = await seedFixtureS(1);

  await seedInserted(s, 's2', 'text', { text: 'SEEDED' });

  const seeded = await fieldState(s.r.s2.fields.text.id);

  expect(seeded, 'premise: the TEXT field is seeded inserted with SEEDED').toMatchObject({
    inserted: true,
    customText: 'SEEDED',
  });

  const c = cases();

  await c.run('s2 unsigns its TEXT while s1 NOT_SIGNED', async () => {
    await expectOutOfTurn(request, s, async () => await unsign(request, s, 's2', 'text'), 's2 unsigns TEXT');
  });

  // Premise: after s1 completes, the same unsign is accepted.
  await c.premise('s1 completes', async () => await signAndComplete(request, s, 's1', { typed: 'S One' }));

  await c.run('control: s2 unsigns in turn', async () => {
    const before = await fieldState(s.r.s2.fields.text.id);

    if (before.inserted) {
      expect2xx(await unsign(request, s, 's2', 'text'), 's2 unsigns TEXT in turn');
      expect((await fieldState(s.r.s2.fields.text.id)).inserted, 'the in-turn unsign clears the field').toBe(false);
    }
  });

  c.assert('C81');
});

// ---------------------------------------------------------------------------
// C82
// ---------------------------------------------------------------------------

test('C82 V2 envelope.field.sign out of turn on SIGNATURE, TEXT, CHECKBOX and DATE', async ({ request }) => {
  test.setTimeout(180_000);

  const s = await seedFixtureS(2, {
    s2Extra: [
      { key: 'checkbox', type: FieldType.CHECKBOX },
      { key: 'date', type: FieldType.DATE },
    ],
  });

  const values: Record<string, { type: string; value: unknown }> = {
    sig: { type: FieldType.SIGNATURE, value: 'S Two' },
    text: { type: FieldType.TEXT, value: OUT_OF_TURN_TEXT },
    checkbox: { type: FieldType.CHECKBOX, value: [0] },
    date: { type: FieldType.DATE, value: true },
  };

  const c = cases();

  for (const [key, fieldValue] of Object.entries(values)) {
    await c.run(`s2 ${key} while s1 NOT_SIGNED`, async () => {
      await expectOutOfTurn(
        request,
        s,
        async () => await signV2(request, s.r.s2.token, s.r.s2.fields[key].id, fieldValue),
        `s2 signs ${key}`,
      );
    });
  }

  // Premise: in turn, every one of the four values is accepted.
  await c.premise('s1 completes', async () => await signAndComplete(request, s, 's1', { typed: 'S One' }));

  for (const [key, fieldValue] of Object.entries(values)) {
    await c.run(`control: s2 ${key} in turn`, async () => {
      if (!(await fieldState(s.r.s2.fields[key].id)).inserted) {
        expect2xx(await signV2(request, s.r.s2.token, s.r.s2.fields[key].id, fieldValue), `s2 signs ${key} in turn`);
      }
    });
  }

  c.assert('C82');
});

// ---------------------------------------------------------------------------
// C83
// ---------------------------------------------------------------------------

test('C83 V2 uninsert (TEXT value null) out of turn leaves s2 TEXT inserted', async ({ request }) => {
  test.setTimeout(120_000);

  const s = await seedFixtureS(2);

  await seedInserted(s, 's2', 'text', { text: 'SEEDED' });

  expect(await fieldState(s.r.s2.fields.text.id), 'premise: seeded inserted with SEEDED').toMatchObject({
    inserted: true,
    customText: 'SEEDED',
  });

  const c = cases();

  await c.run('s2 sends TEXT null while s1 NOT_SIGNED', async () => {
    await expectOutOfTurn(
      request,
      s,
      async () => await signV2(request, s.r.s2.token, s.r.s2.fields.text.id, { type: FieldType.TEXT, value: null }),
      's2 uninserts TEXT',
    );
  });

  await c.premise('s1 completes', async () => await signAndComplete(request, s, 's1', { typed: 'S One' }));

  await c.run('control: s2 uninserts in turn', async () => {
    if ((await fieldState(s.r.s2.fields.text.id)).inserted) {
      expect2xx(
        await signV2(request, s.r.s2.token, s.r.s2.fields.text.id, { type: FieldType.TEXT, value: null }),
        's2 uninserts TEXT in turn',
      );
      expect((await fieldState(s.r.s2.fields.text.id)).inserted, 'the in-turn uninsert clears the field').toBe(false);
    }
  });

  c.assert('C83');
});

// ---------------------------------------------------------------------------
// C84
// ---------------------------------------------------------------------------

for (const version of VERSIONS) {
  test(`C84 V${version} completeDocumentWithToken out of turn is refused; s2 stays NOT_SIGNED`, async ({ request }) => {
    test.setTimeout(120_000);

    const s = await seedFixtureS(version);

    // Only the turn can stop s2: its fields are already inserted.
    await seedInserted(s, 's2', 'sig', { typed: 'S Two' });
    await seedInserted(s, 's2', 'text', { text: 'Seeded text' });

    await expectOutOfTurn(request, s, async () => await completeWithToken(request, s, s.r.s2.token), 's2 completes');

    expect((await recipientOf(s, 's2')).signingStatus, 's2 stays NOT_SIGNED').toBe(SigningStatus.NOT_SIGNED);

    // Premise: once s1 has completed the same call succeeds.
    await signAndComplete(request, s, 's1', { typed: 'S One' });
    expect2xx(await completeWithToken(request, s, s.r.s2.token), 'control: s2 completes in turn');
    expect((await recipientOf(s, 's2')).signingStatus, 'control: s2 SIGNED').toBe(SigningStatus.SIGNED);
  });
}

// ---------------------------------------------------------------------------
// C85
// ---------------------------------------------------------------------------

/** Signs, unsigns, signs again and completes, asserting each step (C85). */
const roundTrip = async (request: APIRequestContext, s: G4Seeded, key: string) => {
  const field = s.r[key].fields.sig;

  expect2xx(await signSig(request, s, key, key, `S ${key}`), `${key} signs`);
  expect2xx(await unsign(request, s, key, 'sig'), `${key} unsigns`);

  const cleared = await fieldState(field.id);

  expect(cleared.inserted, `${key}: Field.inserted false after the unsign`).toBe(false);
  expect(cleared.signatureCount, `${key}: the Signature row is gone after the unsign`).toBe(0);

  expect2xx(await signSig(request, s, key, key, `S ${key} again`), `${key} signs again`);
  expect2xx(await completeWithToken(request, s, s.r[key].token), `${key} completes`);
  expect((await recipientOf(s, key)).signingStatus, `${key} SIGNED`).toBe(SigningStatus.SIGNED);
};

for (const version of VERSIONS) {
  test(`C85 V${version} in turn: sign, unsign, sign, complete for s2 then s3; CC never blocks`, async ({ request }) => {
    test.setTimeout(240_000);

    const s = await seedFixtureS(version);

    await signAndComplete(request, s, 's1', { typed: 'S One' });
    await roundTrip(request, s, 's2');
    await roundTrip(request, s, 's3');
    await waitForEnvelopeStatus(s, DocumentStatus.COMPLETED);
  });
}

test('C85 PARALLEL copy of fixture S: s3, then s1, then s2 each sign and complete', async ({ request }) => {
  test.setTimeout(240_000);

  const s = await seedFixtureS(2, { signingOrder: 'PARALLEL' });

  for (const key of ['s3', 's1', 's2']) {
    await signAndComplete(request, s, key);
  }

  await waitForEnvelopeStatus(s, DocumentStatus.COMPLETED);
});

// ---------------------------------------------------------------------------
// C86
// ---------------------------------------------------------------------------

for (const version of VERSIONS) {
  test(`C86 V${version} assistant a1 prefills s3 TEXT only on its own turn, never s3 SIGNATURE`, async ({
    request,
  }) => {
    test.setTimeout(240_000);

    const s = await seedFixtureS(version, { assistant: true });
    const c = cases();

    const expectSignatureRefused = async (when: string) => {
      const field = s.r.s3.fields.sig;
      const before = await envelopeSnapshot(s);
      const auditBefore = (await fieldAuditRowsOf(s.envelopeId, field.secondaryId)).length;
      const reply = await signSig(request, s, 'a1', 's3', 'A1 on S3');

      expect(reply.status, `${when}: a1 on s3 SIGNATURE refused with 400: ${describeReply(reply)}`).toBe(400);

      const after = await envelopeSnapshot(s);

      expect(after.fields, `${when}: no field or Signature row changed`).toEqual(before.fields);
      expect(after.recipients, `${when}: no recipient column changed`).toEqual(before.recipients);
      expect(
        (await fieldAuditRowsOf(s.envelopeId, field.secondaryId)).length,
        `${when}: no new INSERTED, UNINSERTED or PREFILLED row for s3 SIGNATURE`,
      ).toBe(auditBefore);
    };

    await c.run('a1 prefills s3 TEXT while s1 NOT_SIGNED', async () => {
      await expectOutOfTurn(request, s, async () => await signText(request, s, 'a1', 's3'), 'a1 prefills s3 TEXT');
    });
    await c.run('a1 on s3 SIGNATURE while s1 NOT_SIGNED', async () => await expectSignatureRefused('before s1'));

    await c.premise('s1 completes', async () => await signAndComplete(request, s, 's1', { typed: 'S One' }));

    await c.run('a1 prefills s3 TEXT in turn', async () => {
      const field = s.r.s3.fields.text;

      if ((await fieldState(field.id)).inserted) {
        // Inserted out of turn above: clear it so the in-turn prefill can be observed.
        await prisma.field.update({ where: { id: field.id }, data: { inserted: false, customText: '' } });
      }

      const prefillsBefore = (await fieldAuditRowsOf(s.envelopeId, field.secondaryId, ['DOCUMENT_FIELD_PREFILLED']))
        .length;

      expect2xx(await signText(request, s, 'a1', 's3', 'Prefilled by a1'), 'a1 prefills s3 TEXT in turn');

      const state = await fieldState(field.id);

      expect(state.inserted, 's3 TEXT inserted').toBe(true);
      expect(state.customText, 's3 TEXT holds the prefilled value').toBe('Prefilled by a1');

      const prefills = await fieldAuditRowsOf(s.envelopeId, field.secondaryId, ['DOCUMENT_FIELD_PREFILLED']);

      expect(prefills.length, 'one new DOCUMENT_FIELD_PREFILLED row').toBe(prefillsBefore + 1);
      expect(auditValueOf(prefills[prefills.length - 1]), 'the PREFILLED row records the stored value').toBe(
        'Prefilled by a1',
      );
    });
    await c.run('a1 on s3 SIGNATURE after s1 completed', async () => await expectSignatureRefused('after s1'));

    await c.run('a1 completes', async () => {
      expect2xx(await completeWithToken(request, s, s.r.a1.token), 'a1 completes');
      expect((await recipientOf(s, 'a1')).signingStatus, 'a1 SIGNED').toBe(SigningStatus.SIGNED);
    });
    await c.run('a1 on s3 SIGNATURE after a1 completed', async () => await expectSignatureRefused('after a1'));

    await c.run('s3 signs its SIGNATURE', async () => {
      expect2xx(await signSig(request, s, 's3', 's3', 'S Three'), 's3 signs SIGNATURE');
    });

    c.assert(`C86 V${version}`);
  });
}

// ---------------------------------------------------------------------------
// C87
// ---------------------------------------------------------------------------

/** A tRPC query: GET with the superjson input in the query string. */
const trpcQuery = async (request: APIRequestContext, procedure: string, input: Record<string, unknown>) =>
  await send(
    async () =>
      await request.get(
        `${WEBAPP_BASE_URL}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
      ),
    procedure,
    true,
  );

const VIEW_AUDIT = ['DOCUMENT_OPENED', 'DOCUMENT_VIEWED'];

const viewRowsFor = async (s: G4Seeded, key: string) =>
  (await prisma.documentAuditLog.findMany({ where: { envelopeId: s.envelopeId, type: { in: VIEW_AUDIT } } })).filter(
    (row) => ((row.data ?? {}) as Record<string, unknown>).recipientId === s.r[key].id,
  );

const multisignUrl = (s: G4Seeded, keys: string[]) =>
  `${WEBAPP_BASE_URL}/embed/v1/multisign?${keys.map((key) => `token=${encodeURIComponent(s.r[key].token)}`).join('&')}`;

test('C87 multi-sign embed: out-of-turn token answers 403, query refused, nothing recorded as viewed', async ({
  request,
}) => {
  test.setTimeout(180_000);

  const s = await seedFixtureS(1);
  const c = cases();

  const expectS2Untouched = async (what: string) => {
    expect((await recipientOf(s, 's2')).readStatus, `${what}: s2 readStatus unchanged`).toBe('NOT_OPENED');
    expect(await viewRowsFor(s, 's2'), `${what}: no DOCUMENT_OPENED or DOCUMENT_VIEWED row for s2`).toEqual([]);
  };

  /** A refused GET writes nothing anywhere on the envelope: every recipient column and the audit count of any type. */
  const expectGetRefused = async (keys: string[]) => {
    const what = `GET ?${keys.map((key) => `token=${key}`).join('&')}`;
    const before = await envelopeSnapshot(s);
    const viewsBefore = await auditCount(s, VIEW_AUDIT);
    const res = await request.get(multisignUrl(s, keys), { maxRedirects: 0 });

    expect(res.status(), `${what}: the multi-sign embed answers 403`).toBe(403);

    const after = await envelopeSnapshot(s);

    expect(after.recipients, `${what}: no recipient column changed (readStatus included)`).toEqual(before.recipients);
    expect(after.auditCount, `${what}: no audit row of any type`).toBe(before.auditCount);
    expect(await auditCount(s, VIEW_AUDIT), `${what}: no DOCUMENT_OPENED or DOCUMENT_VIEWED row`).toBe(viewsBefore);
    await expectS2Untouched(what);
  };

  await c.run('GET ?token=s2', async () => await expectGetRefused(['s2']));

  await c.run('GET ?token=s1&token=s2', async () => await expectGetRefused(['s1', 's2']));

  await c.run('embeddingPresign.getMultiSignDocument {token: s2}', async () => {
    await expectOutOfTurn(
      request,
      s,
      async () => await trpcQuery(request, 'embeddingPresign.getMultiSignDocument', { token: s.r.s2.token }),
      'getMultiSignDocument for s2',
    );
    await expectS2Untouched('getMultiSignDocument');
  });

  // Premise: s1 alone is served, and can sign and complete through the routes the embed uses.
  await c.run('control: GET ?token=s1 and s1 signs and completes', async () => {
    const res = await request.get(multisignUrl(s, ['s1']), { maxRedirects: 0 });

    expect(res.status(), 'the multi-sign embed with s1 alone answers 200').toBe(200);
    expect2xx(
      await trpcQuery(request, 'embeddingPresign.getMultiSignDocument', { token: s.r.s1.token }),
      'getMultiSignDocument for s1 in turn',
    );
    await signAndComplete(request, s, 's1', { typed: 'S One' });
  });

  c.assert('C87');
});

// ---------------------------------------------------------------------------
// C89
// ---------------------------------------------------------------------------

const REJECTED_AUDIT = 'DOCUMENT_RECIPIENT_REJECTED';

test('C89 rejectDocumentWithToken out of turn is refused and changes nothing', async ({ request }) => {
  test.setTimeout(120_000);

  const s = await seedFixtureS(1);
  const ownerMailbox = s.owner.user.email.split('@')[0];
  const ownerMailBefore = (await readInbox(request, ownerMailbox)).length;

  await expectOutOfTurn(
    request,
    s,
    async () => await rejectWithToken(request, s, s.r.s3.token, 'out of turn'),
    's3 rejects out of turn',
  );

  expect(await envelopeStatus(s), 'the envelope stays PENDING').toBe(DocumentStatus.PENDING);

  const s3 = await recipientOf(s, 's3');

  expect(s3.signingStatus, 's3 stays NOT_SIGNED').toBe(SigningStatus.NOT_SIGNED);
  expect(s3.rejectionReason, 's3 has no rejectionReason').toBeNull();
  expect(
    await prisma.documentAuditLog.count({ where: { envelopeId: s.envelopeId, type: REJECTED_AUDIT } }),
    'no DOCUMENT_RECIPIENT_REJECTED row',
  ).toBe(0);
  expect((await readInbox(request, ownerMailbox)).length, 'no rejection or cancellation email to the owner').toBe(
    ownerMailBefore,
  );
  expect(await jobsFor(JOB.SEAL, 'documentId', s.documentId), 'no seal job').toHaveLength(0);
});

test('C89 control: s1 rejects in turn and the envelope becomes REJECTED', async ({ request }) => {
  test.setTimeout(120_000);

  const s = await seedFixtureS(1);

  expect2xx(await rejectWithToken(request, s, s.r.s1.token, 'in turn'), 's1 rejects in turn');
  await waitForEnvelopeStatus(s, DocumentStatus.REJECTED);
});

test('C89 fixture G: s2 shares s1 step and may reject while s1 is NOT_SIGNED', async ({ request }) => {
  test.setTimeout(120_000);

  const g = await seedFixtureG(1);

  expect((await recipientOf(g, 's1')).signingStatus, 'premise: s1 NOT_SIGNED').toBe(SigningStatus.NOT_SIGNED);
  expect2xx(await rejectWithToken(request, g, g.r.s2.token, 'same step'), 's2 rejects in its shared step');
  await waitForEnvelopeStatus(g, DocumentStatus.REJECTED);
});

test('C89 control: the owner rejects on behalf of s3 while s1 is NOT_SIGNED', async ({ request }) => {
  test.setTimeout(120_000);

  const s = await seedFixtureS(2);
  const reply = await rejectOnBehalf(
    request,
    { envelopeId: s.envelopeId, apiToken: s.owner.apiToken } as never,
    s.r.s3.id,
    'owner on behalf',
  );

  expect2xx(reply, 'rejectOnBehalfOf for s3');
  expect((await recipientOf(s, 's3')).signingStatus, 's3 REJECTED').toBe(SigningStatus.REJECTED);
});
