/**
 * Values already stored: the seal must not crash on them (G4 spec D2).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md,
 * section 7, D2) before any fix, without reading the seal handler or the field
 * insertion code. Each envelope is seeded through Prisma with every field
 * inserted: s1 SIGNED holding the stored Signature row under test, s2 holding a
 * typed signature. s2 then completes (or rejects) through the recipient route,
 * which queues the seal job the way production does; the local job provider runs
 * it through the server's job endpoint. Assertions read the envelope, its item's
 * documentData, the BackgroundJob rows, the audit log, the webhook receiver, the
 * Inbucket mailboxes and the owner's audit log page.
 *
 * | Criterion | Test                                                                                   |
 * | --------- | -------------------------------------------------------------------------------------- |
 * | C58       | C58 V2 stored F02 junk image: the seal stops, PENDING, one audit entry, no retry         |
 * | C58       | C58 V2 stored junk image, then the other signer rejects: still PENDING, one entry        |
 * | C58b      | C58b V1/V2: junk row plus a rejection sends no cancellation email; control with a valid row |
 * | C59       | C59 the sweep and a manual reseal leave the C58 state, one entry (V2)                    |
 * | C59       | C59 V1, useLegacyFieldInsertion false / true: C58, sweep and reseal                      |
 * | C60       | C60 V1 JPEG bytes under the PNG prefix seal with the image drawn; the row is unchanged   |
 * | C61       | C61 a stored valid PNG seals as today (V1 and V2); also the premise for C58-C60          |
 * | C62       | C62 a stored SVG declaring 100000 x 100000 seals at the bound or stops; server stays up  |
 * | C100      | C100 V1/V2 a stored PNG sharp reads but pdf-lib's embedPng refuses seals with ink drawn  |
 * | C104b     | C104b V1/V2 a stored payload that decodes to nothing stops the seal with one entry        |
 *
 * The spec does not name the audit type of the "could not be rendered" entry.
 * An entry counts when it is written after the seal was triggered, is not a
 * field insert/uninsert/prefill row, and its data names both the field (id or
 * secondaryId) and its recipient (id or email).
 *
 * Webhooks are read from the WebhookCall rows of the owner's team (the
 * server's delivery attempts) as well as the local receiver: on this stack the
 * server's calls to the 127.0.0.1 receiver record responseCode 0, so the
 * receiver alone would make the "no webhook" checks vacuous. C61 is the control
 * that a DOCUMENT_COMPLETED call row is written when an envelope seals.
 *
 * C62 is in its own describe at the end and can be run alone; it can take the
 * shared server down if the decoder allocates the declared raster.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PDFDocument } from '@cantoo/pdf-lib';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, SigningStatus } from '@prisma/client';
import sharp from 'sharp';
import {
  JOB,
  jobsFor,
  keepRecord,
  pause,
  type Receiver,
  registerWebhook,
  runJob,
  startReceiver,
} from '../fixtures/reject-seal';
import {
  API_V2,
  completeWithToken,
  expect2xx,
  type G4Seeded,
  imageBytes,
  P,
  readInbox,
  rejectWithToken,
  seedG4Envelope,
  seedSession,
  serverPid,
  validInkedDataUrl,
} from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

/** F02's value: the PNG prefix around the text "not-an-image". */
const F02_JUNK = `${P}bm90LWFuLWltYWdl`;

const SWEEP_JOB = 'internal.seal-document-sweep';
const REJECTION_EMAILS_JOB = 'send.signing.rejected.emails';
const FIELD_ROW_TYPES = ['DOCUMENT_FIELD_INSERTED', 'DOCUMENT_FIELD_UNINSERTED', 'DOCUMENT_FIELD_PREFILLED'];

/**
 * Audit types that exist today and are not the new "could not be rendered" entry, though their data can
 * name the field's recipient: excluded so that only a new kind of row is counted.
 */
const KNOWN_NON_RENDER_TYPES = [
  ...FIELD_ROW_TYPES,
  'DOCUMENT_COMPLETED',
  'DOCUMENT_RECIPIENT_COMPLETED',
  'DOCUMENT_RECIPIENT_REJECTED',
  'DOCUMENT_OPENED',
  'DOCUMENT_VIEWED',
  'DOCUMENT_SENT',
  'EMAIL_SENT',
  'DOCUMENT_ACCESS_AUTH_2FA_REQUESTED',
];

/** How long the "nothing more happens" checks wait for a retry, email or webhook. */
const QUIET_MS = 8_000;

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

type Stored = G4Seeded & { since: Date; dataIdBefore: string; dataHashBefore: string; receiver: Receiver };

const sha256 = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');

