import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { PDF } from '@libpdf/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The network boundary for these tests. The revocation provider fetches through
 * `node:http` after resolving the host through `node:dns/promises`, never through
 * the global `fetch`, so those two are what is replaced. Nothing inside this
 * package is mocked.
 */
const requests = vi.hoisted(() => [] as { host: string; path: string }[]);
const responses = vi.hoisted(() => new Map<string, Uint8Array>());

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '198.51.101.10', family: 4 }],
}));

vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:http')>();

  const request = (options: { host: string; path: string }, onResponse: (response: unknown) => void) => {
    const emitter = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };

    emitter.destroy = () => {};
    emitter.end = () => {
      requests.push({ host: options.host, path: options.path });

      const body = responses.get(`http://${options.host}${options.path}`);
      const response = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
        statusCode: body ? 200 : 404,
        statusMessage: body ? 'OK' : 'Not Found',
        rawHeaders: [] as string[],
      });

      queueMicrotask(() => onResponse(response));
    };

    return emitter;
  };

  return { ...original, default: { ...original, request }, request };
});

// Imported after the mocks are declared; vitest hoists vi.mock above imports.
import { signPdf } from './index';

const FIXTURES = path.join(__dirname, 'helpers', 'revocation', '__fixtures__');
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

const CRL_URL = 'http://crl.usertrust.com/USERTrustRSACertificationAuthority.crl';

const ENV_KEYS = [
  'NEXT_PRIVATE_SIGNING_TRANSPORT',
  'NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH',
  'NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS',
  'NEXT_PRIVATE_SIGNING_PASSPHRASE',
  'NEXT_PRIVATE_SIGNING_REVOCATION_MODE',
  'NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY',
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  process.env.NEXT_PRIVATE_SIGNING_TRANSPORT = 'local';
  process.env.NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH = path.join(
    __dirname,
    '..',
    '..',
    'apps',
    'remix',
    'example',
    'cert.p12',
  );
  process.env.NEXT_PRIVATE_SIGNING_REVOCATION_MODE = 'strict';

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
});

afterAll(() => {
  vi.useRealTimers();

  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe('signPdf revocation wiring', () => {
  // F5: the provider signPdf hands to pdf.sign must know the bundled issuers.
  it('hands pdf.sign a provider that can check the real R46 against the real USERTrust CRL', async () => {
    const crl = fixture('usertrust-rsa-certification-authority.crl');

    responses.set(CRL_URL, crl);

    const pdf = await PDF.create();

    let provider: { getCRL: (cert: Uint8Array) => Promise<Uint8Array | null>; outcomes: () => unknown[] } | undefined;

    vi.spyOn(pdf, 'sign').mockImplementation(((options: { revocationProvider?: typeof provider }) => {
      provider = options.revocationProvider;

      return Promise.resolve({ bytes: new Uint8Array([1]), warnings: [] });
    }) as unknown as typeof pdf.sign);

    await signPdf({ pdf });

    expect(provider).toBeDefined();

    const returned = await (provider as NonNullable<typeof provider>).getCRL(
      fixture('sectigo-time-stamping-root-r46-cross.crt'),
    );

    expect(requests.map((request) => `http://${request.host}${request.path}`)).toContain(CRL_URL);
    expect(returned).toEqual(crl);
    expect((provider as NonNullable<typeof provider>).outcomes()).toMatchObject([{ status: 'good' }]);
  });
});
