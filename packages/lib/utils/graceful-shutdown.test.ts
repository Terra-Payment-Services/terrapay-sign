import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGracefulShutdown } from './graceful-shutdown';

/**
 * What a deploy does to the process. ECS drains the task from the load balancer, sends
 * SIGTERM, and kills it outright when the stop timeout runs out. The worker that seals
 * documents runs in the same process, so whatever is running when the process goes is
 * lost unless the process waits for it.
 */

const deferred = () => {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};

  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
};

describe('graceful shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits for a running job before exiting', async () => {
    const job = deferred();
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({
      closeServer: async () => {},
      closeJobs: async () => await job.promise,
      exit,
      timeoutMs: 25_000,
    });

    const finished = shutdown('SIGTERM');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(exit).not.toHaveBeenCalled();

    job.resolve();
    await finished;

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('waits for an open request before exiting', async () => {
    const request = deferred();
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({
      closeServer: async () => await request.promise,
      closeJobs: async () => {},
      exit,
      timeoutMs: 25_000,
    });

    const finished = shutdown('SIGTERM');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(exit).not.toHaveBeenCalled();

    request.resolve();
    await finished;

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('exits before the stop timeout when a job will not finish', async () => {
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({
      closeServer: async () => {},
      closeJobs: async () => await new Promise<void>(() => {}),
      exit,
      timeoutMs: 25_000,
    });

    void shutdown('SIGTERM');

    await vi.advanceTimersByTimeAsync(25_000);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('reports a failure to close as a failed exit', async () => {
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({
      closeServer: async () => {},
      closeJobs: async () => {
        throw new Error('Redis went away');
      },
      exit,
      timeoutMs: 25_000,
    });

    await shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('closes once when the signal arrives twice', async () => {
    const closeJobs = vi.fn(async () => {});
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({
      closeServer: async () => {},
      closeJobs,
      exit,
      timeoutMs: 25_000,
    });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(closeJobs).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
