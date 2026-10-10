import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Which environment values count as secrets, and the forms they take once
 * written down. The manifest reporter masks them and
 * scripts/check-artifact-secrets.ts searches the run's artifacts for them,
 * from this one definition so the two cannot disagree.
 *
 * A value is a secret when its variable's name matches CREDENTIAL_NAME,
 * whatever the value looks like, URLs included. A NEXT_PRIVATE_* variable whose
 * name matches nothing else is a secret too, unless its value is a URL with no
 * user or password, such as NEXT_PRIVATE_INTERNAL_WEBAPP_URL. The password
 * inside any URL value is a secret whatever the variable is called, which
 * catches CI_REPOSITORY_URL's job token.
 *
 * The only exclusions are by exact name, each a false positive observed on a
 * real run with no secret in the value: NOT_SECRET_NAMES below.
 *
 * Everything here reads the environment through envSources and URLs through
 * parseUrlStrict, so the reporter and the scan cannot read a value two ways. A
 * value containing "://" that parseUrlStrict refuses is a secret whole.
 */
export const CREDENTIAL_NAME =
  /TOKEN|SECRET|PASS|PWD|KEY|CREDENTIAL|AUTH|COOKIE|SESSION|DSN|CERT|SIGNATURE|PRIVATE|JWT|DATABASE_URL|_PAT$/i;

/**
 * Names the pattern catches that hold no secret. PWD and OLDPWD are the
 * shell's working directories, which every results.json contains as test file
 * paths. CLAUDE_CODE_MAX_OUTPUT_TOKENS is a number set by the agent harness.
 * All three were flagged as leaks on a local run on 2026-10-06.
 * NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS and NEXT_PRIVATE_SMTP_HOST name hosts,
 * 127.0.0.1 in CI, where a spec's webhook receiver listens; both were flagged
 * on pipeline 54474.
 */
const NOT_SECRET_NAMES = new Set([
  'PWD',
  'OLDPWD',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS',
  'NEXT_PRIVATE_SMTP_HOST',
]);

/**
 * Values shorter than this cannot be searched for: "true" or "1234" match
 * everywhere. A credential that short is reported by name and the scan refuses
 * to publish, unless its name is in SHORT_NOT_SECRET_NAMES.
 */
export const MIN_SECRET_LENGTH = 6;

/**
 * Names the pattern catches whose values are short and hold no secret, so a
 * short value under one of them is neither searched nor refused. Each is a
 * setting rather than a credential, and is caught only by NEXT_PRIVATE_ or by a
 * word inside a longer one. The first seven are .env.example's own values,
 * which e2e_local copies to .env: "login", "local", "false", "2500", "local",
 * "true" and "true". e2e_local also rewrites NEXT_PRIVATE_SMTP_PORT to its
 * mail catcher's port, and sets DANGEROUS_BYPASS_RATE_LIMITS, which matches
 * PASS inside BYPASS, to "true". The six FF_ names are GitLab runner feature
 * flags, booleans set on every CI job, caught by TOKEN, KEY, SECRET or AUTH;
 * observed on pipeline 54270. A longer value under any of these is still
 * searched as before.
 */
const SHORT_NOT_SECRET_NAMES = new Set([
  'NEXT_PRIVATE_OIDC_PROMPT',
  'NEXT_PRIVATE_SIGNING_TRANSPORT',
  'NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE',
  'NEXT_PRIVATE_SMTP_PORT',
  'NEXT_PRIVATE_JOBS_PROVIDER',
  'NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN',
  'NEXT_PRIVATE_ENTRA_RECONCILE_NOT_REQUIRED',
  'DANGEROUS_BYPASS_RATE_LIMITS',
  'FF_DISABLE_AUTOMATIC_TOKEN_ROTATION',
  'FF_GIT_URLS_WITHOUT_TOKENS',
  'FF_HASH_CACHE_KEYS',
  'FF_MASK_ALL_DEFAULT_TOKENS',
  'FF_SECRET_RESOLVING_FAILS_IF_MISSING',
  'FF_USE_GIT_PROACTIVE_AUTH',
]);

type Env = Record<string, string | undefined>;
type EnvPair = [name: string, value: string];

/** The files playwright.config.ts loads, relative to the repository root. */
export const ENV_FILES = ['.env', '.env.local', `.env.${process.env.NODE_ENV || 'development'}`];

/**
 * Every name and value the run can see: the process environment and each env
 * file, all kept. Nothing is merged, so a value shadowed by another file is
 * still a candidate secret.
 */
export const envSources = (repoRoot: string): EnvPair[] => {
  const pairs: EnvPair[] = Object.entries(process.env).filter((pair): pair is EnvPair => Boolean(pair[1]));

  for (const file of ENV_FILES.map((name) => path.join(repoRoot, name))) {
    if (fs.existsSync(file)) {
      pairs.push(...Object.entries(dotenv.parse(fs.readFileSync(file))));
    }
  }

  return pairs;
};

/**
 * A URL only when it reads one way: a scheme and "://", at most one "@", no
 * whitespace or backslash, and the WHATWG parser accepts it. Anything else is
 * null, and callers treat a null for a "://" value as a secret or redact it.
 */