/** The hash of the bytes the envelope item's document data holds. */
const itemDataHash = async (itemId: string) => {
  const item = await prisma.envelopeItem.findUniqueOrThrow({ where: { id: itemId }, include: { documentData: true } });

  return sha256(`${item.documentData.type}:${item.documentData.data}`);
};

/**
 * s1 SIGNED with `stored` in its SIGNATURE field's Signature row; s2 with its
 * field inserted as a typed signature (unless it is going to reject), not yet
 * SIGNED. The owner's team has a webhook on the receiver.
 */
const seedStored = async (
  receiver: Receiver,
  internalVersion: 1 | 2,
  stored: string,
  options: { legacy?: boolean; s2Rejects?: boolean; withS3?: boolean } = {},
): Promise<Stored> => {
  const seeded = await seedG4Envelope({
    internalVersion,
    recipients: [
      {
        key: 's1',
        signingOrder: 1,
        signingStatus: SigningStatus.SIGNED,
        fields: [{ key: 'sig', type: FieldType.SIGNATURE, inserted: true }],
      },
      {
        key: 's2',
        signingOrder: 2,
        fields: [{ key: 'sig', type: FieldType.SIGNATURE, inserted: !options.s2Rejects }],
      },
      // C58b: a third recipient who has not acted, so a cancellation email has someone to reach.
      ...(options.withS3
        ? [{ key: 's3', signingOrder: 3, fields: [{ key: 'sig', type: FieldType.SIGNATURE, inserted: false }] }]
        : []),
    ],
  });

  await prisma.signature.create({
    data: { fieldId: seeded.r.s1.fields.sig.id, recipientId: seeded.r.s1.id, signatureImageAsBase64: stored },
  });

  if (!options.s2Rejects) {
    await prisma.signature.create({
      data: { fieldId: seeded.r.s2.fields.sig.id, recipientId: seeded.r.s2.id, typedSignature: 'G4 s2' },
    });
  }

  if (options.legacy !== undefined) {
    await prisma.envelope.update({
      where: { id: seeded.envelopeId },
      data: { useLegacyFieldInsertion: options.legacy },
    });
  }

  await registerWebhook(receiver, seeded.owner.user.id, seeded.owner.team.id);

  const item = await prisma.envelopeItem.findUniqueOrThrow({ where: { id: seeded.itemId } });
  const dataHashBefore = await itemDataHash(seeded.itemId);

  return { ...seeded, since: new Date(), dataIdBefore: item.documentDataId, dataHashBefore, receiver };
};

/** s2 finishes: completion queues the seal; rejection queues the rejection seal. */
const finish = async (request: APIRequestContext, seeded: Stored, how: 'complete' | 'reject') => {
  const reply =
    how === 'complete'
      ? await completeWithToken(request, seeded, seeded.r.s2.token)
      : await rejectWithToken(request, seeded, seeded.r.s2.token, 'G4 D2 rejection');

  expect2xx(reply, `premise: s2's ${how} is accepted`);
};

const sealJobs = async (seeded: G4Seeded) => await jobsFor(JOB.SEAL, 'documentId', seeded.documentId);

/** Waits until at least `count` seal jobs exist and none is pending or running, then the quiet window. */
const waitForSealSettled = async (seeded: G4Seeded, count = 1, timeout = 120_000) => {
  await expect
    .poll(
      async () => {
        const jobs = await sealJobs(seeded);

        return jobs.length >= count && jobs.every((job) => job.status === 'COMPLETED' || job.status === 'FAILED');
      },
      { message: `seal jobs of ${seeded.envelopeId} should settle`, timeout },
    )
    .toBe(true);

  await pause(QUIET_MS);
};

// ---------------------------------------------------------------------------
// Observing
// ---------------------------------------------------------------------------

/** Audit rows since the trigger that name the field and its recipient, other than field rows. */
const renderEntries = async (seeded: Stored) => {
  const field = seeded.r.s1.fields.sig;
  const recipient = seeded.r.s1;
  const rows = await prisma.documentAuditLog.findMany({
    where: {
      envelopeId: seeded.envelopeId,
      createdAt: { gte: seeded.since },
      type: { notIn: KNOWN_NON_RENDER_TYPES },
    },
    orderBy: { createdAt: 'asc' },
  });

  return rows.filter((row) => {
    const text = JSON.stringify(row.data ?? {});
    const namesField = text.includes(field.secondaryId) || new RegExp(`"fieldId":\\s*${field.id}\\b`).test(text);
    const namesRecipient =
      text.includes(recipient.email) || new RegExp(`"recipientId":\\s*${recipient.id}\\b`).test(text);

    return namesField && namesRecipient;
  });
};

