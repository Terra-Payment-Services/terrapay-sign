/**
 * No test code reads Inbucket through a traced Playwright call.
 *
 * Written from the F1 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/ci-55467/ANALYSIS.txt,
 * section 5) before any change.
 *
 * | Criterion | Test                                                                                  |
 * | --------- | ------------------------------------------------------------------------------------- |
 * | C-F1c     | C-F1c premise: the scanner flags planted traced Inbucket reads and passes Node fetch  |
 * | C-F1c     | C-F1c no traced call in app-tests has a URL built from the Inbucket base              |
 *
 * A call through `request`, `page.request` or any other APIRequestContext is recorded in the test's trace,
 * response body included, and so is the browser's traffic. Inbucket's messages carry
 * NEXT_PRIVATE_SMTP_FROM_ADDRESS, and the CI artifact scan (scripts/check-artifact-secrets.ts) refuses any
 * artifact holding a NEXT_PRIVATE_* value, so a traced reader fails the job whenever its test fails. Node fetch
 * is not traced (precedent: 8b637534c).
 *
 * The scan builds one TypeScript program from every .ts file under packages/app-tests (skipping node_modules,
 * test-results, playwright-report and .stryker-tmp) and resolves names through its type checker, so scope,
 * shadowing and imports are respected. A call is flagged when it is
 * - `<context>.get|post|put|patch|delete|head|fetch(url)`, by property or element access, where the context is
 *   named `request`, ends in `.request`, is annotated APIRequestContext, comes from `newContext`, is destructured
 *   from a `request` member (fixture parameters included) or is assigned from any of those;
 * - `<any>.goto(url)`; or
 * - `<any>.evaluate|evaluateHandle|evaluateAll|$eval|$$eval|addInitScript(...)` with an argument containing an
 *   Inbucket reference anywhere inside it;
 * and the URL is built from the Inbucket base: INBUCKET_URL, E2E_INBUCKET_URL, a `mailApiUrl` member or a
 * `/api/v1/mailbox` string, directly or through a variable, helper or imported name whose value is built from
 * one. A name the checker cannot resolve falls back to matching tainted exported names (or object members) by
 * spelling. Files are read from disk, so untracked files count.
 *
 * Not covered: browser traffic started any other way (a click on a link to Inbucket, `page.route`, an `<img>`
 * the app renders), a context reached through a call or a container (`getApi().get`, `ctx[0].get`), a URL
 * reassigned after its declaration, and test code that is not a .ts file.
 */
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import ts from 'typescript';

const APP_TESTS_ROOT = path.join(__dirname, '..', '..');
const SKIPPED_DIRS = new Set(['node_modules', 'test-results', 'playwright-report', '.stryker-tmp']);

const SEED_NAMES = new Set(['INBUCKET_URL', 'E2E_INBUCKET_URL', 'mailApiUrl']);
const MAILBOX_PATH = '/api/v1/mailbox';
const REQUEST_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);
const BROWSER_SCRIPT_METHODS = new Set([
  'evaluate',
  'evaluateHandle',
  'evaluateAll',
  '$eval',
  '$$eval',
  'addInitScript',
]);

type Source = { fileName: string; text: string };

const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};

/** One program over the sources alone, held in memory, so relative imports between them resolve. */
const createProgram = (sources: Source[]) => {
  const byPath = new Map(sources.map((source) => [path.resolve(APP_TESTS_ROOT, source.fileName), source.text]));
  const options: ts.CompilerOptions = {
    noLib: true,
    noEmit: true,
    types: [],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host = ts.createCompilerHost(options);

  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (fileName) => fileName;
  host.fileExists = (fileName) => byPath.has(fileName);
  host.readFile = (fileName) => byPath.get(fileName);
  host.getSourceFile = (fileName) => {
    const text = byPath.get(fileName);

    return text === undefined ? undefined : ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  };

  return ts.createProgram([...byPath.keys()], options, host);
};

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ||
  ts.isAwaitExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;

/** What a declaration's value is judged by: a function's returned expressions, otherwise the initializer. */
const judgedValues = (initializer: ts.Expression | ts.FunctionDeclaration) => {
  if (
    ts.isArrowFunction(initializer) ||
    ts.isFunctionExpression(initializer) ||
    ts.isFunctionDeclaration(initializer)
  ) {
    if (initializer.body && !ts.isBlock(initializer.body)) {
      return [initializer.body];
    }

    const returned: ts.Expression[] = [];

    if (initializer.body) {
      walk(initializer.body, (child) => {
        if (ts.isReturnStatement(child) && child.expression) {
          returned.push(child.expression);
        }
      });
    }

    return returned;
  }

  return [initializer];
};

const isExported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

type Declared = { node: ts.Node; name: string; values: ts.Expression[]; exported: boolean; member: boolean };

const declarations = (file: ts.SourceFile) => {
  const found: Declared[] = [];

  walk(file, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const exported = isExported(node.parent.parent);

      found.push({ node, name: node.name.text, values: judgedValues(node.initializer), exported, member: false });
    }

    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      found.push({ node, name: node.name.text, values: judgedValues(node.initializer), exported: false, member: true });
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      found.push({ node, name: node.name.text, values: judgedValues(node), exported: isExported(node), member: false });
    }
  });

  return found;
};

