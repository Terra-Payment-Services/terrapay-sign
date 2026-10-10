import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Specification tests for the artifact secret scan (criteria 1 to 5
 * and 7). Written from the specification alone, without reading the scan.
 *
 * Each test builds a repository-shaped temporary tree, copies the real scan
 * into it, writes a run output, and runs the scan as CI does:
 * `npx tsx scripts/check-artifact-secrets.ts` from packages/app-tests, with
 * e2e-artifacts/SCAN-DID-NOT-PASS.txt written beforehand. The child process
 * gets an explicit environment and never inherits this one.
 *
 * Failure modes these tests are meant to catch:
 *
 * - A clean run is not published, or is published incompletely or altered.
 * - A credential from the environment reaches e2e-artifacts/.
 * - A credential from .env, .env.local or .env.<NODE_ENV> reaches it.
 * - A credential in URL-encoded, base64 or JSON-escaped form reaches it.
 * - A credential inside a binary file (a screenshot) reaches it.
 * - A password inside a database URL reaches it.
 * - A signing link, embed signing link or ?token= link issued during the run
 *   reaches it (F1, and F4: the link of an envelope the cleanup left behind).
 * - A Sign API token or a bearer token reaches it (F1).
 * - The scan prints the credential it found into the job log.
 * - The scan fails without saying which file or which kind of credential.
 * - A credential too short to search for is warned about and published (F2).
 * - An unreadable file, a malformed results file or a missing run output is
 *   published anyway (F3).
 * - Amended 4a: the local job's run, whose tokens die with its database
 *   container, is withheld for holding signing links; or the local mode lets
 *   an environment, dotenv or short secret through; or a missing or unknown
 *   mode skips the patterns.
 * - Amended 4b: a remote run whose report holds signing links publishes
 *   anything beyond its manifest, publishes nothing at all when the manifest is
 *   clean, or publishes a manifest that itself fails a check.
 */

const APP_TESTS = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_TESTS, '../..');
const NOTE = 'SCAN-DID-NOT-PASS.txt';

// Distinct in every form: '/', '+', '=', '"', '\', ' ', '@' and ':' change
// under URL encoding, and '"' and '\' change under JSON escaping.
const SECRET = 'Tq9/x+Rz="k\\ m@w:7Lp';

const formsOf = (secret: string) => ({
  plain: secret,
  urlEncoded: encodeURIComponent(secret),
  base64: Buffer.from(secret, 'utf8').toString('base64'),
  jsonEscaped: JSON.stringify(secret).slice(1, -1),
});

// Realistic shapes. Recipient tokens are nanoid() (21 of A-Za-z0-9_-); API
// tokens are `api_` and alphaid(16), lower case and digits.
const RECIPIENT_TOKEN = 'V1StGXR8_Z5jdHi6B-myT';
const EMBED_TOKEN = 'Kp3vQ9zLm2Xw8Rt5Yb-1_';
const QUERY_TOKEN = 'Hn7cWq2Ze5Ux9Ma4Lk0-P';
const API_TOKEN = 'api_k3n9x0q2w8e7r5t1';
const BEARER_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.Q2xhdWRpYVNpZ25zSXQ';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Files = Record<string, string | Buffer>;

type RunOptions = {
  env?: Record<string, string>;
  dotenv?: Record<string, Record<string, string>>;
  files?: Files;
  omit?: string[];
  prepare?: (appTests: string) => void;
};

type Run = {
  status: number | null;
  log: string;
  appTests: string;
  artifacts: string;
  files: Files;
};

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A PNG-like binary: a real signature, then bytes with no printable runs. */
const pngWith = (payload?: string) => {
  const noise = Buffer.from(Array.from({ length: 512 }, (_, i) => ((i * 7) % 256) | 0x80));

  if (payload === undefined) {
    return Buffer.concat([PNG_HEADER, noise]);
  }

  return Buffer.concat([PNG_HEADER, noise.subarray(0, 256), Buffer.from(payload, 'utf8'), noise.subarray(256)]);
};

