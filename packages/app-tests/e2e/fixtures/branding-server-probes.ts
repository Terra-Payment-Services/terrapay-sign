/**
 * Server probes for the branding specs' bounded-work criteria (campaign G3): the PID and
 * resident set size of the server process, and timing budgets relative to a baseline taken in the
 * same test on the same server.
 *
 * Written for the amendments after CI pipeline 55408. The CI image has no `lsof`, so the PID is
 * found with `lsof` where it is installed and otherwise from Linux's socket tables: the inode of the
 * socket listening on the port, read from `/proc/net/tcp` and `/proc/net/tcp6`, matched against the
 * `socket:[inode]` links under `/proc/<pid>/fd`. When neither finds it the probe throws with both
 * reasons; a test never skips its memory assertion for want of a PID.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Page } from '@playwright/test';

import { type AdminSession, baseUrl, resetBranding, saveOrganisationSettings } from './branding-contrast';

const run = promisify(execFile);

/** The TCP state `/proc/net/tcp` writes for a listening socket. */
const TCP_LISTEN = '0A';

/**
 * The inodes of the sockets listening on `port` in a `/proc/net/tcp` or `/proc/net/tcp6` table.
 * Each row after the header is `sl local_address rem_address st … uid timeout inode …`, where
 * `local_address` is `<hex address>:<hex port>` and `st` is the hex state.
 */
export const listeningSocketInodes = (table: string, port: number): string[] =>
  table
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length > 9 && fields[3] === TCP_LISTEN)
    .filter((fields) => Number.parseInt(fields[1].split(':').pop() ?? '', 16) === port)
    .map((fields) => fields[9]);

/** The PIDs under `procRoot` holding a file descriptor on one of `inodes`. */
export const pidsHoldingSockets = async (inodes: string[], procRoot = '/proc'): Promise<string[]> => {
  const wanted = new Set(inodes.map((inode) => `socket:[${inode}]`));
  const pids = (await fs.readdir(procRoot)).filter((entry) => /^\d+$/.test(entry));
  const holders: string[] = [];

  for (const pid of pids) {
    const fdDir = path.join(procRoot, pid, 'fd');
    const fds = await fs.readdir(fdDir).catch(() => [] as string[]);

    for (const fd of fds) {
      const target = await fs.readlink(path.join(fdDir, fd)).catch(() => '');

      if (wanted.has(target)) {
        holders.push(pid);
        break;
      }
    }
  }

  return holders;
};

/** The one PID among `pids`; more than one distinct process listening on the port is refused, naming them. */
const onlyPid = (pids: string[], port: number) => {
  const distinct = [...new Set(pids)].sort((x, y) => Number(x) - Number(y));

  if (distinct.length > 1) {
    throw new Error(`more than one process listens on port ${port}: ${distinct.join(', ')}`);
  }

  return distinct[0];
};

/** The PID listening on `port` from the socket tables under `procRoot`. */
export const pidFromProc = async (port: number, procRoot = '/proc') => {
  const tables = await Promise.all(
    ['tcp', 'tcp6'].map(async (name) => await fs.readFile(path.join(procRoot, 'net', name), 'utf8').catch(() => '')),
  );

  if (tables.every((table) => table === '')) {
    throw new Error(`no ${procRoot}/net/tcp or tcp6 to read`);
  }

  const inodes = tables.flatMap((table) => listeningSocketInodes(table, port));

  if (inodes.length === 0) {
    throw new Error(`no listening socket on port ${port} in ${procRoot}/net/tcp or tcp6`);
  }

  const pids = await pidsHoldingSockets(inodes, procRoot);

  if (pids.length === 0) {
    throw new Error(`no process under ${procRoot} holds socket inode ${inodes.join(', ')}`);
  }

  return onlyPid(pids, port);
};

const pidFromLsof = async (port: number) => {
  const { stdout } = await run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
  const pids = stdout
    .trim()
    .split('\n')
    .filter((line) => /^\d+$/.test(line));

  if (pids.length === 0) {
    throw new Error(`lsof printed no PID for port ${port}`);
  }

  return onlyPid(pids, port);
};

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