/**
 * Every traced call in `sources` that reads Inbucket, as `file:line`. Names are resolved through one type
 * checker over all the sources; see the header for the rules.
 */
const findTracedInbucketReads = (sources: Source[]) => {
  const program = createProgram(sources);
  const checker = program.getTypeChecker();
  const files = program.getSourceFiles();
  const decls = files.flatMap(declarations);
  const tainted = new Set<ts.Node>();
  const taintedNames = new Set<string>();
  const taintedMembers = new Set<string>();
  const contexts = new Set<ts.Node>();

  const declarationOf = (node: ts.Node) => {
    const symbol = checker.getSymbolAtLocation(node);
    const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

    return target?.valueDeclaration ?? target?.declarations?.[0];
  };

  /** A resolved name is judged by its declaration; an unresolved one by spelling. */
  const isTaintedName = (name: ts.Identifier | ts.PrivateIdentifier, fallback: Set<string>) => {
    const declaration = declarationOf(name);

    return SEED_NAMES.has(name.text) || (declaration ? tainted.has(declaration) : fallback.has(name.text));
  };

  /**
   * True when the expression builds a URL from the Inbucket base: a tainted name, a member with a tainted name or
   * on a tainted value, a string holding the mailbox path, or a template, concatenation, fallback, method call or
   * `new URL` over one of those. Object literals and call arguments do not carry taint, so `fetch(base)` or an
   * object with a `mailApiUrl` member does not make its result or its holder an Inbucket URL.
   */
  const isTainted = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) {
      return isTaintedName(node, taintedNames);
    }

    if (ts.isPropertyAccessExpression(node)) {
      return isTaintedName(node.name, taintedMembers) || isTainted(node.expression);
    }

    if (ts.isElementAccessExpression(node)) {
      return isTainted(node.expression);
    }

    if (ts.isStringLiteralLike(node)) {
      return node.text.includes(MAILBOX_PATH);
    }

    if (ts.isTemplateExpression(node)) {
      return (
        node.head.text.includes(MAILBOX_PATH) ||
        node.templateSpans.some((span) => span.literal.text.includes(MAILBOX_PATH) || isTainted(span.expression))
      );
    }

    if (ts.isBinaryExpression(node)) {
      return isTainted(node.left) || isTainted(node.right);
    }

    if (ts.isConditionalExpression(node)) {
      return isTainted(node.whenTrue) || isTainted(node.whenFalse);
    }

    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node)) {
      return isTainted(node.expression);
    }

    if (ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isCallExpression(node)) {
      return isTainted(node.expression);
    }

    if (ts.isNewExpression(node)) {
      return (node.arguments ?? []).some(isTainted);
    }

    return false;
  };

  const containsTaint = (node: ts.Node) => {
    let found = false;

    walk(node, (child) => {
      found = found || isTainted(child);
    });

    return found;
  };

  const isRequestContext = (expression: ts.Expression): boolean => {
    const node = unwrap(expression);

    if (ts.isIdentifier(node)) {
      const declaration = declarationOf(node);

      return node.text === 'request' || (declaration !== undefined && contexts.has(declaration));
    }

    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text === 'request';
    }

    if (ts.isElementAccessExpression(node)) {
      return ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'request';
    }

    return (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'newContext'
    );
  };

  /** A declaration that holds an APIRequestContext by annotation, `newContext`, destructuring or assignment. */
  const holdsRequestContext = (node: ts.Node) => {
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const member = node.propertyName ?? node.name;

      return ts.isIdentifier(member) && member.text === 'request';
    }

    if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name)) {
      return Boolean(
        node.type?.getText().includes('APIRequestContext') || (node.initializer && isRequestContext(node.initializer)),
      );
    }

    return false;
  };

  const candidates: ts.Node[] = [];

  files.forEach((file) => walk(file, (node) => candidates.push(node)));

  for (let grew = true; grew; ) {
    grew = false;

    for (const decl of decls) {
      if (!tainted.has(decl.node) && decl.values.some(isTainted)) {
        tainted.add(decl.node);
        grew = true;

        if (decl.member) {
          taintedMembers.add(decl.name);
        } else if (decl.exported) {
          taintedNames.add(decl.name);
        }
      }
    }

    for (const node of candidates) {
      if (!contexts.has(node) && holdsRequestContext(node)) {
        contexts.add(node);
        grew = true;
      }
    }
  }

  const offenders: string[] = [];

  for (const file of files) {
    walk(file, (node) => {
      if (!ts.isCallExpression(node)) {
        return;
      }

      const callee = node.expression;

      if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
        return;
      }

      const method = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isStringLiteralLike(callee.argumentExpression)
          ? callee.argumentExpression.text
          : '';

      const [url] = node.arguments;
      const isTraced =
        (REQUEST_METHODS.has(method) && isRequestContext(callee.expression) && url !== undefined && isTainted(url)) ||
        (method === 'goto' && url !== undefined && isTainted(url)) ||
        (BROWSER_SCRIPT_METHODS.has(method) && node.arguments.some(containsTaint));

      if (isTraced) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));

        offenders.push(`${path.relative(APP_TESTS_ROOT, file.fileName)}:${line + 1}`);
      }
    });
  }

  return offenders;
};

