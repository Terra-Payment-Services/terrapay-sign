import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FullResult, Reporter, Suite } from '@playwright/test/reporter';

import { CREDENTIAL_NAME, encodedForms, envSources, secretValues, stripUrlCredentials } from './secret-values';

/**
 * Writes test-results/manifest.json at the end of every run, passing or
 * failing, so someone else can check what was tested and run it again: commit,
 * tree state, command, target, seed, tool versions and timing.
 *
 * It writes in onEnd because Playwright empties test-results/ after the
 * reporters start. It never copies process.env. The only variables it writes
 * are CI_COMMIT_SHA, CI_ENVIRONMENT_NAME, CI_JOB_NAME, CI_JOB_URL,
 * CI_PIPELINE_ID and npm_lifecycle_event, none of them secret. As a second
 * line, command arguments that name a credential are redacted, URLs lose
 * their credentials, and every secret value reporters/secret-values.ts
 * recognises is masked in each form it can take.
 *
 * Playwright constructs reporters with `new`, so this has to be a function
 * declaration: an arrow function throws "is not a constructor". A function
 * that returns an object satisfies `new` without a class.
 */
export default function ManifestReporter(): Reporter {
  let suite: Suite;
  let startedAt: Date;

  return {
    printsToStdio: () => false,

    onBegin: (_config, rootSuite) => {
      suite = rootSuite;
      startedAt = new Date();
    },

    onEnd: (result: FullResult) => {
      // This file sits in packages/app-tests/reporters/, beside the config's
      // test-results/ directory.
      const appTestsDir = path.resolve(__dirname, '..');
      const repoRoot = path.resolve(appTestsDir, '../..');
      const outputFile = path.join(appTestsDir, 'test-results', 'manifest.json');

      const manifest = {
        commit: {
          sha: git(repoRoot, ['rev-parse', 'HEAD']) ?? process.env.CI_COMMIT_SHA ?? null,
          workingTreeClean: workingTreeClean(repoRoot),
        },
        command: {
          line: ['npx', 'playwright', ...redactArgs(process.argv.slice(2)).map(shellQuote)].join(' '),
          npmScript: process.env.npm_lifecycle_event ?? null,
          cwd: path.relative(repoRoot, process.cwd()) || '.',
        },
        environment: {
          name: process.env.CI_ENVIRONMENT_NAME || (process.env.E2E_BASE_URL ? 'remote' : 'local'),
          ci: process.env.CI_JOB_ID
            ? {
                job: process.env.CI_JOB_NAME ?? null,
                jobUrl: process.env.CI_JOB_URL ?? null,
                pipelineId: process.env.CI_PIPELINE_ID ?? null,
              }
            : null,
          projects: suite.suites.map((projectSuite) => ({
            name: projectSuite.title,
            baseURL: baseUrlOf(projectSuite),
            tests: projectSuite.allTests().length,
          })),
        },
        seed: seedReference(repoRoot),
        tools: toolVersions(),
        run: {
          status: result.status,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
        },
      };

      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, maskSecrets(repoRoot, JSON.stringify(manifest, null, 2)) + '\n');
    },
  };
}

/**
 * The fixture a local run loads: `npm run prisma:seed` runs seed-database.ts,
 * and the specs seed their own rows through the helpers in seed/. A remote run
 * reads whatever the deployed instance holds, so the reference only describes
 * local runs there.
 */
const SEED_PATHS = ['packages/prisma/seed-database.ts', 'packages/prisma/seed'];

const seedReference = (repoRoot: string) => {
  const files = SEED_PATHS.flatMap((seedPath) => listFiles(repoRoot, seedPath)).sort();
  const hash = createHash('sha256');

  for (const file of files) {
    hash.update(file + '\0');
    hash.update(fs.readFileSync(path.join(repoRoot, file)));
    hash.update('\0');
  }

  return {
    identifier: SEED_PATHS.join(' + '),
    files: files.length,
    sha256: files.length > 0 ? hash.digest('hex') : null,
    appliesTo: 'local runs; a remote run uses the data on the deployed instance',
  };
};

const listFiles = (repoRoot: string, relativePath: string): string[] => {
  const absolutePath = path.join(repoRoot, relativePath);

  if (!fs.existsSync(absolutePath)) {
    return [];
  }

  if (!fs.statSync(absolutePath).isDirectory()) {
    return [relativePath];
  }

  return fs.readdirSync(absolutePath).flatMap((entry) => listFiles(repoRoot, path.posix.join(relativePath, entry)));
};

const toolVersions = () => {
  const playwrightCore = path.dirname(require.resolve('playwright-core/package.json'));
  const browsers: Array<{ name: string; revision: string; browserVersion?: string }> = JSON.parse(
    fs.readFileSync(path.join(playwrightCore, 'browsers.json'), 'utf8'),
  ).browsers;
  const chromium = browsers.find((browser) => browser.name === 'chromium');

  return {
    node: process.version,
    playwright: require('@playwright/test/package.json').version as string,
    chromium: chromium ? `${chromium.browserVersion} (revision ${chromium.revision})` : null,
  };
};

/** Quotes an argument the way a POSIX shell needs it, so the line reruns as written. */
const shellQuote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

const git = (cwd: string, args: string[]) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const workingTreeClean = (repoRoot: string) => {
  const porcelain = git(repoRoot, ['status', '--porcelain']);

  if (porcelain === null) {
    return null;
  }

  return porcelain === '';
};

const baseUrlOf = (projectSuite: Suite) => {
  const baseURL = projectSuite.project()?.use.baseURL;

  return baseURL ? stripUrlCredentials(baseURL) : null;
};

/**
 * Arguments as given, except the value of any flag whose name looks like a
 * credential, in either `--flag=value` or `--flag value` form. An argument
 * containing "://" keeps only what stripUrlCredentials returns for it, and is
 * redacted whole when that is nothing.
 */
const redactArgs = (args: string[]) =>
  args.map((arg, index) => {
    const inline = /^(--?[\w-]+)=/.exec(arg);

    if (inline && CREDENTIAL_NAME.test(inline[1])) {
      return `${inline[1]}=[REDACTED]`;
    }

    const previous = args[index - 1];

    if (previous && /^--?[\w-]+$/.test(previous) && CREDENTIAL_NAME.test(previous)) {
      return '[REDACTED]';
    }

    return arg.includes('://') ? (stripUrlCredentials(arg) ?? '[REDACTED]') : arg;
  });

const maskSecrets = (repoRoot: string, text: string) =>
  secretValues(envSources(repoRoot))
    .values.flatMap(encodedForms)
    .sort((a, b) => b.length - a.length)
    .reduce((masked, form) => masked.split(form).join('[REDACTED]'), text);