const mailSubjects = async (request: APIRequestContext, seeded: G4Seeded) => {
  const boxes: Record<string, string> = {
    owner: seeded.owner.user.email.split('@')[0],
    s1: seeded.r.s1.mailbox,
    s2: seeded.r.s2.mailbox,
  };
  const subjects: Record<string, string[]> = {};

  for (const [key, mailbox] of Object.entries(boxes)) {
    subjects[key] = (await readInbox(request, mailbox)).map((message) => message.subject);
  }

  return subjects;
};

const observe = async (request: APIRequestContext, seeded: Stored) => {
  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } });
  const item = await prisma.envelopeItem.findUniqueOrThrow({ where: { id: seeded.itemId } });
  const jobs = await sealJobs(seeded);
  const s1Field = await prisma.field.findUniqueOrThrow({
    where: { id: seeded.r.s1.fields.sig.id },
    include: { signature: true },
  });

  return {
    envelopeId: seeded.envelopeId,
    status: envelope.status,
    completedAt: envelope.completedAt,
    documentDataUnchanged: item.documentDataId === seeded.dataIdBefore,
    documentDataHashUnchanged: (await itemDataHash(seeded.itemId)) === seeded.dataHashBefore,
    // DocumentData rows written since the trigger for this owner's user or team: a sealed PDF would be one of
    // these, since the seal writes its row with the envelope's team (seal-document.handler.ts, `owner`). Rows
    // with no owner are not counted: parallel workers write them, and none belongs to this envelope.
    newDocumentDataRows: await prisma.documentData.count({
      where: {
        createdAt: { gte: seeded.since },
        OR: [{ userId: seeded.owner.user.id }, { teamId: seeded.owner.team.id }],
      },
    }),
    // Recorded: BackgroundJob rows exist only under the local job provider, which is the one that writes
    // `retried`. waitForSealSettled already requires a seal job row, so the no-retry check is not vacuous.
    jobsProvider: process.env.NEXT_PRIVATE_JOBS_PROVIDER ?? '(unset: local)',
    sealJobs: jobs.map((job) => ({ id: job.id, status: job.status, retried: job.retried, payload: job.payload })),
    renderEntries: (await renderEntries(seeded)).map((row) => ({ type: row.type, data: row.data })),
    completedAudit: await prisma.documentAuditLog.count({
      where: { envelopeId: seeded.envelopeId, type: 'DOCUMENT_COMPLETED' },
    }),
    completionEmailJobs: (await jobsFor(JOB.COMPLETED_EMAILS, 'envelopeId', seeded.envelopeId)).length,
    rejectionEmailJobs: (await jobsFor(REJECTION_EMAILS_JOB, 'documentId', seeded.documentId)).length,
    // Attempts the server made, whether or not the receiver could be reached (on this stack the
    // calls to 127.0.0.1 record responseCode 0, so the receiver's own count is not used).
    webhooks: [
      ...seeded.receiver.eventsFor(seeded.envelopeId),
      ...(
        await prisma.webhookCall.findMany({
          where: { webhook: { teamId: seeded.owner.team.id } },
          select: { event: true },
        })
      ).map((call) => call.event as string),
    ],
    mail: await mailSubjects(request, seeded),
    storedRowUnchanged: s1Field.signature?.signatureImageAsBase64,
  };
};

type Observed = Awaited<ReturnType<typeof observe>>;

const allSubjects = (observed: Observed) => Object.values(observed.mail).flat();

/**
 * The C58 outcome: PENDING, nothing sealed, no completion (or rejection) email
 * or webhook, the seal job ran once and was not retried, exactly one audit
 * entry naming the field and its recipient.
 */
const expectStopped = (
  observed: Observed,
  what: string,
  options: { expectedJobs?: number; allowRejectedWebhook?: boolean } = {},
) => {
  expect.soft(observed.status, `${what}: the envelope stays PENDING`).toBe(DocumentStatus.PENDING);
  expect.soft(observed.completedAt, `${what}: no completedAt`).toBeNull();
  expect
    .soft(observed.documentDataUnchanged, `${what}: the item's document data is unchanged (no sealed PDF)`)
    .toBe(true);
  expect.soft(observed.documentDataHashUnchanged, `${what}: the item's document bytes are unchanged`).toBe(true);
  expect
    .soft(observed.newDocumentDataRows, `${what}: no DocumentData row written (no sealed PDF or certificate)`)
    .toBe(0);
  expect.soft(observed.completedAudit, `${what}: no DOCUMENT_COMPLETED audit row`).toBe(0);
  expect.soft(observed.completionEmailJobs, `${what}: no completion email job`).toBe(0);
  expect.soft(observed.rejectionEmailJobs, `${what}: no rejection email job`).toBe(0);
  expect
    .soft(
      allSubjects(observed).filter((subject) => /complete|reject/i.test(subject)),
      `${what}: no completion or rejection email in Inbucket`,
    )
    .toEqual([]);
  expect
    .soft(
      observed.webhooks.filter(
        (event) => event === 'DOCUMENT_COMPLETED' || (!options.allowRejectedWebhook && event === 'DOCUMENT_REJECTED'),
      ),
      `${what}: no DOCUMENT_COMPLETED${options.allowRejectedWebhook ? '' : ' or DOCUMENT_REJECTED'} webhook`,
    )
    .toEqual([]);
  expect
    .soft(
      observed.sealJobs.map((job) => job.retried),
      `${what}: ${options.expectedJobs ?? 1} seal job(s), none retried`,
    )
    .toEqual(new Array(options.expectedJobs ?? 1).fill(0));
  expect.soft(observed.renderEntries.length, `${what}: exactly one audit entry for the undecodable field`).toBe(1);
};