const testSources = (): Source[] => {
  const list = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        return SKIPPED_DIRS.has(entry.name) ? [] : list(full);
      }

      return entry.name.endsWith('.ts') ? [full] : [];
    });

  return list(APP_TESTS_ROOT).map((full) => ({
    fileName: path.relative(APP_TESTS_ROOT, full),
    text: fs.readFileSync(full, 'utf8'),
  }));
};

// Planted readers. Plain strings, so `${...}` here is source text, not interpolation.
const SEND_PATH = {
  fileName: 'e2e/fixtures/send-path.ts',
  text: "export const INBUCKET_URL = (process.env.E2E_INBUCKET_URL || 'http://127.0.0.1:9000').replace(/\\/$/, '');",
};

const plantedPositives: Record<string, string> = {
  'page.request.get with the base inline': 'await page.request.get(`${INBUCKET_URL}/api/v1/mailbox/${box}/${id}`);',
  'request.get with the URL in a variable':
    'const url = `${INBUCKET_URL}/api/v1/mailbox/${box}`;\nconst res = await request.get(url);',
  'request.get with the base renamed': 'const base = INBUCKET_URL;\nawait request.get(base + "/api/v1/mailbox/x");',
  'an APIRequestContext parameter under another name':
    'const read = async (api: APIRequestContext) => await api.get(`${INBUCKET_URL}/api/v1/mailbox/x`);',
  'a newContext request context': 'const api = await request.newContext();\nawait api.fetch(`${INBUCKET_URL}/x`);',
  'context.request.get with process.env.E2E_INBUCKET_URL':
    'await context.request.get(`${process.env.E2E_INBUCKET_URL}/api/v1/mailbox/x`);',
  'request.get through a helper that builds the URL':
    'const mailboxUrl = (box: string) => `${INBUCKET_URL}/api/v1/mailbox/${box}`;\nawait request.get(mailboxUrl(b));',
  'request.get through an exported name from another file': 'await request.get(`${OTHER_MAIL}/x`);',
  'SEAL_ENV.mailApiUrl through page.request': 'await page.request.get(`${SEAL_ENV.mailApiUrl}/api/v1/mailbox/x`);',
  'a request context aliased from page.request': 'const api = page.request;\nawait api.get(`${INBUCKET_URL}/x`);',
  'a request context destructured under another name':
    'const { request: api } = fixtures;\nawait api.get(`${INBUCKET_URL}/x`);',
  'a fixture parameter destructured under another name':
    "test('t', async ({ request: api }) => {\n  await api.get(`${INBUCKET_URL}/x`);\n});",
  'element access on the request context': "await request['get'](`${INBUCKET_URL}/x`);",
  'page.goto to Inbucket': 'await page.goto(`${INBUCKET_URL}/monitor`);',
  'page.evaluate fetching Inbucket': 'await page.evaluate(() => fetch(`${INBUCKET_URL}/api/v1/mailbox/x`));',
  'page.evaluate handed the Inbucket base': 'await page.evaluate((base) => fetch(base), INBUCKET_URL);',
  'an outer Inbucket url read inside a function':
    'const url = `${INBUCKET_URL}/x`;\nconst read = async () => {\n  await request.get(url);\n};',
};