const junitWith = (failure = '', systemOut = '') =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites id="" name="" tests="2" failures="1" skipped="0" errors="0" time="4.2">',
    '<testsuite name="remote/health.spec.ts" timestamp="2026-10-06T10:00:00.000Z" hostname="remote" tests="2" failures="1" skipped="0" time="4.2" errors="0">',
    '<testcase name="the health endpoint answers" classname="remote/health.spec.ts" time="1.1"></testcase>',
    '<testcase name="the signing journey completes" classname="remote/signing-journey.spec.ts" time="3.1">',
    `<failure message="journey failed" type="FAILURE"><![CDATA[Error: expected 200 ${failure}]]></failure>`,
    `<system-out><![CDATA[${systemOut}]]></system-out>`,
    '</testcase>',
    '</testsuite>',
    '</testsuites>',
    '',
  ].join('\n');

const resultsWith = (message = 'expect(received).toBe(expected)', extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      config: { version: '1.56.1' },
      suites: [
        {
          title: 'remote/signing-journey.spec.ts',
          specs: [
            {
              title: 'the signing journey completes',
              tests: [{ results: [{ status: 'failed', error: { message }, ...extra }] }],
            },
          ],
        },
      ],
      stats: { expected: 1, unexpected: 1 },
    },
    null,
    2,
  );

const reportWith = (body = '<p>2 tests, 1 failed</p>') =>
  `<!DOCTYPE html><html><head><title>Playwright Test Report</title></head><body>${body}</body></html>\n`;

const cleanFiles = (): Files => ({
  'test-results/junit.xml': junitWith(),
  'test-results/results.json': resultsWith(),
  'test-results/manifest.json': JSON.stringify({ commit: 'c94b814f2', command: 'playwright test --project=remote' }),
  'test-results/remote-signing-journey-the-signing-journey-completes/test-failed-1.png': pngWith(),
  'test-results/remote-signing-journey-the-signing-journey-completes/error-context.md':
    '# Page snapshot\n\n- heading "Documents"\n',
  'playwright-report/index.html': reportWith(),
  'playwright-report/data/3f2a9c.png': pngWith(),
});

const copyInto = (from: string, to: string) => {
  fs.cpSync(from, to, { recursive: true });
};

/** Sets KEY in an env file the way CI does: replace the line if present, else append. */
const withVariables = (contents: string, variables: Record<string, string>) => {
  let next = contents;

  for (const [key, value] of Object.entries(variables)) {
    const line = `${key}="${value}"`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');

    next = pattern.test(next) ? next.replace(pattern, line) : `${next.trimEnd()}\n${line}\n`;
  }

  return next;
};