export const parseUrlStrict = (value: string) => {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /[\s\\]/.test(value) || value.split('@').length > 2) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * What .env.example commits, which the e2e_local job copies to .env as its
 * throwaway configuration. Only the scan uses this, and only for values shorter
 * than PREVIOUS_SCAN_MIN_LENGTH: "password", "secret", "documenso" and
 * "127.0.0.1" appear in spec titles and results, and the scan never searched
 * values that short before. A longer example value, such as the database URL,
 * is still searched. The same holds for the password inside an example URL:
 * the job rewrites the database URL's port, but keeps its password "password",
 * so that short password is exempt for that variable alone, under the key
 * `<NAME>#password`. A value shorter than MIN_SECRET_LENGTH is never exempt
 * here: only SHORT_NOT_SECRET_NAMES excuses one, by name.
 */
export const shortExampleValues = (repoRoot: string): Env => {
  const example = path.join(repoRoot, '.env.example');
  const parsed = dotenv.parse(fs.readFileSync(example));
  const exempt: Env = {};

  for (const [name, value] of Object.entries(parsed)) {
    const password = parseUrlStrict(value)?.password;

    if (value.length >= MIN_SECRET_LENGTH && value.length < PREVIOUS_SCAN_MIN_LENGTH) {
      exempt[name] = value;
    }

    if (password && password.length >= MIN_SECRET_LENGTH && password.length < PREVIOUS_SCAN_MIN_LENGTH) {
      exempt[`${name}#password`] = password;
    }
  }

  return exempt;
};

const PREVIOUS_SCAN_MIN_LENGTH = 12;

export const secretValues = (env: EnvPair[], exempt: Env = {}) => {
  const values = new Set<string>();
  const unsearchable = new Set<string>();

  const add = (name: string, value: string) => {
    if (value.length < MIN_SECRET_LENGTH) {
      if (!SHORT_NOT_SECRET_NAMES.has(name)) {
        unsearchable.add(name);
      }

      return;
    }

    values.add(value);
  };

  for (const [name, value] of env) {
    if (!value || exempt[name] === value || NOT_SECRET_NAMES.has(name)) {
      continue;
    }

    const url = parseUrlStrict(value);

    if (url === null && value.includes('://')) {
      add(name, value);

      continue;
    }

    if (url?.password && exempt[`${name}#password`] !== url.password) {
      add(name, url.password);
      add(name, decodeURIComponent(url.password));
    }

    const isPlainUrl = url !== null && !url.username && !url.password;
    // Matches for a reason other than the NEXT_PRIVATE_ prefix alone.
    const isCredentialName = CREDENTIAL_NAME.test(name.replace(/^NEXT_PRIVATE_/, ''));

    if (isCredentialName || (CREDENTIAL_NAME.test(name) && !isPlainUrl)) {
      add(name, value);
    }
  }

  return {
    values: [...values].sort((a, b) => b.length - a.length),
    unsearchableNames: [...unsearchable].sort(),
  };
};

/**
 * The middle of the base64 encoding of `value` when it starts `offset` bytes
 * into an encoded run, leaving out the edge characters that depend on the
 * bytes around it. That is how a secret appears inside a Basic auth header or
 * a data URL.
 */
const base64Middle = (value: string, offset: number) => {
  const bytes = Buffer.concat([Buffer.alloc(offset), Buffer.from(value)]);
  const encoded = bytes.toString('base64');
  const start = offset === 0 ? 0 : 4;
  const end = bytes.length % 3 === 0 ? encoded.length : encoded.length - 4;

  return encoded.slice(start, end);
};

const xmlEscape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

/** RFC 3986 percent-encoding of everything but the unreserved characters, which is stricter than encodeURIComponent. */
const percentEncodeAll = (value: string) =>
  [...Buffer.from(value)]
    .map((byte) =>
      /[A-Za-z0-9\-._~]/.test(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
    )
    .join('');

/** Every form of a secret worth looking for: raw, escaped for JSON, XML and HTML, URL-encoded, and base64. */
export const encodedForms = (secret: string) => {
  const base64 = [0, 1, 2].map((offset) => base64Middle(secret, offset)).filter((form) => form.length >= 8);

  return [
    ...new Set([
      secret,
      JSON.stringify(secret).slice(1, -1),
      xmlEscape(secret),
      xmlEscape(secret).replaceAll('&apos;', '&#39;'),
      encodeURIComponent(secret),
      encodeURI(secret),
      encodeURIComponent(secret).replaceAll('%20', '+'),
      percentEncodeAll(secret),
      percentEncodeAll(secret).toLowerCase(),
      ...base64,
      ...base64.map((form) => form.replaceAll('+', '-').replaceAll('/', '_')),
    ]),
  ];
};

/** A URL with its user, password, query and fragment removed; null when it does not parse. */
export const stripUrlCredentials = (url: string) => {
  const parsed = parseUrlStrict(url);

  if (!parsed) {
    return null;
  }

  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';

  return parsed.toString();
};