const OTHER_FILE = { fileName: 'e2e/fixtures/other.ts', text: 'export const OTHER_MAIL = `${INBUCKET_URL}/api/v1`;' };

const plantedNegatives: Record<string, string> = {
  'Node fetch with the base inline': 'const res = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${box}`);',
  'Node fetch with the URL in a variable':
    'const url = `${INBUCKET_URL}/api/v1/mailbox/${box}`;\nconst res = await fetch(url);',
  'globalThis.fetch with the base inline': 'await globalThis.fetch(`${INBUCKET_URL}/api/v1/mailbox/x`);',
  'request.get on the app API': 'await request.get(`${WEBAPP_URL}/api/v1/documents`);',
  'a mail helper handed the request context': 'const list = await readMailbox(request, localPart);',
  'request.get on another member of the object holding mailApiUrl':
    "const SEAL_ENV = { mailApiUrl: INBUCKET_URL, baseUrl: 'http://app' };\nawait request.get(`${SEAL_ENV.baseUrl}/x`);",
  'request.get on a value read through Node fetch from Inbucket':
    'const res = await fetch(`${INBUCKET_URL}/api/v1/mailbox/x`);\nawait request.get(`${WEBAPP_URL}/${res.status}`);',
  'request.post to the app with a mailbox name in the body':
    'await request.post(`${WEBAPP_URL}/api/trpc/x`, { data: { box: INBUCKET_URL } });',
  'an app url inside a function shadowing an outer Inbucket url':
    'const url = `${INBUCKET_URL}/x`;\nconst read = async () => {\n  const url = `${WEBAPP_URL}/y`;\n  await request.get(url);\n};',
  'a parameter shadowing an outer Inbucket url':
    'const url = `${INBUCKET_URL}/x`;\nconst read = async (url: string) => await request.get(url);',
  'page.goto to the app': 'await page.goto(`${WEBAPP_URL}/documents`);',
  'page.evaluate without Inbucket': 'await page.evaluate(() => document.title);',
  'a destructured member that is not the request context':
    'const { other: api } = fixtures;\nawait api.get(`${INBUCKET_URL}/x`);',
};

test('C-F1c premise: the scanner flags planted traced Inbucket reads and passes Node fetch', async () => {
  for (const [name, text] of Object.entries(plantedPositives)) {
    expect
      .soft(
        findTracedInbucketReads([SEND_PATH, OTHER_FILE, { fileName: 'e2e/planted.spec.ts', text }]),
        `planted positive is flagged: ${name}`,
      )
      .toHaveLength(1);
  }

  for (const [name, text] of Object.entries(plantedNegatives)) {
    expect
      .soft(
        findTracedInbucketReads([SEND_PATH, OTHER_FILE, { fileName: 'e2e/planted.spec.ts', text }]),
        `planted negative is not flagged: ${name}`,
      )
      .toEqual([]);
  }

  expect(
    findTracedInbucketReads([{ fileName: 'e2e/planted.spec.ts', text: 'await request.get(`${INBUCKET_URL}/x`);' }]),
    'the flagged entry names file and line',
  ).toEqual(['e2e/planted.spec.ts:1']);
});

test('C-F1c no traced call in app-tests has a URL built from the Inbucket base', async () => {
  const sources = testSources();

  expect(
    sources.some((source) => source.fileName === path.join('e2e', 'fixtures', 'send-path.ts')),
    'premise: the scan reads e2e/fixtures/send-path.ts, where INBUCKET_URL is defined',
  ).toBe(true);

  expect(
    sources.some((source) => source.fileName === path.join('reporters', 'secret-values.ts')),
    'premise: the scan reads test code outside e2e, such as reporters/secret-values.ts',
  ).toBe(true);

  expect(findTracedInbucketReads(sources), 'traced calls that read Inbucket; read it with Node fetch instead').toEqual(
    [],
  );
});