const runScan = (options: RunOptions = {}): Run => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-scan-')));
  roots.push(root);

  const appTests = path.join(root, 'packages/app-tests');
  fs.mkdirSync(appTests, { recursive: true });

  copyInto(path.join(APP_TESTS, 'scripts'), path.join(appTests, 'scripts'));
  copyInto(path.join(APP_TESTS, 'reporters'), path.join(appTests, 'reporters'));
  fs.copyFileSync(path.join(APP_TESTS, 'package.json'), path.join(appTests, 'package.json'));
  fs.copyFileSync(path.join(APP_TESTS, 'tsconfig.json'), path.join(appTests, 'tsconfig.json'));
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'));

  if (fs.existsSync(path.join(APP_TESTS, 'node_modules'))) {
    fs.symlinkSync(path.join(APP_TESTS, 'node_modules'), path.join(appTests, 'node_modules'));
  }

  // CI starts from `cp .env.example .env`, so every run here does as well.
  const example = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
  fs.writeFileSync(path.join(root, '.env.example'), example);

  const dotenv = { '.env': {}, ...options.dotenv };

  for (const [file, variables] of Object.entries(dotenv)) {
    const base = file === '.env' ? example : '';
    fs.writeFileSync(path.join(root, file), withVariables(base, variables));
  }

  const files = { ...cleanFiles(), ...options.files };

  for (const omitted of options.omit ?? []) {
    for (const name of Object.keys(files)) {
      if (name === omitted || name.startsWith(`${omitted}/`)) {
        delete files[name];
      }
    }
  }

  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(appTests, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  // What both CI jobs write before the suite starts.
  fs.mkdirSync(path.join(appTests, 'e2e-artifacts'), { recursive: true });
  fs.writeFileSync(path.join(appTests, 'e2e-artifacts', NOTE), 'The artifact secret scan did not run.\n');

  options.prepare?.(appTests);

  // Cast: the repo augments ProcessEnv with names a scan run must not inherit.
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    TMPDIR: os.tmpdir(),
    ...options.env,
  } as unknown as NodeJS.ProcessEnv;

  const result = spawnSync(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), ['scripts/check-artifact-secrets.ts'], {
    cwd: appTests,
    env,
    encoding: 'utf8',
    timeout: 50_000,
  });

  return {
    status: result.status,
    log: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`,
    appTests,
    artifacts: path.join(appTests, 'e2e-artifacts'),
    files,
  };
};

const listFiles = (dir: string): string[] => {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
};

/** Nothing from the run output is in e2e-artifacts/: at most CI's own note. */
const expectNothingPublished = (run: Run) => {
  expect(run.status, `the scan should fail; log:\n${run.log}`).not.toBe(0);
  expect(listFiles(run.artifacts).filter((name) => name !== NOTE)).toEqual([]);
};

const expectLogWithout = (run: Run, values: string[]) => {
  for (const value of values) {
    expect(run.log.includes(value), `the log must not contain ${JSON.stringify(value)}`).toBe(false);
  }
};

describe('a clean run', () => {
  it('when_run_output_holds_no_credential_should_exit_0_and_copy_it_to_e2e_artifacts', () => {
    const run = runScan({ env: { E2E_REMOTE_API_TOKEN: SECRET } });

    expect(run.status, `log:\n${run.log}`).toBe(0);

    // CI reports e2e-artifacts/test-results/junit.xml, so the copy keeps the
    // run output's own layout under e2e-artifacts/.
    for (const [name, contents] of Object.entries(run.files)) {
      const copy = path.join(run.artifacts, name);

      expect(fs.existsSync(copy), `${name} should be published`).toBe(true);
      expect(fs.readFileSync(copy).equals(Buffer.from(contents)), `${name} should be copied unchanged`).toBe(true);
    }

    expectLogWithout(run, Object.values(formsOf(SECRET)));
  });
});

describe('a credential the run was given', () => {
  const forms = formsOf(SECRET);

  it.each([
    ['plain', 'test-results/junit.xml', junitWith(`token was ${forms.plain}`)],
    [
      'URL-encoded',
      'playwright-report/index.html',
      reportWith(`<a href="https://example.test/cb?state=${forms.urlEncoded}">retry</a>`),
    ],
    [
      'base64',
      'test-results/results.json',
      resultsWith('request failed', { attachments: [{ name: 'request', body: forms.base64 }] }),
    ],
    ['JSON-escaped', 'test-results/results.json', resultsWith(`login failed for ${SECRET}`)],
    [
      'plain, inside a screenshot',
      'test-results/remote-signing-journey-the-signing-journey-completes/test-failed-1.png',
      pngWith(forms.plain),
    ],
  ])('when_the_environment_value_appears_%s_in_a_file_should_publish_nothing_and_name_file_and_variable', (_form, file, contents) => {
    const run = runScan({ env: { E2E_REMOTE_API_TOKEN: SECRET }, files: { [file]: contents } });

    expectNothingPublished(run);
    expect(run.log).toContain(path.basename(file));
    expect(run.log).toContain('E2E_REMOTE_API_TOKEN');
    expectLogWithout(run, Object.values(forms));
  });

  it('when_the_json_escaped_form_is_written_the_fixture_does_not_also_hold_the_plain_form', () => {
    // Guards the JSON-escaped case above against passing on a plain match.
    expect(resultsWith(`login failed for ${SECRET}`).includes(SECRET)).toBe(false);
    expect(resultsWith(`login failed for ${SECRET}`).includes(forms.jsonEscaped)).toBe(true);
  });

  const DOTENV_SECRET = 'Lw4nR8tYq2Vz6Hb9';

  it.each([
    ['.env', 'NEXTAUTH_SECRET', undefined],
    ['.env.local', 'NEXT_PRIVATE_ENCRYPTION_KEY', undefined],
    ['.env.test', 'NEXT_PRIVATE_SMTP_PASSWORD', 'test'],
  ])('when_a_value_from_%s_appears_in_a_file_should_publish_nothing_and_name_the_variable', (file, name, nodeEnv) => {
    const run = runScan({
      env: nodeEnv ? { NODE_ENV: nodeEnv } : {},
      dotenv: { [file]: { [name]: DOTENV_SECRET } },
      files: { 'test-results/results.json': resultsWith(`unexpected value ${DOTENV_SECRET}`) },
    });

    expectNothingPublished(run);
    expect(run.log).toContain('results.json');
    expect(run.log).toContain(name);
    expectLogWithout(run, [DOTENV_SECRET]);
  });

  it('when_the_password_of_a_database_url_in_env_appears_alone_should_publish_nothing', () => {
    const password = 'Wz8hPq2Lm4Xc';
    const url = `postgres://sign_user:${password}@127.0.0.1:15433/sign_db`;
    const run = runScan({
      dotenv: { '.env': { NEXT_PRIVATE_DATABASE_URL: url } },
      files: { 'test-results/junit.xml': junitWith(`auth failed with ${password}`) },
    });

    expectNothingPublished(run);
    expect(run.log).toContain('junit.xml');
    expectLogWithout(run, [password]);
  });
});

