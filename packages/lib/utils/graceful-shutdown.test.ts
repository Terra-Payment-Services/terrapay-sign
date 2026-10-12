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

  // a wedged job worker shuts the server down the same way, but must exit 1.
  it('exits with the code it was asked for after a clean shutdown', async () => {
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({
      closeServer: async () => {},
      closeJobs: async () => {},
      exit,
      timeoutMs: 25_000,
    });

    await shutdown('worker wedged', 1);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
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

  // B1: a request accepted before the shutdown may enqueue a job while it
  // finishes, so the job provider closes only after the server has closed.
  it('closes the jobs only after the server has closed', async () => {
    const server = deferred();
    const jobs = deferred();
    const closeJobs = vi.fn(async () => await jobs.promise);
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({
      closeServer: async () => await server.promise,
      closeJobs,
      exit,
      timeoutMs: 25_000,
    });

    const finished = shutdown('SIGTERM');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(closeJobs, 'the job close waits for the open requests').not.toHaveBeenCalled();

    server.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(closeJobs, 'the job close starts once the server has closed').toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    jobs.resolve();
    await finished;

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('closes the jobs after the server for a wedged worker too, exiting with its code', async () => {
    const server = deferred();
    const closeJobs = vi.fn(async () => {});
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({
      closeServer: async () => await server.promise,
      closeJobs,
      exit,
      timeoutMs: 25_000,
    });

    const finished = shutdown('worker wedged', 1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(closeJobs).not.toHaveBeenCalled();

    server.resolve();
    await finished;

    expect(closeJobs).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  // B1: one deadline covers both closes. A server close of 20 s followed by
  // a job close of 20 s more ends in the timeout exit at 25 s, not at 45 s.
  it('applies the one deadline to the server close and the job close together', async () => {
    const closeJobs = vi.fn(async () => await new Promise<void>((resolve) => setTimeout(resolve, 20_000)));
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({
      closeServer: async () => await new Promise<void>((resolve) => setTimeout(resolve, 20_000)),
      closeJobs,
      exit,
      timeoutMs: 25_000,
    });

    void shutdown('SIGTERM');

    await vi.advanceTimersByTimeAsync(19_999);
    expect(closeJobs, 'the server is still closing').not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(closeJobs, 'the job close starts when the server close ends, at 20 s').toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(exit, 'no exit before the deadline').not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit, 'the timeout exit at 25 s').toHaveBeenCalledExactlyOnceWith(1);
  });

  // C1: the server passes an onStart that stops the job watchdog, so from
  // the moment any shutdown begins neither watchdog path can log or exit, even
  // while open requests keep the job provider open.
  it('calls onStart once, synchronously, before the server close, when a SIGTERM shutdown begins', async () => {
    const server = deferred();
    const order: string[] = [];
    const onStart = vi.fn(() => {
      order.push('onStart');
    });
    const closeServer = vi.fn(async () => {
      order.push('closeServer');
      await server.promise;
    });
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({
      closeServer,
      closeJobs: async () => {},
      exit,
      timeoutMs: 25_000,
      onStart,
    });

    const finished = shutdown('SIGTERM');

    expect(onStart, 'onStart runs in the same tick as the signal').toHaveBeenCalledTimes(1);
    expect(order[0], 'onStart runs before the server close starts').toBe('onStart');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(order, 'the server close follows onStart, with the request still open').toEqual(['onStart', 'closeServer']);
    expect(onStart, 'onStart is not called again while the shutdown waits').toHaveBeenCalledTimes(1);

    server.resolve();
    await finished;

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('calls onStart once, synchronously, when a wedge shutdown begins', async () => {
    const order: string[] = [];
    const onStart = vi.fn(() => {
      order.push('onStart');
    });
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({
      closeServer: async () => {
        order.push('closeServer');
        await Promise.resolve();
      },
      closeJobs: async () => {},
      exit,
      timeoutMs: 25_000,
      onStart,
    });

    const finished = shutdown('worker wedged', 1);

    expect(onStart, 'onStart runs in the same tick as the wedge shutdown').toHaveBeenCalledTimes(1);
    expect(order[0], 'onStart runs before the server close starts').toBe('onStart');

    await finished;

    expect(order).toEqual(['onStart', 'closeServer']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('does not call onStart again when a second signal or a wedge arrives during the shutdown', async () => {
    const server = deferred();
    const onStart = vi.fn();
    const closeServer = vi.fn(async () => await server.promise);
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({
      closeServer,
      closeJobs: async () => {},
      exit,
      timeoutMs: 25_000,
      onStart,
    });

    const first = shutdown('SIGTERM');

    expect(onStart).toHaveBeenCalledTimes(1);

    const second = shutdown('SIGINT');
    const wedge = shutdown('worker wedged', 1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStart, 'a second signal and a wedge do not call onStart again').toHaveBeenCalledTimes(1);

    server.resolve();
    await Promise.all([first, second, wedge]);

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('shuts down as before when no onStart is given', async () => {
    const closeServer = vi.fn(async () => {});
    const closeJobs = vi.fn(async () => {});
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({ closeServer, closeJobs, exit, timeoutMs: 25_000 });

    await shutdown('SIGTERM');

    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(closeJobs).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
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
