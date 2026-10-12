/**
 * A three-master Redis Cluster in Docker, started per test, that the test
 * process and every child it spawns reach on 127.0.0.1.
 *
 * How it is reachable. A cluster client learns every node's address from the
 * nodes themselves (CLUSTER SLOTS), so each node must announce an address the
 * client can open. e2e_local reaches its Postgres, mail catcher and Redis on
 * 127.0.0.1 ports published by `docker run -p 127.0.0.1:<port>:<port>`, and a
 * Mac reaches Docker Desktop's published ports the same way, so the nodes
 * announce 127.0.0.1 and their published port.
 *
 * The nodes also gossip with each other over the cluster bus, to the address
 * and bus port they announce. 127.0.0.1 inside one container is that container,
 * so the nodes share one network namespace: a holder container owns it and
 * publishes the client ports, and each node container joins it with
 * `--network container:<holder>`. Inside it 127.0.0.1 reaches every node, and
 * outside only the three client ports are published, on loopback. A node
 * container can then be stopped and started on its own, as the investigation
 * did, while the namespace and the published ports stay put.
 *
 * Names start with `sign-e2e-`, which e2e_local reaps at the start of every run,
 * so a cancelled job's containers do not outlive it. Every name carries a
 * random run id, and the ports are free ports chosen per run.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { freePort } from '../../directory-sync/support/sign-server';

const run = promisify(execFile);

/** The image e2e_local runs its Redis from (TEST_REDIS_IMAGE), or the tag the investigation used. */
const IMAGE = process.env.TEST_REDIS_IMAGE || 'redis:7-alpine';

/** Bus ports exist only inside the shared namespace, so they need not be free on the host. */
const BUS_PORT_BASE = 17001;

const NODE_COUNT = 3;