/** Credentials issued while a run is in progress: kind, file, contents, token, kind in log. */
const ISSUED_CREDENTIALS: [string, string, string, string, RegExp][] = [
  [
    'a signing link',
    'test-results/results.json',
    resultsWith(`page.goto: net::ERR_ABORTED at https://sign.example.com/sign/${RECIPIENT_TOKEN}`),
    RECIPIENT_TOKEN,
    /token|link|sign/i,
  ],
  [
    'an embed signing link',
    'playwright-report/index.html',
    reportWith(`<iframe src="https://sign.example.com/embed/sign/${EMBED_TOKEN}"></iframe>`),
    EMBED_TOKEN,
    /token|link|sign/i,
  ],
  [
    'a ?token= link',
    'test-results/junit.xml',
    junitWith('', `GET https://sign.example.com/d/abc123?token=${QUERY_TOKEN} 404`),
    QUERY_TOKEN,
    /token/i,
  ],
  ['a Sign API token', 'test-results/junit.xml', junitWith(`created with ${API_TOKEN}`), API_TOKEN, /api/i],
  [
    'a bearer token in an Authorization header',
    'test-results/remote-signing-journey-the-signing-journey-completes/error-context.md',
    `# Request\n\nPOST /api/v2/envelope/delete\nAuthorization: Bearer ${BEARER_TOKEN}\n`,
    BEARER_TOKEN,
    /bearer|authori[sz]ation/i,
  ],
  [
    'a bearer token in a JSON-recorded Authorization header',
    'test-results/results.json',
    resultsWith('request failed', { request: { headers: { authorization: `Bearer ${BEARER_TOKEN}` } } }),
    BEARER_TOKEN,
    /bearer|authori[sz]ation/i,
  ],
  [
    'the signing link of an envelope the cleanup left behind (F4)',
    'test-results/results.json',
    resultsWith(
      `envelope/delete returned 500; envelope still open at https://sign.example.com/sign/${RECIPIENT_TOKEN}`,
    ),
    RECIPIENT_TOKEN,
    /token|link|sign/i,
  ],
];

describe('a credential issued during the run, which no variable holds', () => {
  it.each(
    ISSUED_CREDENTIALS,
  )('when_run_output_holds_%s_should_publish_nothing_and_name_file_and_kind', (_kind, file, contents, token, kind) => {
    // No variable anywhere holds the token: it was issued while the run was in progress.
    const run = runScan({ env: { E2E_REMOTE_API_TOKEN: SECRET }, files: { [file]: contents } });

    expectNothingPublished(run);
    expect(run.log).toContain(path.basename(file));
    expect(run.log.replaceAll(path.basename(file), '')).toMatch(kind);
    expectLogWithout(run, [token]);
  });
});

