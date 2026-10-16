/**
 * An origin of this worker's own, chosen before the fixtures that read
 * NEXT_PUBLIC_WEBAPP_URL at import time are loaded.
 *
 * Specs that seed through the application's HTTP API (the company seal
 * fixtures) must send those calls to the server that uses this worker's
 * database, not the harness server. That server starts later, on this port.
 *
 * IMPORT THIS MODULE AFTER ./worker-database AND BEFORE any fixture.
 * Outside a test worker (the runner listing tests) nothing changes.
 */
import { spawnSync } from 'node:child_process';

const freePortSync = () => {
  const found = spawnSync(
    process.execPath,
    [
      '-e',
      "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
    ],
    { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } },
  );
  const port = Number(/\d+/.exec(found.stdout)?.[0]);

  if (!Number.isInteger(port)) {
    throw new Error(`Could not find a free port: ${found.stdout} ${found.stderr}`);
  }

  return port;
};

export const workerPort = process.env.TEST_WORKER_INDEX !== undefined ? freePortSync() : 0;
export const workerOrigin = `http://localhost:${workerPort}`;

if (workerPort) {
  // Kept for fixtures/shared-database, which puts them back in the projects
  // that depend on this one and inherit this worker's environment.
  process.env.DIRSYNC_HARNESS_WEBAPP_URL ??= process.env.NEXT_PUBLIC_WEBAPP_URL ?? '';
  process.env.DIRSYNC_HARNESS_INTERNAL_WEBAPP_URL ??= process.env.NEXT_PRIVATE_INTERNAL_WEBAPP_URL ?? '';
  process.env.NEXT_PUBLIC_WEBAPP_URL = workerOrigin;
  process.env.NEXT_PRIVATE_INTERNAL_WEBAPP_URL = workerOrigin;
}