/** The owner, signed in, sees the entry on the audit log page. */
const expectEntryOnAuditPage = async (page: import('@playwright/test').Page, seeded: Stored, what: string) => {
  await seedSession(page.context(), seeded.owner.user.id);
  await page.goto(`/t/${seeded.owner.team.url}/documents/${seeded.envelopeId}/logs`);

  await expect(page.getByText(seeded.title).first(), `premise: ${what}: the audit log page loads`).toBeVisible();

  // The entry itself: the one log row (table row or list item) carrying the "could not be rendered" text.
  const entryRows = page
    .locator('tr, [role="row"], li')
    .filter({ hasText: /could not be rendered|cannot be rendered|could not render/i });

  await expect
    .soft(entryRows, `${what}: the audit log page shows exactly one "could not be rendered" entry`)
    .toHaveCount(1, { timeout: 5_000 });

  const entryText = (await entryRows.count()) === 1 ? await entryRows.first().innerText() : '';

  expect
    .soft(
      entryText.includes(seeded.r.s1.email) || entryText.includes(seeded.r.s1.name),
      `${what}: that entry names the recipient (${entryText.slice(0, 200)})`,
    )
    .toBe(true);

  // Leave the logs page: in earlier runs the test hung for the full 60 s fixture teardown after this page.
  await page.goto('about:blank');
};

// ---------------------------------------------------------------------------
// Reading the sealed PDF
// ---------------------------------------------------------------------------

const EXAMPLE_PDF = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

const download = async (request: APIRequestContext, seeded: G4Seeded, version: 'signed') => {
  const res = await request.get(`${API_V2}/envelope/item/${seeded.itemId}/download?version=${version}`, {
    headers: { Authorization: `Bearer ${seeded.owner.apiToken}` },
  });

  expect(res.status(), `download ?version=${version}`).toBe(200);

  return await res.body();
};

/** Grey pixels of the field's rectangle on page 1 at 72 dpi. */
const renderBox = (pdf: Buffer, box: { x: number; y: number; w: number; h: number }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-seal-'));
  const file = path.join(dir, 'doc.pdf');

  fs.writeFileSync(file, pdf);

  const info = spawnSync('pdfinfo', [file], { encoding: 'utf8' }).stdout;
  const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(info);

  if (!size) {
    throw new Error(`pdfinfo gave no page size: ${info}`);
  }

  const [pw, ph] = [Number(size[1]), Number(size[2])];
  const args = ['-f', '1', '-l', '1', '-r', '72', '-gray'];
  const crop = [
    ['-x', Math.round((box.x / 100) * pw)],
    ['-y', Math.round((box.y / 100) * ph)],
    ['-W', Math.round((box.w / 100) * pw)],
    ['-H', Math.round((box.h / 100) * ph)],
  ].flatMap(([flag, value]) => [String(flag), String(value)]);
  const result = spawnSync('pdftoppm', [...args, ...crop, file], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });

  fs.unlinkSync(file);
  fs.rmdirSync(dir);

  if (result.status !== 0) {
    throw new Error(`pdftoppm failed: ${result.stderr.toString()}`);
  }

  const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(result.stdout.subarray(0, 32).toString('latin1'));

  if (!header) {
    throw new Error('pdftoppm did not write a binary PGM');
  }

  return result.stdout.subarray(header[0].length);
};