describe('a credential too short to search for', () => {
  it.each([
    ['the environment', { env: { E2E_REMOTE_API_TOKEN: 'Zq7' } }],
    ['.env', { dotenv: { '.env': { NEXTAUTH_SECRET: 'Zq7' } } }],
  ])('when_a_credential_from_%s_is_too_short_should_publish_nothing_and_name_the_variable', (_source, options) => {
    const run = runScan(options as RunOptions);
    const name = 'env' in (options as RunOptions) ? 'E2E_REMOTE_API_TOKEN' : 'NEXTAUTH_SECRET';

    expectNothingPublished(run);
    expect(run.log).toContain(name);
  });

  // GitLab runner feature flags, set on every job and observed on pipeline
  // 54270: booleans whose names contain TOKEN or AUTH.
  it('when_the_runner_sets_its_feature_flags_should_publish_the_run', () => {
    const flags = {
      FF_DISABLE_AUTOMATIC_TOKEN_ROTATION: 'false',
      FF_GIT_URLS_WITHOUT_TOKENS: 'false',
      FF_HASH_CACHE_KEYS: 'false',
      FF_MASK_ALL_DEFAULT_TOKENS: 'true',
      FF_SECRET_RESOLVING_FAILS_IF_MISSING: 'true',
      FF_USE_GIT_PROACTIVE_AUTH: 'false',
    };
    const run = runScan({ env: { E2E_REMOTE_API_TOKEN: SECRET, ...flags } });

    expectPublishedUnchanged(run);
  });

  // Loopback host settings, observed on pipeline 54474: the webhook receiver
  // a spec starts is reached at 127.0.0.1, which .env.example also gives the
  // SMTP host, so the address appears in the run's output.
  it('when_a_host_setting_is_the_loopback_address_should_publish_the_run', () => {
    const run = runScan({
      env: {
        E2E_REMOTE_API_TOKEN: SECRET,
        NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS: '127.0.0.1',
        NEXT_PRIVATE_SMTP_HOST: '127.0.0.1',
      },
      files: { 'test-results/results.json': resultsWith('webhook delivered to http://127.0.0.1:4100/hook') },
    });

    expectPublishedUnchanged(run);
  });
});

describe('an error in the scan itself', () => {
  it('when_a_run_output_file_is_unreadable_should_publish_nothing', () => {
    const unreadable = 'test-results/remote-signing-journey-the-signing-journey-completes/trace.zip';
    const run = runScan({
      env: { E2E_REMOTE_API_TOKEN: SECRET },
      files: { [unreadable]: Buffer.from('PK\u0003\u0004 trace') },
      prepare: (appTests) => fs.chmodSync(path.join(appTests, unreadable), 0o000),
    });

    fs.chmodSync(path.join(run.appTests, unreadable), 0o644);

    expectNothingPublished(run);
    expect(run.log).toContain('trace.zip');
  });

  it('when_results_json_cannot_be_parsed_should_publish_nothing', () => {
    const run = runScan({
      env: { E2E_REMOTE_API_TOKEN: SECRET },
      files: { 'test-results/results.json': '{"suites": [{"title": "remote/sign' },
    });

    expectNothingPublished(run);
  });

  it('when_the_run_output_is_missing_should_publish_nothing', () => {
    const run = runScan({ env: { E2E_REMOTE_API_TOKEN: SECRET }, omit: ['test-results', 'playwright-report'] });

    expectNothingPublished(run);
    expect(run.log).toMatch(/test-results/);
  });
});

/**
 * Amended criteria 4a and 4b. The job sets the scan's mode; the specification
 * does not yet say how. These tests ASSUME an environment variable
 * ARTIFACT_SCAN_MODE with the values `local` (e2e_local) and `remote`
 * (e2e_staging). If the interface lands differently, change MODE below and
 * the CI job rules, not the expectations.
 */
const MODE = 'ARTIFACT_SCAN_MODE';
const MANIFEST = 'test-results/manifest.json';

/** Every file of the run output is in e2e-artifacts/, byte for byte. */
const expectPublishedUnchanged = (run: Run) => {
  expect(run.status, `the scan should pass; log:\n${run.log}`).toBe(0);

  for (const [name, contents] of Object.entries(run.files)) {
    const copy = path.join(run.artifacts, name);

    expect(fs.existsSync(copy), `${name} should be published`).toBe(true);
    expect(fs.readFileSync(copy).equals(Buffer.from(contents)), `${name} should be copied unchanged`).toBe(true);
  }
};

/** What a passing remote journey leaves in its report: the recipient's signing link. */
const passingJourneyReport = (): Files => ({
  'playwright-report/index.html': reportWith(
    `<p>1 passed</p><a href="https://sign.example.com/sign/${RECIPIENT_TOKEN}">signing page</a>`,
  ),
  'test-results/results.json': resultsWith('', {
    status: 'passed',
    stdout: [{ text: `opened https://sign.example.com/sign/${RECIPIENT_TOKEN}` }],
  }),
});

