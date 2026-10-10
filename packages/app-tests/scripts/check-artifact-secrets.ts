import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

import { encodedForms, envSources, secretValues, shortExampleValues } from '../reporters/secret-values';

/**
 * Decides what a Playwright run may upload. CI uploads only
 * packages/app-tests/e2e-artifacts/, never test-results/ or
 * playwright-report/. This script first resets that directory to a single
 * failure note, then searches the raw directories, and only when every file is
 * clean copies them in and removes the note. A leak, a file it cannot read, a
 * crash, a timeout or a scan that never ran all leave the note alone, which
 * carries no run output.
 *
 * The secrets come from reporters/secret-values.ts, the same definition the
 * manifest reporter masks with, in every form that file lists. Each file is
 * searched as bytes, and so is everything inside it that is zipped (traces,
 * the html report's data files), gzipped, or a base64 data URL (the html
 * report embeds itself in index.html as one). A zip this cannot read counts as
 * a failure.
 *
 * Credentials issued while the run is in progress are in no variable, so each
 * of those buffers is also searched for their shapes: ISSUED below. A
 * credential too short to search for fails the scan as well, and so does any
 * mandatory output (MANDATORY below) that is missing or does not parse.
 *
 * ARTIFACT_SCAN_MODE, set by the job, says whose tokens these are. `local`
 * (e2e_local) skips the ISSUED patterns, because its tokens belong to a
 * database container discarded when the job ends; the environment, dotenv and
 * short-value checks still apply. `remote` (e2e_staging) applies them, and
 * when every finding is a signing link, which every passing journey's
 * report holds, publishes test-results/manifest.json alone, provided the
 * manifest itself passes every check. Any other value, or none, applies the
 * patterns and publishes nothing on a finding.
 *
 * What this cannot see is text rendered into a screenshot or a video frame.
 *
 * Prints variable names and file paths only, never a value.
 */
const ARTIFACT_DIRS = ['test-results', 'playwright-report'];
const RENDERED = /\.(png|jpe?g|webm|webp)$/i;
const DATA_URL = /;base64,([A-Za-z0-9+/=]{16,})/g;
const FAILURE_NOTE = 'SCAN-DID-NOT-PASS.txt';
const RESULTS = 'test-results/results.json';
const MANIFEST = 'test-results/manifest.json';
const JUNIT = 'test-results/junit.xml';
const REPORT = 'playwright-report/index.html';
// What playwright.config.ts writes on every run, local or remote: its junit
// and json reporters, the manifest reporter and the html report. Each must
// also be whole: the json files parse, the junit file's root testsuites or
// testsuite element opens and closes, and index.html is non-empty and closes
// </html>. A file cut short by a killed run fails here.
const MANDATORY = [MANIFEST, RESULTS, JUNIT, REPORT];

/** Throws when the text is not JSON, which the caller counts as malformed. */
const parses = (text: string) => {
  JSON.parse(text);

  return true;
};

const isWholeJunit = (xml: string) => {
  const root = /<(testsuites|testsuite)[\s>]/.exec(xml)?.[1];

  return root !== undefined && xml.trimEnd().endsWith(`</${root}>`);
};
const MODE = process.env.ARTIFACT_SCAN_MODE;

/**
 * What a credential issued during the run looks like. Recipient tokens are
 * nanoid(), 21 characters, and API tokens are `api_` and alphaid(16). Asking
 * for 21 keeps out /sign/not-a-real-token, which a remote spec requests on
 * purpose. Each match is reported by kind, never by value.
 *
 * The patterns run on a copy of the text in which %2F, %3F, %3D, %20 and
 * JSON's \/ are decoded, one linear pass, so a link or bearer value written
 * URL-encoded or slash-escaped is found too. Only a signing link counts as
 * `link`, the one finding a remote run may answer with its manifest alone.
 */
