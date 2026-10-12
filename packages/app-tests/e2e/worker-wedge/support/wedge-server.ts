/**
 * The built Sign server for the product specs, started as the image starts
 * it (`node build/server/main.js` from apps/remix), adapted from
 * directory-sync/support/sign-server.ts in two ways: the Redis URL and key
 * prefix are passed in rather than read from this process, so a replacement
 * server can join the same queue, and stderr is kept apart from stdout, because
 * the exit line is specified to go to stderr.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from '../../directory-sync/support/sign-server';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
// WEDGE_REMIX_DIR runs these specs against another checkout's build.
const REMIX_DIR = process.env.WEDGE_REMIX_DIR ?? path.join(REPO_ROOT, 'apps/remix');
const SERVER_ENTRY = path.join(REMIX_DIR, 'build/server/main.js');

/**
 * The server's JSON log lines carry the hostname, and a CI runner's container
 * hostname embeds CI_RUNNER_SHORT_TOKEN, which the artifact secret scan rejects,
 * so everything that hands output to a report or an error goes through this.
 */
const withoutHostname = (output: string) => output.replaceAll(os.hostname(), '<hostname>');

/** Inherited settings for what the test decides are dropped. */
const CONTROLLED =
  /^(NEXT_PRIVATE_REDIS_|NEXT_PRIVATE_JOBS_|NEXT_PRIVATE_BULLMQ_|NEXT_PRIVATE_LOGGER_FILE_PATH$|NODE_OPTIONS$|PORT$|NODE_ENV$|NEXT_PUBLIC_WEBAPP_URL$|NEXT_PRIVATE_INTERNAL_WEBAPP_URL$)/;

export type WedgeServer = {
  origin: string;
  stdout: () => string;
  stderr: () => string;
  /** Each stderr chunk with the time this process read it, for timing evidence. */
  stderrChunks: () => { at: number; text: string }[];
  /**
   * Resolves with the time this process first saw stderr satisfy `predicate`,
   * stamped as the chunk arrived; rejects if the server exits first or the time runs out.
   */
  waitForStderr: (predicate: (stderr: string) => boolean, timeoutMs: number) => Promise<number>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
  /** Sends `signal` to the server process, as ECS sends SIGTERM to the task. */
  signal: (signal: NodeJS.Signals) => void;
  hasExited: () => boolean;
  exitWithin: (timeoutMs: number) => Promise<{ code: number | null; at: number } | null>;
  stop: () => Promise<void>;
};

export type WedgeServerOptions = {
  redisUrl: string;
  redisPrefix: string;
  cluster: boolean;
  env?: Record<string, string | undefined>;
};

export const spawnWedgeServer = async (options: WedgeServerOptions): Promise<WedgeServer> => {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `${SERVER_ENTRY} does not exist. Build the app first: npx turbo run build --filter=@documenso/remix...`,
    );
  }

  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !CONTROLLED.test(key)) {
      env[key] = value;
    }
  }

  const overrides: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    PORT: String(port),
    NEXT_PUBLIC_WEBAPP_URL: origin,
    NEXT_PRIVATE_INTERNAL_WEBAPP_URL: origin,
    NEXT_PRIVATE_JOBS_PROVIDER: 'bullmq',
    NEXT_PRIVATE_REDIS_URL: options.redisUrl,
    NEXT_PRIVATE_REDIS_PREFIX: options.redisPrefix,
    NEXT_PRIVATE_REDIS_CLUSTER: options.cluster ? 'true' : undefined,
    ...options.env,
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  let stdout = '';
  let stderr = '';
  // When each stderr chunk arrived and where it ended, so a waiter registered
  // after a line arrived still gets the line's arrival time (Codex r3).
  const stderrChunks: { at: number; end: number }[] = [];
  const stderrWaiters = new Set<() => void>();
  const child: ChildProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REMIX_DIR,
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => {
    const at = Date.now();

    stderr += chunk.toString('utf8');
    stderrChunks.push({ at, end: stderr.length });
    for (const wake of stderrWaiters) {
      wake();
    }
  });

  let exited = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal, at: Date.now() });
      for (const wake of stderrWaiters) {
        wake();
      }
    });
  });

  return {
    origin,
    stdout: () => withoutHostname(stdout),
    stderr: () => withoutHostname(stderr),
    stderrChunks: () =>
      stderrChunks.map((chunk, index) => ({
        at: chunk.at,
        text: withoutHostname(stderr.slice(index === 0 ? 0 : stderrChunks[index - 1].end, chunk.end)),
      })),
    waitForStderr: async (predicate, timeoutMs) =>
      await new Promise<number>((resolve, reject) => {
        const finish = (outcome: () => void) => {
          clearTimeout(timer);
          stderrWaiters.delete(wake);
          outcome();
        };
        const wake = () => {
          if (predicate(stderr)) {
            const first = stderrChunks.find((chunk) => predicate(stderr.slice(0, chunk.end)));

            finish(() => resolve(first?.at ?? Date.now()));
          } else if (exited) {
            finish(() => reject(new Error(`The Sign server exited first.\nstderr:\n${withoutHostname(stderr)}`)));
          }
        };
        const timer = setTimeout(
          () =>
            finish(() =>
              reject(new Error(`stderr did not match within ${timeoutMs} ms.\nstderr:\n${withoutHostname(stderr)}`)),
            ),
          timeoutMs,
        );

        stderrWaiters.add(wake);
        wake();
      }),
    exit,
    signal: (signal) => {
      child.kill(signal);
    },
    hasExited: () => exited,
    exitWithin: async (timeoutMs) => {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
      const result = await Promise.race([exit, timeout]);

      return result ? { code: result.code, at: result.at } : null;
    },
    stop: async () => {
      if (!exited) {
        child.kill('SIGKILL');
        await exit;
      }
    },
  };
};

/** Resolves when the server answers HTTP, or rejects if it exits or takes too long. */
export const waitUntilServing = async (server: WedgeServer, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (server.hasExited()) {
      const { code, signal } = await server.exit;
      throw new Error(
        `The Sign server exited (code ${code}, signal ${signal}) before serving.\n${server.stdout()}\n${server.stderr()}`,
      );
    }

    try {
      await fetch(`${server.origin}/favicon.ico`, { signal: AbortSignal.timeout(2_000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`The Sign server did not serve within ${timeoutMs} ms.\n${server.stdout()}\n${server.stderr()}`);
};