describe('amended 4a: the local mode, whose tokens die with the job', () => {
  it.each(
    ISSUED_CREDENTIALS,
  )('when_local_run_output_holds_%s_and_no_environment_secret_should_publish_it', (_kind, file, contents) => {
    const run = runScan({ env: { [MODE]: 'local', E2E_REMOTE_API_TOKEN: SECRET }, files: { [file]: contents } });

    expectPublishedUnchanged(run);
  });

  it('when_local_run_output_holds_every_kind_of_issued_token_at_once_should_publish_it', () => {
    const files = Object.fromEntries(
      ISSUED_CREDENTIALS.map(([kind, , contents]) => [
        `test-results/issued/${kind.replace(/\W+/g, '-')}.txt`,
        contents,
      ]),
    );
    const run = runScan({ env: { [MODE]: 'local', E2E_REMOTE_API_TOKEN: SECRET }, files });

    expectPublishedUnchanged(run);
  });

  it('when_local_run_output_holds_an_environment_secret_beside_signing_links_should_publish_nothing', () => {
    const run = runScan({
      env: { [MODE]: 'local', E2E_REMOTE_API_TOKEN: SECRET },
      files: { ...passingJourneyReport(), 'test-results/junit.xml': junitWith(`token was ${SECRET}`) },
    });

    expectNothingPublished(run);
    expect(run.log).toContain('junit.xml');
    expect(run.log).toContain('E2E_REMOTE_API_TOKEN');
    expectLogWithout(run, Object.values(formsOf(SECRET)));
  });

  it('when_local_run_output_holds_a_dotenv_secret_should_publish_nothing', () => {
    const value = 'Lw4nR8tYq2Vz6Hb9';
    const run = runScan({
      env: { [MODE]: 'local' },
      dotenv: { '.env': { NEXTAUTH_SECRET: value } },
      files: { 'test-results/results.json': resultsWith(`unexpected value ${value}`) },
    });

    expectNothingPublished(run);
    expect(run.log).toContain('NEXTAUTH_SECRET');
    expectLogWithout(run, [value]);
  });

  it('when_a_local_run_has_a_credential_too_short_to_search_for_should_publish_nothing', () => {
    const run = runScan({ env: { [MODE]: 'local', E2E_REMOTE_API_TOKEN: 'Zq7' } });

    expectNothingPublished(run);
    expect(run.log).toContain('E2E_REMOTE_API_TOKEN');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['unknown', 'staging'],
    ['a case variant of local', 'LOCAL'],
  ])('when_the_mode_is_%s_should_apply_the_patterns_and_publish_nothing', (_label, mode) => {
    const env: Record<string, string> = { E2E_REMOTE_API_TOKEN: SECRET };

    if (mode !== undefined) {
      env[MODE] = mode;
    }

    const run = runScan({
      env,
      files: { 'test-results/junit.xml': junitWith(`created with ${API_TOKEN}`) },
    });

    expectNothingPublished(run);
    expectLogWithout(run, [API_TOKEN]);
  });
});

describe('amended 4b: the remote mode, whose tokens are real', () => {
  it('when_a_remote_report_holds_a_signing_link_and_the_manifest_is_clean_should_publish_the_manifest_alone', () => {
    const run = runScan({ env: { [MODE]: 'remote', E2E_REMOTE_API_TOKEN: SECRET }, files: passingJourneyReport() });

    const published = listFiles(run.artifacts).filter((name) => name !== NOTE);

    expect(published, `log:\n${run.log}`).toEqual([MANIFEST]);
    expect(fs.readFileSync(path.join(run.artifacts, MANIFEST)).equals(Buffer.from(run.files[MANIFEST]))).toBe(true);
    expect(run.log).toContain('index.html');
    expectLogWithout(run, [RECIPIENT_TOKEN]);
  });

  it('when_a_remote_run_manifest_holds_a_signing_link_should_publish_nothing', () => {
    const run = runScan({
      env: { [MODE]: 'remote', E2E_REMOTE_API_TOKEN: SECRET },
      files: {
        ...passingJourneyReport(),
        [MANIFEST]: JSON.stringify({
          commit: 'c94b814f2',
          target: `https://sign.example.com/sign/${RECIPIENT_TOKEN}`,
        }),
      },
    });

    expectNothingPublished(run);
    expect(run.log).toContain('manifest.json');
    expectLogWithout(run, [RECIPIENT_TOKEN]);
  });

  it('when_a_remote_run_manifest_holds_an_environment_secret_should_publish_nothing', () => {
    const run = runScan({
      env: { [MODE]: 'remote', E2E_REMOTE_API_TOKEN: SECRET },
      files: {
        ...passingJourneyReport(),
        [MANIFEST]: JSON.stringify({ commit: 'c94b814f2', command: `playwright test --token ${SECRET}` }),
      },
    });

    expectNothingPublished(run);
    expect(run.log).toContain('manifest.json');
    expectLogWithout(run, Object.values(formsOf(SECRET)));
  });

  it('when_a_remote_run_holds_a_signing_link_and_the_manifest_is_missing_should_publish_nothing', () => {
    const run = runScan({
      env: { [MODE]: 'remote', E2E_REMOTE_API_TOKEN: SECRET },
      files: passingJourneyReport(),
      omit: [MANIFEST],
    });

    expect(listFiles(run.artifacts).filter((name) => name !== NOTE)).toEqual([]);
  });

  it('when_a_remote_run_output_is_clean_should_publish_all_of_it', () => {
    const run = runScan({ env: { [MODE]: 'remote', E2E_REMOTE_API_TOKEN: SECRET } });

    expectPublishedUnchanged(run);
  });
});