const ISSUED = [
  { kind: 'a signing link (/sign/ or /embed/sign/ and a token)', pattern: /\/sign\/[A-Za-z0-9_-]{21,}/, link: true },
  { kind: 'a ?token= link', pattern: /[?&;]token=[A-Za-z0-9_-]{21,}/, link: false },
  { kind: 'a Sign API token (api_...)', pattern: /\bapi_[a-z0-9]{16}/, link: false },
  { kind: 'an Authorization: Bearer value', pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i, link: false },
];
const patterns = MODE === 'local' ? [] : ISSUED;
const ENCODED: Record<string, string> = { '%2f': '/', '%3f': '?', '%3d': '=', '%20': ' ', '\\/': '/' };
const decoded = (text: string) => text.replace(/%2[fF]|%3[fFdD]|%20|\\\//g, (match) => ENCODED[match.toLowerCase()]);

const appTestsDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appTestsDir, '../..');
const uploadDir = path.join(appTestsDir, 'e2e-artifacts');

fs.rmSync(uploadDir, { recursive: true, force: true });
fs.mkdirSync(uploadDir, { recursive: true });
fs.writeFileSync(
  path.join(uploadDir, FAILURE_NOTE),
  'The artifact secret scan did not pass, so no test output was kept. See the job log.\n',
);

const env = envSources(repoRoot);
const { values: secrets, unsearchableNames } = secretValues(env, shortExampleValues(repoRoot));

// Fail closed: a scan that found nothing to look for proves nothing. On a
// GitLab runner the job token is always present, so its absence means the job
// environment was not read.
if (secrets.length === 0) {
  console.log('FAIL - no secret values found to search for; cannot check the artifacts');
  process.exit(1);
}

if (process.env.GITLAB_CI && !(process.env.CI_JOB_TOKEN && secrets.includes(process.env.CI_JOB_TOKEN))) {
  console.log('FAIL - CI_JOB_TOKEN is not among the secret values; the job environment was not read');
  process.exit(1);
}

const forms = secrets.map((secret) => ({ secret, forms: encodedForms(secret).map((form) => Buffer.from(form)) }));

const namesOf = (secret: string) => {
  const exact = env.filter(([, value]) => value === secret);
  const names = (exact.length > 0 ? exact : env.filter(([, value]) => value.includes(secret))).map(([name]) => name);

  return [...new Set(names)];
};

/** The entries of a zip, read from its central directory. Throws on anything it cannot read. */
const zipEntries = (zip: Buffer) => {
  let end = -1;

  for (let index = zip.length - 22; index >= Math.max(0, zip.length - 65_557); index--) {
    if (zip.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  }

  if (end < 0) {
    throw new Error('no end of central directory');
  }

  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);

  if (count === 0xffff || offset === 0xffffffff) {
    throw new Error('zip64 is not supported');
  }

  return Array.from({ length: count }, () => {
    if (zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('bad central directory entry');
    }

    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (flags & 1) {
      throw new Error(`${name} is encrypted`);
    }

    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('zip64 is not supported');
    }

    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(dataStart, dataStart + compressedSize);

    offset += 46 + nameLength + extraLength + commentLength;

    if (method === 0) {
      return { name, content: data };
    }

    if (method === 8) {
      return { name, content: inflateRawSync(data) };
    }

    throw new Error(`${name} uses compression method ${method}`);
  });
};

type Finding = { where: string; problem: string; link?: boolean };

/** Searches a buffer and everything packed inside it. */
const search = (content: Buffer, where: string): Finding[] => {
  try {
    const found: Finding[] = forms
      .filter(({ forms: encoded }) => encoded.some((form) => content.includes(form)))
      .map(({ secret }) => ({ where, problem: `contains the value of ${namesOf(secret).join(', ') || 'a secret'}` }));
    const text = content.toString('latin1');
    const plain = patterns.length > 0 ? decoded(text) : text;

    found.push(
      ...patterns
        .filter(({ pattern }) => pattern.test(plain))
        .map(({ kind, link }) => ({ where, problem: `contains ${kind}`, link })),
    );

    if (content.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      return [...found, ...zipEntries(content).flatMap((entry) => search(entry.content, `${where}!${entry.name}`))];
    }

    if (content[0] === 0x1f && content[1] === 0x8b) {
      return [...found, ...search(gunzipSync(content), `${where}!gunzip`)];
    }

    const dataUrls = [...text.matchAll(DATA_URL)].flatMap((match, index) =>
      search(Buffer.from(match[1], 'base64'), `${where}!data-url-${index}`),
    );

    return [...found, ...dataUrls];
  } catch (error) {
    return [{ where, problem: `could not be checked (${error instanceof Error ? error.message : String(error)})` }];
  }
};

