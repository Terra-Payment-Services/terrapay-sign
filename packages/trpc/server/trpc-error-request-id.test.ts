import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type LogEntry = { bindings: Record<string, unknown>; args: unknown[] };

const { entries } = vi.hoisted(() => ({ entries: [] as LogEntry[] }));

vi.mock('@documenso/lib/utils/logger', () => {
  const recorder = (bindings: Record<string, unknown>): Record<string, unknown> => {
    const record = (...args: unknown[]) => {
      entries.push({ bindings, args });
    };

    return {
      trace: record,
      debug: record,
      info: record,
      warn: record,
      error: record,
      fatal: record,
      child: (more: Record<string, unknown>) => recorder({ ...bindings, ...more }),
    };
  };

  return { logger: recorder({}) };
});

// The router loads compiled translation catalogs, which CI does not build (they are gitignored); these tests read
// no translated text.
vi.mock('@documenso/lib/client-only/providers/i18n-server', () => ({
  loadCatalog: async () => ({ messages: {} }),
  allI18nInstances: Promise.resolve({}),
  getI18nInstance: async () => ({ _: (message: unknown) => String(message) }),
}));

import { handleTrpcRouterError } from '../utils/trpc-error-handler';
import { appRouter } from './router';

const MASKED_MESSAGE = 'Something went wrong';
const ORIGINAL_MESSAGE = 'invalid byte sequence for encoding "UTF8": 0x00';

const formatError = (error: TRPCError) => {
  const config = (appRouter._def as unknown as { _config: { errorFormatter: (opts: unknown) => any } })._config;

  return config.errorFormatter({
    shape: {
      message: error.message,
      code: -32603,
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'x' },
    },
    error,
    ctx: undefined,
    path: 'x',
    type: 'mutation',
    input: undefined,
  });
};

describe('tRPC error request id without a context (#168 C6)', () => {
  beforeEach(() => {
    entries.length = 0;
  });

  it('masks the response and logs the same request id with the original message', () => {
    const error = new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: ORIGINAL_MESSAGE,
      cause: new Error(ORIGINAL_MESSAGE),
    });

    handleTrpcRouterError({ error, ctx: undefined, path: 'x' }, 'trpc');

    const shape = formatError(error);

    expect(shape.message).toBe(MASKED_MESSAGE);
    expect(JSON.stringify(shape)).not.toContain('invalid byte sequence');
    expect(typeof shape.data.requestId).toBe('string');
    expect(shape.data.requestId.length).toBeGreaterThan(0);

    const logged = entries.filter((entry) => JSON.stringify(entry).includes(shape.data.requestId));

    expect(logged.length, 'a log entry carries the response request id').toBeGreaterThan(0);
    expect(logged.some((entry) => JSON.stringify(entry).includes('invalid byte sequence'))).toBe(true);
  });
});
