/**
 * The built Sign server, started the way the image starts it
 * (docker/start.sh: `node build/server/main.js` from apps/remix), with an
 * environment the test chooses.
 *
 * The directory sync reads its settings from the process that runs it, and the
 * harness's own server on :3000 has one fixed environment, so each test starts
 * a server of its own on a free port.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { TestInfo } from '@playwright/test';
import { Job, Queue } from 'bullmq';
import IORedis from 'ioredis';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
// DIRSYNC_REMIX_DIR runs these specs against another checkout's build.
const REMIX_DIR = process.env.DIRSYNC_REMIX_DIR ?? path.join(REPO_ROOT, 'apps/remix');
const SERVER_ENTRY = path.join(REMIX_DIR, 'build/server/main.js');

/** Named in packages/tsconfig/process-env.d.ts; also the job's trigger name. */
export const DIRECTORY_SYNC_JOB_ID = 'internal.reconcile-directory-access';

/** The queue packages/lib/jobs/client/bullmq.ts puts every job on. */
const QUEUE_NAME = 'documenso-jobs';

/** Everything the test decides for itself. Inherited values for these are dropped. */
const CONTROLLED =
  /^(NEXT_PRIVATE_ENTRA_|NEXT_PRIVATE_JOBS_PROVIDER$|NEXT_PRIVATE_REDIS_PREFIX$|NODE_OPTIONS$|PORT$|NODE_ENV$)/;

export const freePort = async () =>
  await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

export const redisUrl = () => {
  const url = process.env.NEXT_PRIVATE_REDIS_URL;

  if (!url) {
    throw new Error(
      'NEXT_PRIVATE_REDIS_URL is not set; the directory sync runs under BullMQ, as it does in production.',
    );
  }

  return url;
};

export type SignServer = {
  origin: string;
  port: number;
  redisPrefix: string;
  /** stdout, stderr and the pino log file, in arrival order. */
  output: () => string;
  /** Output written after the given offset into `output()`. */
  outputSince: (offset: number) => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  hasExited: () => boolean;
  stop: () => Promise<void>;
};

export const baseServerEnv = (overrides: Record<string, string | undefined>) => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !CONTROLLED.test(key)) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
};

export const spawnSignServer = async (overrides: Record<string, string | undefined>): Promise<SignServer> => {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `${SERVER_ENTRY} does not exist. Build the app first: npx turbo run build --filter=@documenso/remix...`,
    );
  }

  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const redisPrefix = `{dirsync-${randomUUID()}}`;
  const logFile = path.join(os.tmpdir(), `dirsync-${randomUUID()}.log`);

  const env = baseServerEnv({
    NODE_ENV: 'production',
    PORT: String(port),
    NEXT_PUBLIC_WEBAPP_URL: origin,
    NEXT_PRIVATE_INTERNAL_WEBAPP_URL: origin,
    NEXT_PRIVATE_REDIS_PREFIX: redisPrefix,
    NEXT_PRIVATE_LOGGER_FILE_PATH: logFile,
    ...overrides,
  });

  let output = '';
  const child: ChildProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REMIX_DIR,
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));

  let exited = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  let logFileOffset = 0;
  const readLogFile = () => {
    try {
      const contents = fs.readFileSync(logFile, 'utf8');
      const fresh = contents.slice(logFileOffset);
      logFileOffset = contents.length;
      output += fresh;
    } catch {
      // Not written yet.
    }
  };

  return {
    origin,
    port,
    redisPrefix,
    output: () => {
      readLogFile();
      return output;
    },
    outputSince: (offset: number) => {
      readLogFile();
      return output.slice(offset);
    },
    exit,
    hasExited: () => exited,
    stop: async () => {
      if (!exited) {
        child.kill('SIGKILL');
        await exit;
      }

      fs.rmSync(logFile, { force: true });
    },
  };
};

/** Resolves when the server answers HTTP at all, or rejects if it exits or takes too long. */
export const waitUntilServing = async (server: SignServer, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (server.hasExited()) {
      const { code, signal } = await server.exit;
      throw new Error(`The Sign server exited (code ${code}, signal ${signal}) before serving.\n${server.output()}`);
    }

    try {
      await fetch(`${server.origin}/favicon.ico`, { signal: AbortSignal.timeout(2_000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`The Sign server did not serve within ${timeoutMs} ms.\n${server.output()}`);
};

export type RunOutcome = { state: string; failedReason?: string; attemptsMade: number };

/**
 * Run the directory sync once, as the hourly scheduler would: a job on the
 * server's queue named for the job definition, carrying the trigger name and an
 * empty payload. The server's own worker picks it up. Resolves when the job has
 * completed or failed for the last time.
 */
export const runDirectorySync = async (server: SignServer, timeoutMs = 240_000): Promise<RunOutcome> => {
  const connection = new IORedis(redisUrl(), { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE_NAME, { connection, prefix: server.redisPrefix });

  try {
    const added = await queue.add(
      DIRECTORY_SYNC_JOB_ID,
      { name: DIRECTORY_SYNC_JOB_ID, payload: {} },
      { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    );

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const job = await Job.fromId(queue, added.id ?? '');
      const state = job ? await job.getState() : 'missing';

      if (state === 'completed' || state === 'failed') {
        return { state, failedReason: job?.failedReason, attemptsMade: job?.attemptsMade ?? 0 };
      }

      if (server.hasExited()) {
        return { state: 'server-exited', attemptsMade: job?.attemptsMade ?? 0 };
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return { state: 'still-running', attemptsMade: 0 };
  } finally {
    await queue.close();
    connection.disconnect();
  }
};

export const attachEvidence = async (testInfo: TestInfo, name: string, body: unknown) => {
  await testInfo.attach(name, {
    body: typeof body === 'string' ? body : JSON.stringify(body, null, 2),
    contentType: typeof body === 'string' ? 'text/plain' : 'application/json',
  });
};