/** Share of the s1 field's rectangle at least 40 grey levels darker in the sealed PDF than in the original. */
const drawnShare = async (request: APIRequestContext, seeded: G4Seeded) => {
  const field = await prisma.field.findUniqueOrThrow({ where: { id: seeded.r.s1.fields.sig.id } });
  const box = {
    x: Number(field.positionX),
    y: Number(field.positionY),
    w: Number(field.width),
    h: Number(field.height),
  };
  // The seeded item carries assets/example.pdf; the original-version download answers 404 for it.
  const original = renderBox(EXAMPLE_PDF, box);
  const sealed = renderBox(await download(request, seeded, 'signed'), box);
  let darker = 0;

  for (let i = 0; i < Math.min(original.length, sealed.length); i++) {
    if (original[i] - sealed[i] >= 40) {
      darker++;
    }
  }

  return darker / sealed.length;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let receiver: Receiver;

test.beforeAll(async () => {
  receiver = await startReceiver();
});

test.afterAll(async () => {
  await receiver.close();
});

test('C61 a stored valid PNG seals as today on V1 and V2 (and the premise for C58-C60)', async ({ request }) => {
  test.setTimeout(240_000);

  for (const version of [1, 2] as const) {
    const seeded = await seedStored(receiver, version, validInkedDataUrl());

    await finish(request, seeded, 'complete');
    await waitForSealSettled(seeded);

    const observed = await observe(request, seeded);
    const share = observed.status === DocumentStatus.COMPLETED ? await drawnShare(request, seeded) : 0;

    await keepRecord(`C61-v${version}.json`, { ...observed, drawnShare: share });

    expect.soft(observed.status, `V${version}: COMPLETED`).toBe(DocumentStatus.COMPLETED);
    expect.soft(observed.documentDataUnchanged, `V${version}: the item points at a sealed copy`).toBe(false);
    expect.soft(observed.completedAudit, `V${version}: one DOCUMENT_COMPLETED row`).toBe(1);
    expect.soft(observed.completionEmailJobs, `V${version}: the completion email job ran`).toBeGreaterThan(0);
    expect
      .soft(
        allSubjects(observed).some((subject) => /complete/i.test(subject)),
        `V${version}: a completion email reached Inbucket (premise for the no-email checks)`,
      )
      .toBe(true);
    expect
      .soft(observed.webhooks, `V${version}: the DOCUMENT_COMPLETED webhook fired (a WebhookCall row)`)
      .toContain('DOCUMENT_COMPLETED');
    expect
      .soft(
        observed.sealJobs.map((job) => job.retried),
        `V${version}: one seal job, not retried`,
      )
      .toEqual([0]);
    expect.soft(observed.renderEntries, `V${version}: no "could not be rendered" entry`).toEqual([]);
    expect.soft(share, `V${version}: the signature is drawn in its field (at least 1% darker)`).toBeGreaterThan(0.01);
  }
});

test('C58 V2 stored F02 junk image: the seal stops, PENDING, one audit entry, no retry', async ({ request, page }) => {
  test.setTimeout(240_000);

  const seeded = await seedStored(receiver, 2, F02_JUNK);

  await finish(request, seeded, 'complete');
  await waitForSealSettled(seeded);

  const observed = await observe(request, seeded);

  await keepRecord('C58-v2-complete.json', observed);

  expect(observed.storedRowUnchanged, 'the stored row is left as it was').toBe(F02_JUNK);
  expectStopped(observed, 'C58 V2');
  await expectEntryOnAuditPage(page, seeded, 'C58 V2');
});

test('C58 V2 stored junk image, then the other signer rejects: still PENDING, one entry', async ({ request, page }) => {
  test.setTimeout(240_000);

  const seeded = await seedStored(receiver, 2, F02_JUNK, { s2Rejects: true });

  await finish(request, seeded, 'reject');
  await waitForSealSettled(seeded);

  const observed = await observe(request, seeded);

  await keepRecord('C58-v2-reject.json', observed);

  // The spec asks for no rejection PDF or rejection email; a DOCUMENT_REJECTED webhook from the reject route
  // itself is not excluded by it, so it is recorded (observed.webhooks) rather than refused.
  expectStopped(observed, 'C58 V2 rejection', { allowRejectedWebhook: true });
  await expectEntryOnAuditPage(page, seeded, 'C58 V2 rejection');
});

// ---------------------------------------------------------------------------
// C58b (spec, "Amendments after implementation area D")
// ---------------------------------------------------------------------------

/** "Document Cancelled" emails in the other recipients' mailboxes (s1 and s3; s2 is the rejecter). */
const cancelledMail = async (request: APIRequestContext, seeded: Stored) => {
  // The English catalogue renders "Cancelled" as "Canceled"; accept either.
  const isCancelled = (subject: string) => /cancell?ed/i.test(subject);
  const mail: Record<string, string[]> = {};

  for (const key of ['s1', 's3']) {
    mail[key] = (await readInbox(request, seeded.r[key].mailbox)).map((message) => message.subject).filter(isCancelled);
  }

  return mail;
};

/** Cancellation email jobs whose payload names the envelope (by envelope id or document id). */
const cancelJobsFor = async (seeded: Stored) =>
  (await prisma.backgroundJob.findMany({ where: { jobId: JOB.CANCELLED_EMAILS } })).filter((job) => {
    const text = JSON.stringify(job.payload ?? {});

    return text.includes(seeded.envelopeId) || new RegExp(`"documentId":\\s*${seeded.documentId}\\b`).test(text);
  }).length;

for (const version of [1, 2] as const) {
  test(`C58b V${version}: a junk stored row plus a rejection sends no cancellation email; one audit entry`, async ({
    request,
    page,
  }) => {
    test.setTimeout(360_000);

    // Control: the same rejection with a valid stored row sends the cancellation email as today.
    const control = await seedStored(receiver, version, validInkedDataUrl(), { s2Rejects: true, withS3: true });

    await finish(request, control, 'reject');
    await waitForSealSettled(control);

    const controlMail = await cancelledMail(request, control);
    const controlStatus = (await prisma.envelope.findUniqueOrThrow({ where: { id: control.envelopeId } })).status;
    const controlCancelJobs = await cancelJobsFor(control);

    await keepRecord(`C58b-v${version}-control.json`, { controlStatus, controlMail, controlCancelJobs });

    expect(controlStatus, `premise: V${version} control: the rejection with a valid row seals REJECTED`).toBe(
      DocumentStatus.REJECTED,
    );
    expect(
      Object.values(controlMail).flat().length,
      `premise: V${version} control: a cancellation email reaches another recipient`,
    ).toBeGreaterThan(0);
    expect(
      controlCancelJobs,
      `premise: V${version} control: a cancellation email job names the envelope`,
    ).toBeGreaterThan(0);

    // The case: a junk stored row, then the same rejection.
    const seeded = await seedStored(receiver, version, F02_JUNK, { s2Rejects: true, withS3: true });

    await finish(request, seeded, 'reject');
    await waitForSealSettled(seeded);

    const observed = await observe(request, seeded);
    const mail = await cancelledMail(request, seeded);
    const cancelJobs = await cancelJobsFor(seeded);

    await keepRecord(`C58b-v${version}.json`, { ...observed, cancelledMail: mail, cancelJobs });

    expect.soft(observed.status, `C58b V${version}: the envelope stays PENDING`).toBe(DocumentStatus.PENDING);
    expect.soft(mail, `C58b V${version}: no cancellation email reaches s1 or s3`).toEqual({ s1: [], s3: [] });
    expect.soft(cancelJobs, `C58b V${version}: no cancellation email job`).toBe(0);
    expect
      .soft(observed.renderEntries.length, `C58b V${version}: exactly one audit entry for the undecodable field`)
      .toBe(1);
    await expectEntryOnAuditPage(page, seeded, `C58b V${version}`);
  });
}

/** C58 on `seeded`, then the sweep and a manual reseal: still the C58 state with one entry. */
const sweepAndReseal = async (request: APIRequestContext, seeded: Stored, label: string) => {
  await finish(request, seeded, 'complete');
  await waitForSealSettled(seeded);

  const first = await observe(request, seeded);

  await keepRecord(`${label}-after-completion.json`, first);
  expectStopped(first, `${label} after completion`);

  // Put the last action an hour back, inside the sweep's 15 minute to 6 hour window.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  await prisma.recipient.updateMany({ where: { envelopeId: seeded.envelopeId }, data: { signedAt: hourAgo } });

  const jobsBeforeSweep = (await sealJobs(seeded)).length;
  const sweep = await runJob(SWEEP_JOB, 'Seal Document Sweep', {});

  expect(sweep.status, `premise: ${label}: the sweep job endpoint answers ${sweep.body.slice(0, 200)}`).toBeLessThan(
    500,
  );

  // Either the sweep re-queues a seal that stops again, or it skips the envelope (a fix may mark it as not
  // sealable); both leave it as C58 left it.
  const requeued = await expect
    .poll(async () => (await sealJobs(seeded)).length, { timeout: 30_000 })
    .toBeGreaterThan(jobsBeforeSweep)
    .then(() => true)
    .catch(() => false);

  if (requeued) {
    await waitForSealSettled(seeded, jobsBeforeSweep + 1);
  } else {
    await pause(QUIET_MS);
  }

  const afterSweep = await observe(request, seeded);

  await keepRecord(`${label}-after-sweep.json`, { requeued, ...afterSweep });
  expectStopped(afterSweep, `${label} after the sweep`, { expectedJobs: jobsBeforeSweep + (requeued ? 1 : 0) });

  const jobsBeforeReseal = (await sealJobs(seeded)).length;
  const reseal = await runJob(JOB.SEAL, 'Seal Document', { documentId: seeded.documentId, isResealing: true });

  await keepRecord(`${label}-reseal-reply.json`, { status: reseal.status, body: reseal.body.slice(0, 400) });
  await waitForSealSettled(seeded, jobsBeforeReseal + 1);

  const afterReseal = await observe(request, seeded);

  await keepRecord(`${label}-after-reseal.json`, afterReseal);
  expectStopped(afterReseal, `${label} after a manual reseal`, { expectedJobs: jobsBeforeReseal + 1 });
};

test('C59 the sweep and a manual reseal leave the C58 state, one entry (V2)', async ({ request }) => {
  test.setTimeout(360_000);

  await sweepAndReseal(request, await seedStored(receiver, 2, F02_JUNK), 'C59-v2');
});

for (const legacy of [false, true]) {
  test(`C59 V1, useLegacyFieldInsertion ${legacy}: C58, sweep and reseal`, async ({ request }) => {
    test.setTimeout(360_000);

    await sweepAndReseal(request, await seedStored(receiver, 1, F02_JUNK, { legacy }), `C59-v1-legacy-${legacy}`);
  });
}

test('C60 V1 JPEG bytes under the PNG prefix seal with the image drawn; the row is unchanged', async ({ request }) => {
  test.setTimeout(240_000);

  const jpegUnderPng = `${P}${imageBytes('jpeg-bytes').toString('base64')}`;
  const seeded = await seedStored(receiver, 1, jpegUnderPng);

  await finish(request, seeded, 'complete');
  await waitForSealSettled(seeded);

  const observed = await observe(request, seeded);
  const share = observed.status === DocumentStatus.COMPLETED ? await drawnShare(request, seeded) : 0;

  await keepRecord('C60-v1-jpeg.json', { ...observed, storedRowUnchanged: undefined, drawnShare: share });

  expect.soft(observed.status, 'the envelope seals (COMPLETED)').toBe(DocumentStatus.COMPLETED);
  expect
    .soft(
      observed.sealJobs.map((job) => job.retried),
      'one seal job, not retried',
    )
    .toEqual([0]);
  expect.soft(share, 'the JPEG is drawn in its field (at least 1% darker than the original)').toBeGreaterThan(0.01);
  expect.soft(observed.storedRowUnchanged === jpegUnderPng, 'the stored row is unchanged').toBe(true);
  expect.soft(observed.renderEntries, 'no "could not be rendered" entry').toEqual([]);
});

// ---------------------------------------------------------------------------
// C100 (spec, "Round after Codex r1")
// ---------------------------------------------------------------------------

/**
 * The committed inked fixture with one space inserted 8 characters into its base64 payload. Node's decoder (and so
 * sharp) skips the space; pdf-lib's decoder does not, and the PNG signature it then reads is wrong.
 */
const embedPngRefusedValue = () => {
  const payload = validInkedDataUrl().slice(P.length);

  return `${P}${payload.slice(0, 8)} ${payload.slice(8)}`;
};

/** The premise of C100, proved by the test itself: sharp reads the value, pdf-lib's embedPng refuses it. */
const expectSharpReadsAndEmbedPngRefuses = async (value: string) => {
  const metadata = await sharp(Buffer.from(value.slice(P.length), 'base64')).metadata();

  expect(
    `${metadata.format} ${metadata.width}x${metadata.height}`,
    'premise: sharp reads the value as the fixture',
  ).toBe('png 400x175');

  const embedded = await (async () => {
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(value);

    doc.addPage().drawImage(image);
    await doc.save();
  })().then(
    () => 'embedded',
    () => 'refused',
  );

  expect(embedded, "premise: pdf-lib's embedPng refuses the stored string as it is").toBe('refused');

  const original = await (async () => {
    const doc = await PDFDocument.create();

    doc.addPage().drawImage(await doc.embedPng(validInkedDataUrl()));
    await doc.save();
  })().then(
    () => 'embedded',
    () => 'refused',
  );

  expect(original, "premise: embedPng takes the fixture's own data URL, so only the space differs").toBe('embedded');
};

for (const version of [1, 2] as const) {
  test(`C100 V${version}: a stored PNG that sharp reads and pdf-lib's embedPng refuses seals with the signature drawn`, async ({
    request,
  }) => {
    test.setTimeout(240_000);

    const stored = embedPngRefusedValue();

    await expectSharpReadsAndEmbedPngRefuses(stored);

    const seeded = await seedStored(receiver, version, stored);

    await finish(request, seeded, 'complete');
    await waitForSealSettled(seeded);

    const observed = await observe(request, seeded);
    const share = observed.status === DocumentStatus.COMPLETED ? await drawnShare(request, seeded) : 0;

    await keepRecord(`C100-v${version}.json`, { ...observed, storedRowUnchanged: undefined, drawnShare: share });

    expect.soft(observed.status, `V${version}: the envelope seals (COMPLETED)`).toBe(DocumentStatus.COMPLETED);
    expect
      .soft(
        observed.sealJobs.map((job) => job.retried),
        `V${version}: one seal job, not retried`,
      )
      .toEqual([0]);
    expect.soft(observed.completedAudit, `V${version}: one DOCUMENT_COMPLETED row`).toBe(1);
    expect.soft(observed.renderEntries, `V${version}: no "could not be rendered" entry`).toEqual([]);
    expect
      .soft(share, `V${version}: the signature is drawn in its field (ink: at least 1% darker than the original)`)
      .toBeGreaterThan(0.01);
    expect.soft(observed.storedRowUnchanged === stored, `V${version}: the stored row is unchanged`).toBe(true);
  });
}

/** C104b: stored values whose payload decodes to an empty buffer (spec, "Round after Codex r3"). */
const EMPTY_PAYLOADS = [
  { key: 'bangs', label: 'the payload "!!!!"', value: `${P}!!!!` },
  { key: 'prefix-only', label: 'the prefix alone', value: P },
];

for (const version of [1, 2] as const) {
  for (const empty of EMPTY_PAYLOADS) {
    test(`C104b V${version}: ${empty.label}, which decodes to nothing, stops the seal with one UNRENDERABLE entry`, async ({
      request,
    }) => {
      test.setTimeout(240_000);

      expect(
        Buffer.from(empty.value.slice(P.length), 'base64').length,
        'premise: the payload decodes to an empty buffer',
      ).toBe(0);

      const seeded = await seedStored(receiver, version, empty.value);

      await finish(request, seeded, 'complete');
      await waitForSealSettled(seeded);

      const observed = await observe(request, seeded);

      await keepRecord(`C104b-v${version}-${empty.key}.json`, observed);

      expectStopped(observed, `C104b V${version} ${empty.key}`);
      expect
        .soft(
          observed.renderEntries.map((entry) => entry.type),
          `C104b V${version} ${empty.key}: the entry is DOCUMENT_SIGNATURE_IMAGE_UNRENDERABLE`,
        )
        .toEqual(['DOCUMENT_SIGNATURE_IMAGE_UNRENDERABLE']);
      expect
        .soft(observed.storedRowUnchanged, `C104b V${version} ${empty.key}: the stored row is unchanged`)
        .toBe(empty.value);
    });
  }
}

test.describe('C62 last: a stored SVG declaring 100000 x 100000', () => {
  /** Black square on a 100 x 100 view box, declared 100000 x 100000. */
  const SVG_HUGE = `${P}${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000" viewBox="0 0 100 100">' +
      '<rect x="10" y="10" width="80" height="80" fill="black"/></svg>',
  ).toString('base64')}`;

  for (const version of [1, 2] as const) {
    test(`C62 V${version} seals with the image at the bound or stops as C58; the server stays up`, async ({
      request,
    }) => {
      test.setTimeout(300_000);

      const pidBefore = await serverPid();
      const rssKb = (pid: unknown) => {
        try {
          return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
        } catch {
          return null;
        }
      };
      const rssBefore = rssKb(pidBefore);

      expect(pidBefore, 'premise: the server PID is readable').toBeTruthy();

      const seeded = await seedStored(receiver, version, SVG_HUGE);
      const startedAt = Date.now();

      await finish(request, seeded, 'complete');

      let settled = true;

      try {
        await waitForSealSettled(seeded, 1, 180_000);
      } catch {
        settled = false;
      }

      const elapsedMs = Date.now() - startedAt;
      const pidAfter = await serverPid();
      const rssAfter = pidAfter ? rssKb(pidAfter) : null;
      const observed = pidAfter ? await observe(request, seeded) : null;
      const share = observed?.status === DocumentStatus.COMPLETED ? await drawnShare(request, seeded) : null;

      await keepRecord(`C62-v${version}.json`, {
        settled,
        elapsedMs,
        serverUpBefore: Boolean(pidBefore),
        serverSamePid: pidBefore === pidAfter,
        // Recorded only: resident memory of the listening server process, in KiB.
        rssKbBefore: rssBefore,
        rssKbAfter: rssAfter,
        drawnShare: share,
        observed: observed ? { ...observed, storedRowUnchanged: undefined } : null,
      });

      expect(pidAfter, 'the server is still listening').toBeTruthy();
      expect(pidAfter === pidBefore, 'the server PID is unchanged (no crash or restart)').toBe(true);
      expect(settled, 'the seal job finishes within 180 s').toBe(true);

      if (!observed) {
        return;
      }

      if (observed.status === DocumentStatus.COMPLETED) {
        expect.soft(share ?? 0, 'sealed: the image is drawn in its field').toBeGreaterThan(0.01);
        expect
          .soft(
            observed.sealJobs.map((job) => job.retried),
            'one seal job, not retried',
          )
          .toEqual([0]);
      } else {
        expectStopped(observed, `C62 V${version} stopped`);
      }
    });
  }
});
