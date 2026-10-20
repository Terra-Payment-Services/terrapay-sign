/**
 * Unit-level checks of the `/proc` path that finds the server's PID without `lsof` (amendment
 * after CI pipeline 55408). No browser and no server: the parser reads a `/proc/net/tcp` table and a
 * `/proc/net/tcp6` table written in the kernel's format, and the PID lookup walks a fake `/proc` tree
 * of `fd` links built in a temporary directory.
 *
 * The tables are written by hand to the layout proc(5) documents, not captured on a Linux host, and
 * these checks run on the Mac. The last test runs with no `lsof` on the PATH against the running
 * server: where `/proc/net/tcp` exists (the Linux CI job) it must find the server's PID from `/proc`;
 * elsewhere it must fail naming both methods. Its Linux branch first runs on the CI runner.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import {
  findServerPid,
  listeningSocketInodes,
  pidFromProc,
  pidsHoldingSockets,
} from './fixtures/branding-server-probes';

// Port 3000 is 0BB8 and 3660 is 0E4C. Rows: 3000 listening on 0.0.0.0 (inode 41001), a client
// connection from 3000 (established, 01), 3660 listening on 127.0.0.1 (inode 41002), and a listening
// socket on 5432 (1538).
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41001 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0BB8 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000  1000        0 41050 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:0E4C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41002 1 0000000000000000 100 0 0 10 0
   3: 00000000:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 39000 1 0000000000000000 100 0 0 10 0
`;

// 3000 listening on :: (inode 41003), and a TIME_WAIT (06) row on 3000 whose inode is 0.
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41003 1 0000000000000000 100 0 0 10 0
   1: 0000000000000000FFFF00000100007F:0BB8 0000000000000000FFFF00000100007F:D2F2 06 00000000:00000000 03:00000F9A 00000000     0        0 0 3 0000000000000000
`;

test.describe('[BRANDING_CONTRAST]: the server PID without lsof', () => {
  test('the /proc/net/tcp parser finds only the listening sockets on the port', () => {
    expect(listeningSocketInodes(TCP, 3000)).toEqual(['41001']);
    expect(listeningSocketInodes(TCP, 3660)).toEqual(['41002']);
    expect(listeningSocketInodes(TCP6, 3000)).toEqual(['41003']);
    expect(listeningSocketInodes(TCP, 4000)).toEqual([]);
    expect(listeningSocketInodes('', 3000)).toEqual([]);
  });

  test('the PID lookup matches socket links under a /proc tree, and fails with a reason or on ambiguity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'g3-proc-'));

    try {
      await fs.mkdir(path.join(root, 'net'));
      await fs.writeFile(path.join(root, 'net', 'tcp'), TCP);
      await fs.writeFile(path.join(root, 'net', 'tcp6'), TCP6);

      const links: Record<string, string[]> = {
        '1': ['/dev/null'],
        '700': ['/dev/null', 'socket:[39000]'],
        '4242': ['pipe:[7]', 'anon_inode:[eventpoll]', 'socket:[41001]', 'socket:[41003]'],
        '4300': ['socket:[41050]'],
        // A second process on 5432's listening socket, as a forked worker would hold it.
        '701': ['socket:[39000]'],
      };

      for (const [pid, targets] of Object.entries(links)) {
        await fs.mkdir(path.join(root, pid, 'fd'), { recursive: true });

        for (const [fd, target] of targets.entries()) {
          await fs.symlink(target, path.join(root, pid, 'fd', String(fd)));
        }
      }

      await fs.mkdir(path.join(root, 'self'));

      expect(await pidsHoldingSockets(['41001'], root)).toEqual(['4242']);
      expect(await pidFromProc(3000, root)).toBe('4242');
      await expect(pidFromProc(4000, root)).rejects.toThrow(/no listening socket on port 4000/);
      await expect(pidFromProc(3660, root)).rejects.toThrow(/no process .* holds socket inode 41002/);
      await expect(pidFromProc(5432, root)).rejects.toThrow('more than one process listens on port 5432: 700, 701');
      await expect(pidFromProc(3000, path.join(root, 'missing'))).rejects.toThrow(/no .*net\/tcp or tcp6 to read/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('with no lsof the server PID comes from /proc on Linux, or the lookup fails naming both', async () => {
    const savedPath = process.env.PATH;
    const hasProc = await fs
      .access('/proc/net/tcp')
      .then(() => true)
      .catch(() => false);

    process.env.PATH = await fs.mkdtemp(path.join(os.tmpdir(), 'g3-no-lsof-'));

    try {
      if (hasProc) {
        const pid = await findServerPid();

        expect(pid, 'a PID found from /proc').toMatch(/^\d+$/);
        expect(await fs.readFile(`/proc/${pid}/status`, 'utf8'), 'the PID is a live process').toMatch(/^VmRSS:/m);
      } else {
        await expect(findServerPid()).rejects.toThrow(/cannot find the server PID on port \d+: lsof: .+; \/proc: .+/);
      }
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