const docker = async (args: string[], timeoutMs = 60_000) => {
  const { stdout } = await run('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });

  return stdout.trim();
};

export type RedisCluster = {
  /** The seed URL the provider is given: the first node. */
  url: string;
  ports: number[];
  holder: string;
  nodes: string[];
  /** Stops the given node indexes (all by default) at once, without a grace period. */
  stopNodes: (indexes?: number[]) => Promise<void>;
  startNodes: (indexes?: number[]) => Promise<void>;
  /** Freezes the node processes: sockets stay open and nothing answers. */
  pauseNodes: (indexes?: number[]) => Promise<void>;
  unpauseNodes: (indexes?: number[]) => Promise<void>;
  /** Resolves when every node reports cluster_state:ok and the slots are covered. */
  waitForClusterOk: (timeoutMs?: number) => Promise<void>;
  /** CLIENT LIST from every node that answers, one entry per client line. */
  clientList: () => Promise<string[]>;
  /** A redis-cli command against one node, run inside its container. */
  cli: (index: number, args: string[]) => Promise<string>;
  /**
   * Streams MONITOR from every node. Each line is stamped with the time this
   * process read it, on the same clock as the child's events.
   */
  monitor: () => Monitor;
  /**
   * Makes every node refuse every keyspace and script command with NOPERM,
   * at once, keeping its data and its connections. CLUSTER, INFO, ACL and the
   * connection commands stay allowed, so clients keep their slot map.
   */
  denyReads: () => Promise<void>;
  allowReads: () => Promise<void>;
  /** Removes every container this cluster created. Safe to call twice. */
  teardown: () => Promise<void>;
  /** docker logs of every node, for evidence. */
  logs: () => Promise<string>;
};

export type MonitorLine = { at: number; node: number; line: string };

export type Monitor = {
  lines: () => MonitorLine[];
  /** Resolves with the first line, read after `after`, that matches. */
  waitFor: (predicate: (line: MonitorLine) => boolean, timeoutMs: number, after?: number) => Promise<MonitorLine>;
  stop: () => void;
};

const pickPorts = async (count: number) => {
  const ports = new Set<number>();

  while (ports.size < count) {
    ports.add(await freePort());
  }

  return [...ports];
};

export const startRedisCluster = async (label: string): Promise<RedisCluster> => {
  const runId = randomBytes(4).toString('hex');
  const ciPart = process.env.CI_PIPELINE_ID ? `${process.env.CI_PIPELINE_ID}-` : '';
  const base = `sign-e2e-wedge-${ciPart}${label}-${runId}`;
  const holder = `${base}-net`;
  const nodes = Array.from({ length: NODE_COUNT }, (_, index) => `${base}-n${index + 1}`);
  const ports = await pickPorts(NODE_COUNT);
  const created: string[] = [];
  const monitors: ChildProcess[] = [];

  const all = (indexes?: number[]) => (indexes ?? nodes.map((_, index) => index)).map((index) => nodes[index]);

  const teardown = async () => {
    for (const child of monitors.splice(0)) {
      child.kill('SIGKILL');
    }

    for (const name of [...created].reverse()) {
      await docker(['rm', '-fv', name]).catch(() => undefined);
    }

    created.length = 0;
  };

  const cli = async (index: number, args: string[]) =>
    await docker(['exec', nodes[index], 'redis-cli', '-p', String(ports[index]), ...args], 15_000);

  const cluster: RedisCluster = {
    url: `redis://127.0.0.1:${ports[0]}`,
    ports,
    holder,
    nodes,
    stopNodes: async (indexes) => {
      await docker(['stop', '-t', '0', ...all(indexes)]);
    },
    startNodes: async (indexes) => {
      await docker(['start', ...all(indexes)]);
    },
    pauseNodes: async (indexes) => {
      await docker(['pause', ...all(indexes)]);
    },
    unpauseNodes: async (indexes) => {
      await docker(['unpause', ...all(indexes)]);
    },
    waitForClusterOk: async (timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      let last = '';

      while (Date.now() < deadline) {
        const infos = await Promise.all(
          nodes.map(async (_, index) => await cli(index, ['cluster', 'info']).catch((e) => String(e))),
        );

        last = infos.join('\n---\n');

        if (infos.every((info) => /cluster_state:ok/.test(info) && /cluster_slots_ok:16384/.test(info))) {
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      throw new Error(`The Redis Cluster did not reach cluster_state:ok within ${timeoutMs} ms:\n${last}`);
    },
    clientList: async () => {
      const lists = await Promise.all(
        nodes.map(async (_, index) => await cli(index, ['client', 'list']).catch(() => '')),
      );

      return lists
        .flatMap((list, index) => list.split('\n').map((line) => `node=${index + 1} ${line}`))
        .filter((line) => line.includes(' id='));
    },
    cli,
    monitor: () => {
      const lines: MonitorLine[] = [];
      const wakers = new Set<() => void>();
      const children = nodes.map((name, index) => {
        const child = spawn('docker', ['exec', name, 'redis-cli', '-p', String(ports[index]), 'monitor'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let partial = '';

        child.stdout.on('data', (chunk: Buffer) => {
          const at = Date.now();
          const parts = (partial + chunk.toString('utf8')).split('\n');

          partial = parts.pop() ?? '';
          lines.push(...parts.filter((line) => line.length > 0).map((line) => ({ at, node: index, line })));
          wakers.forEach((wake) => wake());
        });

        monitors.push(child);

        return child;
      });

      return {
        lines: () => [...lines],
        waitFor: async (predicate, timeoutMs, after = 0) =>
          await new Promise<MonitorLine>((resolve, reject) => {
            const check = () => {
              const found = lines.find((line) => line.at > after && predicate(line));

              if (found) {
                clearTimeout(timer);
                wakers.delete(check);
                resolve(found);
              }
            };
            const timer = setTimeout(() => {
              wakers.delete(check);
              reject(new Error(`No matching MONITOR line within ${timeoutMs} ms`));
            }, timeoutMs);

            wakers.add(check);
            check();
          }),
        stop: () => {
          for (const child of children) {
            child.kill('SIGKILL');
          }
        },
      };
    },
    denyReads: async () => {
      await Promise.all(
        nodes.map(
          async (_, index) =>
            await cli(index, [
              'acl',
              'setuser',
              'default',
              '-@all',
              '+@connection',
              '+cluster',
              '+info',
              '+acl',
              '+monitor',
              '+readonly',
              '+readwrite',
              '+asking',
            ]),
        ),
      );
    },
    allowReads: async () => {
      await Promise.all(nodes.map(async (_, index) => await cli(index, ['acl', 'setuser', 'default', '+@all'])));
    },
    teardown,
    logs: async () => {
      const parts = await Promise.all(
        nodes.map(async (name) => {
          const out = await run('docker', ['logs', name], { maxBuffer: 16 * 1024 * 1024 }).catch(() => null);

          return `=== ${name}\n${out ? `${out.stdout}${out.stderr}` : '(no logs)'}`;
        }),
      );

      return parts.join('\n');
    },
  };

  try {
    const publish = ports.flatMap((port) => ['-p', `127.0.0.1:${port}:${port}`]);

    await docker(['run', '-d', '--name', holder, ...publish, IMAGE, 'sleep', '2147483647'], 180_000);
    created.push(holder);

    for (const [index, name] of nodes.entries()) {
      const port = String(ports[index]);
      const busPort = String(BUS_PORT_BASE + index);

      await docker([
        'run',
        '-d',
        '--name',
        name,
        '--network',
        `container:${holder}`,
        IMAGE,
        'redis-server',
        '--port',
        port,
        '--cluster-enabled',
        'yes',
        '--cluster-config-file',
        `nodes-${port}.conf`,
        '--cluster-node-timeout',
        '5000',
        '--cluster-port',
        busPort,
        '--cluster-announce-ip',
        '127.0.0.1',
        '--cluster-announce-port',
        port,
        '--cluster-announce-bus-port',
        busPort,
        '--protected-mode',
        'no',
        '--appendonly',
        'no',
        '--save',
        '',
      ]);
      created.push(name);
    }

    // Each node answers PING before the cluster is created.
    for (const [index] of nodes.entries()) {
      const deadline = Date.now() + 30_000;

      while ((await cli(index, ['ping']).catch(() => '')) !== 'PONG') {
        if (Date.now() > deadline) {
          throw new Error(`Redis node ${nodes[index]} never answered PING`);
        }

        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    await docker(
      [
        'exec',
        nodes[0],
        'redis-cli',
        '--cluster',
        'create',
        ...ports.map((port) => `127.0.0.1:${port}`),
        '--cluster-replicas',
        '0',
        '--cluster-yes',
      ],
      60_000,
    );

    await cluster.waitForClusterOk();

    return cluster;
  } catch (error) {
    await teardown();
    throw error;
  }
};

/**
 * A fresh key prefix whose hash slot node `index` serves (CLUSTER KEYSLOT and
 * CLUSTER NODES). A client given only the seed node reaches bullmq's Mode A on
 * a freeze when its queue lives there (5 of 5 runs) and not when it lives on
 * another node (0 of 5), so the wedge specs keep their queues on node 0.
 */
export const prefixServedBy = async (cluster: RedisCluster, index: number, label: string) => {
  const line = (await cluster.cli(index, ['cluster', 'nodes'])).split('\n').find((entry) => entry.includes('myself'));
  // Importing and migrating entries ([slot->-node]) are not ranges this node serves.
  const ranges = (line ?? '')
    .split(' ')
    .slice(8)
    .filter((range) => /^\d+(-\d+)?$/.test(range))
    .map((range) => range.split('-').map(Number));

  if (ranges.length === 0) {
    throw new Error(`Redis node ${index} serves no slots:\n${line}`);
  }

  // A third of the slots are this node's, so 1000 misses in a row cannot happen.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const prefix = `{${label}-${randomUUID()}}`;
    const slot = Number(await cluster.cli(index, ['cluster', 'keyslot', prefix]));

    if (ranges.some(([from, to = from]) => slot >= from && slot <= to)) {
      return prefix;
    }
  }

  throw new Error(`No key prefix in 1000 tries hashed to a slot Redis node ${index} serves:\n${line}`);
};