/**
 * Criterion 11: the issued-credential patterns also find links and bearer
 * values written URL-encoded (%2F, %3F, %3D, %20) or JSON slash-escaped (\/).
 * Mode semantics as in 4a and 4b; ARTIFACT_SCAN_MODE is still an assumption.
 *
 * Columns: kind, file, contents, token, whether the finding is a signing link
 * (which a remote run may answer by publishing its clean manifest alone).
 */
const SLASH_TOKEN = 'Zm9vYmFy/YmF6cXV4+c2lnbmVk/T2tlbg==';

const slashEscaped = (json: string) => json.replaceAll('/', '\\/');

const ENCODED_CREDENTIALS: [string, string, string, string, string, boolean][] = [
  [
    'a URL-encoded signing link',
    'playwright-report/index.html',
    reportWith(
      `<a href="https://sign.example.com/login?next=https%3A%2F%2Fsign.example.com%2Fsign%2F${RECIPIENT_TOKEN}">x</a>`,
    ),
    RECIPIENT_TOKEN,
    '/sign/',
    true,
  ],
  [
    'a URL-encoded embed signing link',
    'playwright-report/index.html',
    reportWith(`<a href="https://sign.example.com/login?next=%2Fembed%2Fsign%2F${EMBED_TOKEN}">x</a>`),
    EMBED_TOKEN,
    '/embed/sign/',
    true,
  ],
  [
    'a URL-encoded ?token= link',
    'test-results/junit.xml',
    junitWith('', `GET https://sign.example.com/login?next=%2Fd%2Fabc123%3Ftoken%3D${QUERY_TOKEN} 302`),
    QUERY_TOKEN,
    '?token=',
    false,
  ],
  [
    'a URL-encoded bearer value',
    'test-results/junit.xml',
    junitWith('', `GET https://sign.example.com/cb?authorization=Bearer%20${BEARER_TOKEN} 401`),
    BEARER_TOKEN,
    'Bearer ',
    false,
  ],
  [
    'a JSON slash-escaped signing link',
    'test-results/results.json',
    slashEscaped(resultsWith(`opened https://sign.example.com/sign/${RECIPIENT_TOKEN}`)),
    RECIPIENT_TOKEN,
    '/sign/',
    true,
  ],
  [
    'a JSON slash-escaped embed signing link',
    'test-results/results.json',
    slashEscaped(resultsWith(`opened https://sign.example.com/embed/sign/${EMBED_TOKEN}`)),
    EMBED_TOKEN,
    '/embed/sign/',
    true,
  ],
  [
    'a JSON slash-escaped ?token= link',
    'test-results/results.json',
    slashEscaped(resultsWith(`opened https://sign.example.com/d/abc123?token=${QUERY_TOKEN}`)),
    QUERY_TOKEN,
    '/d/abc123?token=',
    false,
  ],
  [
    'a JSON slash-escaped bearer value',
    'test-results/results.json',
    slashEscaped(resultsWith('request failed', { request: { headers: { authorization: `Bearer ${SLASH_TOKEN}` } } })),
    SLASH_TOKEN,
    SLASH_TOKEN,
    false,
  ],
];

