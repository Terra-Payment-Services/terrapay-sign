/**
 * The built Sign server, started as the image starts it (`node build/server/main.js` from apps/remix) on a free
 * port, for the shutdown test. Adapted from worker-wedge/support/wedge-server.ts, without the Redis settings:
 * this server runs the local job provider, because the shutdown test needs only the HTTP server and the process.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from '../../../directory-sync/support/sign-server';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
// KEEP_ALIVE_REMIX_DIR runs these specs against another checkout's build.
const REMIX_DIR = process.env.KEEP_ALIVE_REMIX_DIR ?? path.join(REPO_ROOT, 'apps/remix');
const SERVER_ENTRY = path.join(REMIX_DIR, 'build/server/main.js');

/** Inherited settings for what the test decides are dropped. NODE_OPTIONS carries the test runner's tsx loader. */
const CONTROLLED =
  /^(NEXT_PRIVATE_REDIS_|NEXT_PRIVATE_JOBS_|NEXT_PRIVATE_BULLMQ_|NEXT_PRIVATE_LOGGER_FILE_PATH$|NODE_OPTIONS$|PORT$|NODE_ENV$|NEXT_PUBLIC_WEBAPP_URL$|NEXT_PRIVATE_INTERNAL_WEBAPP_URL$)/;

export type OwnServer = {
  origin: string;
  host: string;
  port: number;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
  signal: (signal: NodeJS.Signals) => void;
  hasExited: () => boolean;
  stop: () => Promise<void>;
};

/** The server's JSON log lines carry the hostname, which an artifact secret scan can reject. */
const withoutHostname = (output: string) => output.replaceAll(os.hostname(), '<hostname>');

export const spawnOwnServer = async (): Promise<OwnServer> => {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`${SERVER_ENTRY} does not exist. Build the app first: npm run build:app && npm run build:server`);
  }

  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !CONTROLLED.test(key)) {
      env[key] = value;
    }
  }

  Object.assign(env, {
    NODE_ENV: 'production',
    PORT: String(port),
    NEXT_PUBLIC_WEBAPP_URL: origin,
    NEXT_PRIVATE_INTERNAL_WEBAPP_URL: origin,
    NEXT_PRIVATE_JOBS_PROVIDER: 'local',
  });

  let stdout = '';
  let stderr = '';
  const child: ChildProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REMIX_DIR,
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

  let exited = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal, at: performance.now() });
    });
  });

  return {
    origin,
    host: 'localhost',
    port,
    stdout: () => withoutHostname(stdout),
    stderr: () => withoutHostname(stderr),
    exit,
    signal: (signal) => {
      child.kill(signal);
    },
    hasExited: () => exited,
    stop: async () => {
      if (!exited) {
        child.kill('SIGKILL');
        await exit;
      }
    },
  };
};

/** Resolves when the server answers HTTP, or rejects if it exits or takes too long. */
export const waitUntilServing = async (server: OwnServer, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (server.hasExited()) {
      const { code, signal } = await server.exit;

      throw new Error(
        `The Sign server exited (code ${code}, signal ${signal}) before serving.\n${server.stdout()}\n${server.stderr()}`,
      );
    }

    try {
      await fetch(`${server.origin}/api/health`, { signal: AbortSignal.timeout(2_000) });

      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`The Sign server did not serve within ${timeoutMs} ms.\n${server.stdout()}\n${server.stderr()}`);
};
