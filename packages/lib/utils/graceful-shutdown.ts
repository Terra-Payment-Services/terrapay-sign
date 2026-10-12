type GracefulShutdownOptions = {
  /** Stops accepting connections and resolves once the open requests have finished. */
  closeServer: () => Promise<void>;
  /** Stops taking background jobs and resolves once the running ones have finished. */
  closeJobs: () => Promise<void>;
  exit: (code: number) => void;
  /** Called synchronously as a shutdown begins, before anything is closed. */
  onStart?: () => void;
  /**
   * How long to wait before exiting anyway. Kept under the container's stop timeout,
   * 30 seconds by default on ECS, so the process exits on its own terms rather than
   * being killed with work half done.
   */
  timeoutMs: number;
};

/**
 * Build the handler the server runs on SIGTERM.
 *
 * ECS sends SIGTERM once the load balancer has drained the task, then SIGKILL when the
 * stop timeout runs out. Without a handler Node dies on the signal at once, and with
 * the job worker in the same process that kills a seal or an email mid-run. This closes
 * the HTTP server, waits for its open requests, then closes the job worker and waits
 * for its running jobs, all inside one deadline, and exits. Requests go first because
 * one still open may yet enqueue a job, which needs the job provider. A second
 * signal is ignored, since the first is already doing the work.
 *
 * A wedged job worker runs it too, passing exit code 1 so the exit reads as a
 * failure while open requests still finish.
 */
export const createGracefulShutdown = ({
  closeServer,
  closeJobs,
  exit,
  onStart,
  timeoutMs,
}: GracefulShutdownOptions) => {
  let isShuttingDown = false;

  return async (signal: string, exitCode = 0) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;

    onStart?.();

    console.log(`[SHUTDOWN]: ${signal} received, finishing open requests and running jobs`);

    const timer = setTimeout(() => {
      console.error(`[SHUTDOWN]: Still busy after ${timeoutMs}ms, exiting anyway`);
      exit(1);
    }, timeoutMs);

    const [server] = await Promise.allSettled([closeServer()]);
    const [jobs] = await Promise.allSettled([closeJobs()]);
    const results = [server, jobs];

    clearTimeout(timer);

    const failures = results.filter((result) => result.status === 'rejected');

    for (const failure of failures) {
      console.error('[SHUTDOWN]: Close failed', failure.reason);
    }

    exit(failures.length > 0 ? 1 : exitCode);
  };
};