describe('criterion 11: issued credentials written encoded', () => {
  it.each(
    ENCODED_CREDENTIALS,
  )('fixture_for_%s_holds_no_plain_form_and_stays_well_formed', (_kind, file, contents, _token, plain) => {
    expect(contents.includes(plain), `the fixture must not also hold ${plain} in plain`).toBe(false);

    if (file.endsWith('.json')) {
      expect(() => JSON.parse(contents)).not.toThrow();
    }
  });

  it.each(
    ENCODED_CREDENTIALS,
  )('with_no_mode_when_run_output_holds_%s_should_publish_nothing', (_kind, file, contents, token) => {
    const run = runScan({ env: { E2E_REMOTE_API_TOKEN: SECRET }, files: { [file]: contents } });

    expectNothingPublished(run);
    expect(run.log).toContain(path.basename(file));
    expectLogWithout(run, [token]);
  });

  it.each(
    ENCODED_CREDENTIALS,
  )('in_remote_mode_when_run_output_holds_%s_should_publish_at_most_the_clean_manifest', (_kind, file, contents, token, _plain, isSigningLink) => {
    const run = runScan({ env: { [MODE]: 'remote', E2E_REMOTE_API_TOKEN: SECRET }, files: { [file]: contents } });

    const published = listFiles(run.artifacts).filter((name) => name !== NOTE);

    expect(published, `log:\n${run.log}`).toEqual(isSigningLink ? [MANIFEST] : []);
    expect(run.log).toContain(path.basename(file));
    expectLogWithout(run, [token]);
  });

  it.each(ENCODED_CREDENTIALS)('in_local_mode_when_run_output_holds_%s_should_publish_it', (_kind, file, contents) => {
    const run = runScan({ env: { [MODE]: 'local', E2E_REMOTE_API_TOKEN: SECRET }, files: { [file]: contents } });

    expectPublishedUnchanged(run);
  });
});

/**
 * Criterion 12: every mandatory output must exist and be well-formed before
 * the scan chooses what to publish, in every mode. In remote and local mode
 * the run also carries a passing journey's signing links, so the remote case
 * exercises the manifest-only path and the local case the pattern-free one.
 */
const MODES: [string, Record<string, string>, Files][] = [
  ['remote', { [MODE]: 'remote' }, passingJourneyReport()],
  ['local', { [MODE]: 'local' }, passingJourneyReport()],
  ['no', {}, {}],
];

const BROKEN_OUTPUTS: [string, { files?: Files; omit?: string[] }][] = [
  ['manifest.json missing', { omit: [MANIFEST] }],
  ['manifest.json malformed', { files: { [MANIFEST]: '{"commit": "c94b814f2", "command": ' } }],
  ['results.json missing', { omit: ['test-results/results.json'] }],
  ['results.json malformed', { files: { 'test-results/results.json': '{"suites": [{"title": "remote' } }],
  ['junit.xml missing', { omit: ['test-results/junit.xml'] }],
  ['playwright-report/index.html missing', { omit: ['playwright-report/index.html'] }],
  // The clarification of criterion 12: the JUnit root must open and close, and
  // index.html must be non-empty and close </html>.
  [
    'junit.xml truncated inside its root element',
    { files: { 'test-results/junit.xml': junitWith().replace(/<\/testsuites>\s*$/, '') } },
  ],
  ['junit.xml empty', { files: { 'test-results/junit.xml': '' } }],
  [
    'playwright-report/index.html with no closing html tag',
    { files: { 'playwright-report/index.html': reportWith().replace(/<\/html>\s*$/, '') } },
  ],
  ['playwright-report/index.html empty', { files: { 'playwright-report/index.html': '' } }],
];

describe('criterion 12 fixtures', () => {
  it('truncate exactly the closing root element and the closing html tag', () => {
    expect(junitWith().replace(/<\/testsuites>\s*$/, '')).toContain('<testsuites');
    expect(junitWith().replace(/<\/testsuites>\s*$/, '')).not.toContain('</testsuites>');
    expect(reportWith().replace(/<\/html>\s*$/, '')).not.toContain('</html>');
  });
});

describe('criterion 12: mandatory outputs', () => {
  const cases = MODES.flatMap(([mode, env, extra]) =>
    BROKEN_OUTPUTS.map(([broken, change]) => [mode, broken, env, extra, change] as const),
  );

  it.each(cases)('in_%s_mode_with_%s_should_publish_nothing', (_mode, _broken, env, extra, change) => {
    const run = runScan({
      env: { ...env, E2E_REMOTE_API_TOKEN: SECRET },
      files: { ...extra, ...change.files },
      omit: change.omit,
    });

    expectNothingPublished(run);
  });
});