const serverPort = () => Number(new URL(baseUrl).port || '80');

/** The PID of the process listening on the server's port: `lsof`, else `/proc`; throws with both reasons. */
export const findServerPid = async () => {
  const port = serverPort();

  try {
    return await pidFromLsof(port);
  } catch (lsofError) {
    try {
      return await pidFromProc(port);
    } catch (procError) {
      throw new Error(
        `cannot find the server PID on port ${port}: lsof: ${reason(lsofError)}; /proc: ${reason(procError)}`,
      );
    }
  }
};

const pidByPort = new Map<number, string>();

/** `findServerPid`, looked up once per worker, since the RSS sampler asks every 25 ms. */
export const serverPid = async () => {
  const port = serverPort();
  const pid = pidByPort.get(port) ?? (await findServerPid());

  pidByPort.set(port, pid);

  return pid;
};

/** Resident set size, in KiB, of `pid`: `ps -o rss=`, else `VmRSS` in `/proc/<pid>/status`. */
export const rssKib = async (pid: string) => {
  try {
    const { stdout } = await run('ps', ['-o', 'rss=', '-p', pid]);
    const kib = Number(stdout.trim());

    if (Number.isFinite(kib) && kib > 0) {
      return kib;
    }

    throw new Error(`ps printed ${JSON.stringify(stdout.trim())}`);
  } catch (psError) {
    const status = await fs.readFile(`/proc/${pid}/status`, 'utf8').catch((error: unknown) => {
      throw new Error(`cannot read the RSS of ${pid}: ps: ${reason(psError)}; /proc: ${reason(error)}`);
    });
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);

    if (!match) {
      throw new Error(`cannot read the RSS of ${pid}: ps: ${reason(psError)}; /proc: no VmRSS line`);
    }

    return Number(match[1]);
  }
};

/** The server's PID and resident set size in KiB. */
export const serverRss = async () => {
  const pid = await serverPid();

  return { pid, kib: await rssKib(pid) };
};

// ---------------------------------------------------------------------------------------
// Relative timing budgets
// ---------------------------------------------------------------------------------------

/** A save answers within the baseline save of a one-rule stylesheet plus this. */
export const SAVE_EXTRA_MS = 200;

/** A page load answers within twice the baseline load plus this. */
export const LOAD_EXTRA_MS = 100;

export const saveBudgetMs = (baselineSaveMs: number) => baselineSaveMs + SAVE_EXTRA_MS;

export const loadBudgetMs = (baselineLoadMs: number) => 2 * baselineLoadMs + LOAD_EXTRA_MS;

/**
 * The baseline save: a one-rule stylesheet saved twice, the faster of the two. The row is reset
 * afterwards, so the test's own save starts from an empty row as before.
 */
export const measureBaselineSave = async (admin: AdminSession) => {
  const times: number[] = [];

  for (let i = 0; i < 2; i++) {
    const started = Date.now();
    const save = await saveOrganisationSettings(admin, { brandingCss: `.g3-baseline-${i}{font-weight:700}` });

    times.push(Date.now() - started);

    if (save.status !== 200) {
      throw new Error(`the baseline save answered ${save.status}: ${save.text.slice(0, 200)}`);
    }
  }

  await resetBranding(admin);

  return Math.min(...times);
};

/**
 * The baseline load: the signing page for `token` with the row as it stands (reset, in these tests),
 * to the first response byte, three times; the first warms the route and the faster of the other two
 * is the baseline.
 */
export const measureBaselineLoad = async (page: Page, token: string) => {
  const times: number[] = [];

  for (let i = 0; i < 3; i++) {
    const started = Date.now();

    await page.goto(`${baseUrl}/sign/${token}`, { waitUntil: 'commit' });
    times.push(Date.now() - started);
  }

  return { ms: Math.min(times[1], times[2]), times };
};