const listFiles = (dir: string): string[] => {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? listFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
};

// Fail closed on missing input: an empty search finds nothing and proves
// nothing. The parse error is not printed, because it quotes the file.
const missing = MANDATORY.filter((input) => !fs.existsSync(path.join(appTestsDir, input)));

if (missing.length > 0) {
  console.log(`FAIL - the run output is missing ${missing.join(', ')}; there is nothing to check`);
  process.exit(1);
}

const isWhole: Record<string, (text: string) => boolean> = {
  [MANIFEST]: parses,
  [RESULTS]: parses,
  [JUNIT]: isWholeJunit,
  [REPORT]: (text) => text.includes('</html>'),
};

for (const output of MANDATORY) {
  let whole = false;

  try {
    whole = isWhole[output](fs.readFileSync(path.join(appTestsDir, output), 'utf8'));
  } catch {
    whole = false;
  }

  if (!whole) {
    console.log(`FAIL - ${output} is malformed or cut short, so the run did not finish writing it`);
    process.exit(1);
  }
}

const files = ARTIFACT_DIRS.flatMap((dir) => listFiles(path.join(appTestsDir, dir)));
const failures = files
  .map((file) => ({ file, findings: search(fs.readFileSync(file), path.relative(appTestsDir, file)) }))
  .filter(({ findings }) => findings.length > 0);

console.log(
  `artifact secret check - ${secrets.length} secret values, ${files.length} files searched, ` +
    `${files.filter((file) => RENDERED.test(file)).length} screenshots or videos whose rendered text cannot be read`,
);

if (unsearchableNames.length > 0) {
  console.log(`FAIL - too short to search for, so the run cannot be published - ${unsearchableNames.join(', ')}`);
}

for (const { findings } of failures) {
  for (const finding of findings) {
    console.log(`LEAK - ${finding.where} ${finding.problem}`);
  }
}

const findings = failures.flatMap((failure) => failure.findings);
const inManifest = ({ where }: Finding) => where === MANIFEST || where.startsWith(`${MANIFEST}!`);
const manifestOnly =
  MODE === 'remote' &&
  unsearchableNames.length === 0 &&
  findings.length > 0 &&
  findings.every((finding) => finding.link && !inManifest(finding));

if (manifestOnly) {
  fs.mkdirSync(path.join(uploadDir, path.dirname(MANIFEST)), { recursive: true });
  fs.copyFileSync(path.join(appTestsDir, MANIFEST), path.join(uploadDir, MANIFEST));
  fs.rmSync(path.join(uploadDir, FAILURE_NOTE));
  console.log(`ok   - the run holds signing links, so only ${MANIFEST}, which is clean, was copied`);
  process.exit(0);
}

if (failures.length > 0 || unsearchableNames.length > 0) {
  process.exit(1);
}

// Clean. Copy beside the note first, then remove the note, so an interruption
// at any point leaves the note in place.
for (const dir of ARTIFACT_DIRS) {
  if (fs.existsSync(path.join(appTestsDir, dir))) {
    fs.cpSync(path.join(appTestsDir, dir), path.join(uploadDir, dir), { recursive: true });
  }
}

fs.rmSync(path.join(uploadDir, FAILURE_NOTE));
console.log(`ok   - clean; copied ${ARTIFACT_DIRS.join(' and ')} to ${path.relative(appTestsDir, uploadDir)}/`);
