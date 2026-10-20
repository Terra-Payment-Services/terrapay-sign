/**
 * The dead signature-settings schema is deleted.
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md,
 * section 10) before any change.
 *
 * | Criterion | Test                                                              |
 * | --------- | ----------------------------------------------------------------- |
 * | C99       | C99 git grep finds no ZDocumentSignatureSettingsSchema             |
 * | C99       | C99 npx tsc --noEmit in packages/lib reports no error the merge-base with main does not |
 *
 * The tsc half asserts that G4 adds no type errors to packages/lib (spec, "Amendments after the red run"; amended
 * in "Round after CI pipeline 55464" and "Round after Codex r9", C99b). tsc runs twice: at HEAD, and on a detached
 * worktree of the merge-base with main. An error is new when its (file, code, message) occurs more often at HEAD
 * than at the base; line and column are left out, so an edit that shifts lines moves no error. A new error in a
 * file the branch did not change, a caller broken through a changed signature, therefore fails C99. lib imports
 * itself through the @documenso workspace link, so the base worktree gets its own node_modules/@documenso links to
 * its own packages; it sits under the repo's node_modules so every other package resolves from the repo's install.
 * The generated Prisma client is linked from HEAD, which is sound only while the branch leaves packages/prisma
 * alone; a premise asserts that. The merge-base is origin/main's, else CI_MERGE_REQUEST_DIFF_BASE_SHA, fetched
 * into a shallow clone if absent. It records the base, both error lists and the new errors.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { keepRecord } from '../fixtures/reject-seal';

const WORKTREE_ROOT = path.join(__dirname, '../../../..');

const gitGrep = (pattern: string, paths: string[]) => {
  try {
    return execFileSync('git', ['grep', '-n', pattern, '--', ...paths], { cwd: WORKTREE_ROOT, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) {
      return [];
    }

    throw error;
  }
};

test('C99 git grep finds no ZDocumentSignatureSettingsSchema', async () => {
  expect(
    gitGrep('ZDocumentMetaTypedSignatureEnabledSchema', ['packages']).length,
    'premise: git grep works',
  ).toBeGreaterThan(0);

  // This file names the schema itself; once committed, git grep would find it here, so it is excluded.
  expect(
    gitGrep('ZDocumentSignatureSettingsSchema', [
      'packages',
      'apps',
      ':(exclude)packages/app-tests/e2e/signature-ink/dead-code-gone.spec.ts',
    ]),
  ).toEqual([]);
});

/** The merge-base with main: origin/main, else the MR's diff base, fetched if the clone lacks it. */
const mergeBase = () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: WORKTREE_ROOT, encoding: 'utf8' }).trim();
  const has = (sha: string) => {
    try {
      git('cat-file', '-e', `${sha}^{commit}`);

      return true;
    } catch {
      return false;
    }
  };

  try {
    return git('merge-base', 'HEAD', 'origin/main');
  } catch {
    const base = process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA;

    if (!base) {
      return null;
    }

    if (!has(base)) {
      try {
        git('fetch', '--no-tags', '--depth=1', 'origin', base);
      } catch {
        return null;
      }
    }

    return has(base) ? base : null;
  }
};

/** One tsc diagnostic, without its position: `file(line,col): error TSnnnn: message`. */
const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/;

const tscLib = (root: string) => {
  try {
    execFileSync('npx', ['tsc', '--noEmit'], {
      cwd: path.join(root, 'packages/lib'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return { exitCode: 0, errors: [] as string[] };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };

    return {
      exitCode: failure.status ?? -1,
      errors: (failure.stdout ?? '').split('\n').filter((line) => DIAGNOSTIC.test(line)),
    };
  }
};

const diagnosticKey = (line: string) => {
  const [, file, code, message] = DIAGNOSTIC.exec(line) ?? [];

  return `${file} ${code} ${message}`;
};

/** A detached worktree of `base` whose @documenso packages resolve to its own packages, not HEAD's. */
const baseWorktree = (base: string) => {
  const root = path.join(WORKTREE_ROOT, 'node_modules/.cache', `c99-base-${process.pid}`);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: WORKTREE_ROOT, encoding: 'utf8' });

  git('worktree', 'add', '--detach', '--force', root, base);

  const links = path.join(WORKTREE_ROOT, 'node_modules/@documenso');
  const ownLinks = path.join(root, 'node_modules/@documenso');

  fs.mkdirSync(ownLinks, { recursive: true });

  for (const name of fs.readdirSync(links)) {
    const link = path.join(links, name);

    if (fs.lstatSync(link).isSymbolicLink()) {
      const target = path.relative(WORKTREE_ROOT, path.resolve(links, fs.readlinkSync(link)));

      fs.symlinkSync(path.join(root, target), path.join(ownLinks, name));
    }
  }

  fs.symlinkSync(path.join(WORKTREE_ROOT, 'packages/prisma/generated'), path.join(root, 'packages/prisma/generated'));

  return {
    root,
    remove: () => git('worktree', 'remove', '--force', root),
  };
};

test('C99 npx tsc --noEmit in packages/lib reports no error the merge-base with main does not', async () => {
  test.setTimeout(20 * 60_000);

  const base = mergeBase();

  expect(
    base,
    'premise: the merge-base with main is found (origin/main or CI_MERGE_REQUEST_DIFF_BASE_SHA)',
  ).toBeTruthy();

  const prismaChanges = execFileSync('git', ['diff', '--name-only', `${base}`, 'HEAD', '--', 'packages/prisma'], {
    cwd: WORKTREE_ROOT,
    encoding: 'utf8',
  }).trim();

  expect(prismaChanges, "premise: packages/prisma is unchanged, so HEAD's generated client fits the base").toBe('');

  const head = tscLib(WORKTREE_ROOT);
  const worktree = baseWorktree(`${base}`);
  let atBase: ReturnType<typeof tscLib>;

  try {
    atBase = tscLib(worktree.root);
  } finally {
    worktree.remove();
  }

  const baseCounts = new Map<string, number>();

  for (const line of atBase.errors) {
    baseCounts.set(diagnosticKey(line), (baseCounts.get(diagnosticKey(line)) ?? 0) + 1);
  }

  const newErrors = head.errors.filter((line) => {
    const remaining = baseCounts.get(diagnosticKey(line)) ?? 0;

    baseCounts.set(diagnosticKey(line), remaining - 1);

    return remaining <= 0;
  });

  await keepRecord('C99-tsc-lib.json', {
    base,
    head: { exitCode: head.exitCode, errors: head.errors },
    atBase: { exitCode: atBase.exitCode, errors: atBase.errors },
    newErrors,
  });

  for (const run of [head, atBase]) {
    expect(run.exitCode === 0 || run.errors.length > 0, 'premise: tsc ran and either passed or reported errors').toBe(
      true,
    );
  }

  expect(newErrors, 'tsc errors in packages/lib at HEAD that the merge-base with main does not have').toEqual([]);
});
