import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';
import { nanoid } from 'nanoid';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * G4 C34, strengthened (spec, "Round after Codex r1"): signup refuses every signature value C33 refuses, not only
 * the transparent PNG, and an empty or absent signature still signs up. Written from the G4 specification without
 * reading createUser beyond its options. The E2E signup is rate-limited (3 per IP per 3 hours), so the refusal
 * matrix runs here through createUser, the function the signup route stores the user with (spec 1.2,
 * create-user.ts:30-35); saved-signature.spec.ts keeps one E2E signup case.
 *
 * Failure modes:
 * 1. A value C1-C8 refuses is stored as the new user's signature (only some kinds are checked).
 * 2. The refusal is a plain Error rather than AppError INVALID_REQUEST, so the route would answer 500.
 * 3. A refused signup still creates the user (the check runs after the insert).
 * 4. An empty or absent signature is refused (over-refusal), or a valid one is.
 *
 * Seam: the real function against the real database of the local stack (the worktree's .env), nothing mocked.
 * With no database configured the suite is skipped and says so; with one configured but unreachable it fails.
 * The refusal list is C33's (saved-signature.spec.ts REFUSED_VALUES), built from the committed fixtures.
 */
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

const hasDatabase = Boolean(process.env.NEXT_PRIVATE_DATABASE_URL);

const P = 'data:image/png;base64,';
const FIXTURES = path.join(__dirname, '../../../app-tests/e2e/fixtures/signature-ink');

const fileBase64 = (file: string) => fs.readFileSync(path.join(FIXTURES, file)).toString('base64');
const underPrefix = (file: string) => `${P}${fileBase64(file)}`;
const valid = () => underPrefix('valid-inked.png');

/** The C6 encodings of a valid PNG data URL. */
const encodings = (dataUrl: string): Record<string, string> => {
  const payload = dataUrl.slice(P.length);

  return {
    'newline inside the payload': `${P}${payload.slice(0, 10)}\n${payload.slice(10)}`,
    'space inside the payload': `${P}${payload.slice(0, 10)} ${payload.slice(10)}`,
    'URL-safe alphabet': `${P}${payload.replace(/\+/g, '-').replace(/\//g, '_')}`,
    'padding removed': `${P}${payload.replace(/=+$/, '')}`,
    'percent-encoded payload': `${P}${encodeURIComponent(payload)}`,
    'DATA: upper-case scheme': `DATA:image/png;base64,${payload}`,
    'extra ;charset=utf-8 parameter': `data:image/png;charset=utf-8;base64,${payload}`,
    'data:image/png, without ;base64': `data:image/png,${payload}`,
    'data:image/jpeg;base64, around PNG bytes': `data:image/jpeg;base64,${payload}`,
  };
};

/** Values C1-C8 refuse (C7 is about the V1 isBase64 flag, which signup does not have). */
const REFUSED_VALUES = (): Array<{ label: string; value: string }> => [
  { label: 'C1 transparent PNG', value: underPrefix('transparent-1000x438.png') },
  { label: 'C2 0.9% ink', value: underPrefix('ink-0p9-1000x438.png') },
  { label: 'C3 F02 junk payload', value: `${P}bm90LWFuLWltYWdl` },
  { label: 'C4 JPEG under the PNG prefix', value: underPrefix('jpeg-bytes.jpg') },
  { label: 'C4 SVG under the PNG prefix', value: underPrefix('svg-bytes.svg') },
  { label: 'C4 GIF under the PNG prefix', value: underPrefix('gif-bytes.gif') },
  { label: 'C4 WebP under the PNG prefix', value: underPrefix('webp-bytes.webp') },
  ...[
    ['spaces only', '   '],
    ['U+00A0', ' '],
    ['U+3000', '　'],
    ['U+200B', '​'],
    ['U+FEFF', '﻿'],
    ['tab and newline', '\t\n'],
  ].map(([label, text]) => ({ label: `C5 ${label}`, value: text })),
  ...Object.entries(encodings(valid())).map(([label, value]) => ({ label: `C6 ${label}`, value })),
  { label: 'C8 truncated inside IDAT', value: underPrefix('truncated-idat.png.bin') },
];

describe.skipIf(!hasDatabase)('G4 C34 createUser refuses every signature C33 refuses', () => {
  let prisma: typeof import('@documenso/prisma').prisma;
  let createUser: typeof import('./create-user').createUser;
  let AppError: typeof import('../../errors/app-error').AppError;

  beforeAll(async () => {
    ({ prisma } = await import('@documenso/prisma'));
    ({ createUser } = await import('./create-user'));
    ({ AppError } = await import('../../errors/app-error'));
  }, 60_000);

  const email = (label: string) =>
    `g4-c34-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${nanoid(6).toLowerCase()}@test.documenso.com`;

  const signUp = async (address: string, signature: string | null | undefined) =>
    await createUser({ name: 'G4 C34', email: address, password: 'G4-signup-Password-1!', signature }).then(
      (user) => ({ user, error: null as unknown }),
      (error: unknown) => ({ user: null, error }),
    );

  it.each(REFUSED_VALUES().map((entry) => [entry.label, entry.value] as const))(
    'refuses %s with AppError INVALID_REQUEST and creates no user',
    async (_label, value) => {
      const address = email(_label);
      const outcome = await signUp(address, value);

      expect(outcome.error, 'the signup is refused').not.toBeNull();
      expect(outcome.error, 'the refusal is an AppError, so the route answers 400 rather than 500').toBeInstanceOf(
        AppError,
      );
      expect((outcome.error as { code?: string }).code, 'the refusal code').toBe('INVALID_REQUEST');
      expect(await prisma.user.count({ where: { email: address } }), 'no user is created').toBe(0);
    },
    30_000,
  );

  it('control: a valid signature signs up and is stored', async () => {
    const address = email('valid');
    const outcome = await signUp(address, valid());

    expect(outcome.error, 'a valid signature is accepted').toBeNull();

    const user = await prisma.user.findUniqueOrThrow({ where: { email: address } });

    expect(user.signature, 'the valid signature is stored as an image').toMatch(/^data:image\/png;base64,/);
  }, 30_000);

  it.each([
    ['an empty string', ''],
    ['null', null],
    ['an absent signature', undefined],
  ] as const)(
    '%s still signs up',
    async (label, signature) => {
      const address = email(label);
      const outcome = await signUp(address, signature);

      expect(outcome.error, `${label} is not refused`).toBeNull();
      expect(await prisma.user.count({ where: { email: address } }), 'the user is created').toBe(1);
    },
    30_000,
  );
});
