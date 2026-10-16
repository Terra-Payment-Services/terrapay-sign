/**
 * The upload screens refuse, before sending, files that together exceed what one request may carry.
 *
 * Written from the specification alone, before any implementation.
 *
 * | Test                                                                  | Criterion |
 * | --------------------------------------------------------------------- | --------- |
 * | upload_button_documents_refuses_66_mib_without_sending                | 1         |
 * | upload_button_templates_refuses_66_mib_without_sending                | 2         |
 * | drop_zone_documents_refuses_66_mib_without_sending                    | 3         |
 * | editor_upload_step_refuses_66_mib_without_sending                     | 4         |
 * | boundary_exactly_63_mib_is_sent                                       | 5         |
 * | boundary_63_mib_plus_one_byte_is_not_sent                             | 5         |
 * | small_pdfs_upload_as_today_on_the_documents_upload_button             | 6         |
 * | small_pdfs_upload_as_today_on_the_templates_upload_button             | 6         |
 * | small_pdfs_upload_as_today_on_the_documents_drop_zone                 | 6         |
 * | small_pdfs_upload_as_today_on_the_editor_upload_step                  | 6         |
 *
 * The harness server runs with NEXT_PUBLIC_DOCUMENT_SIZE_UPLOAD_LIMIT=5, at which the dropzones refuse each 33 MiB
 * file on its own. The setting reaches the browser at runtime (root.tsx writes the server's NEXT_PUBLIC_* values
 * into window.__ENV__), so each worker starts the built server of its own with the setting at 50 and everything
 * else inherited from .env. The server fixture is automatic, so every test in a worker signs in to that server.
 *
 * The files are assets/example.pdf padded with PDF comment lines after its end marker to an exact size, as
 * e2e/api/chunked-stall/support/raw-connection.ts pads its upload bodies.
 *
 * Expected on the build without the client check (red run): criteria 1 to 4 and the 63 MiB + 1 byte case fail,
 * because the request is sent (and the server answers 413 for 66 MiB) and the toast shown is not the one
 * specified. The exactly-63 MiB case and criterion 6 pass.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { test as base, expect, type Page } from '@playwright/test';

import { type SignServer, spawnSignServer, waitUntilServing } from '../directory-sync/support/sign-server';
import { apiSignin } from '../fixtures/authentication';
import { getEnvelopeItemDropzoneInput, getEnvelopeItemTitleInputs } from '../fixtures/envelope-editor';

const MIB = 1024 * 1024;

/** The specification's shared constant: 63 MiB. */
const COMBINED_LIMIT_BYTES = 63 * MIB;

const TOAST_TITLE = 'Files too large to upload together';
const TOAST_DESCRIPTION = 'These files add up to more than 63 MB. Upload them one at a time.';

const EXAMPLE_PDF = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));
const PADDING_LINE = '%padding padding padding padding padding\n';

/** How long to watch for a request after the screen has reacted. */
const QUIET_MS = 1_500;

/** A real PDF of exactly `size` bytes: example.pdf, a newline, then comment lines ending in a newline. */
const paddedPdf = (size: number) => {
  const padding = Buffer.alloc(size - EXAMPLE_PDF.length - 1);

  padding.fill(PADDING_LINE);
  padding[padding.length - 1] = 0x0a;

  return Buffer.concat([EXAMPLE_PDF, Buffer.from('\n'), padding]);
};

type Fixtures = {
  server: SignServer;
  pdfDir: string;
};

const test = base.extend<object, Fixtures>({
  server: [
    // biome-ignore lint/correctness/noEmptyPattern: required by the fixture signature
    async ({}, use, workerInfo) => {
      // spawnSignServer drops the jobs provider and the Entra settings for the directory-sync specs to choose;
      // these put back what .env gives the harness server, so only the upload limit differs.
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key === 'NEXT_PRIVATE_JOBS_PROVIDER' || key.startsWith('NEXT_PRIVATE_ENTRA_'),
        ),
      );
      const server = await spawnSignServer({
        ...inherited,
        NEXT_PUBLIC_DOCUMENT_SIZE_UPLOAD_LIMIT: '50',
      });

      try {
        await waitUntilServing(server);

        // apiSignin and the other fixtures read this at call time.
        process.env.NEXT_PUBLIC_WEBAPP_URL = server.origin;
        process.env.NEXT_PRIVATE_INTERNAL_WEBAPP_URL = server.origin;

        await use(server);
      } finally {
        const logFile = path.join(
          workerInfo.project.outputDir,
          `envelope-upload-combined-size-server-${workerInfo.workerIndex}.log`,
        );

        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.writeFileSync(logFile, server.output().replaceAll(os.hostname(), '<hostname>'));

        await server.stop();
      }
    },
    { scope: 'worker', timeout: 180_000, auto: true },
  ],
  pdfDir: [
    // biome-ignore lint/correctness/noEmptyPattern: required by the fixture signature
    async ({}, use) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'combined-size-'));

      await use(dir);

      fs.rmSync(dir, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],
});

test.describe.configure({ mode: 'default' });

type FileSpec = { name: string; size: number };

const writePdfs = (dir: string, specs: FileSpec[]) =>
  specs.map(({ name, size }) => {
    const file = path.join(dir, name);

    if (!fs.existsSync(file) || fs.statSync(file).size !== size) {
      fs.writeFileSync(file, paddedPdf(size));
    }

    return file;
  });

const TWO_33_MIB: FileSpec[] = [
  { name: 'first-33-mib.pdf', size: 33 * MIB },
  { name: 'second-33-mib.pdf', size: 33 * MIB },
];

const EXACTLY_63_MIB: FileSpec[] = [
  { name: 'boundary-33-mib.pdf', size: 33 * MIB },
  { name: 'boundary-30-mib.pdf', size: COMBINED_LIMIT_BYTES - 33 * MIB },
];

const OVER_BY_ONE_BYTE: FileSpec[] = [
  { name: 'boundary-33-mib.pdf', size: 33 * MIB },
  { name: 'boundary-30-mib-plus-one.pdf', size: COMBINED_LIMIT_BYTES - 33 * MIB + 1 },
];

const smallPdfs = (dir: string) => {
  const first = path.join(dir, 'small-one.pdf');
  const second = path.join(dir, 'small-two.pdf');

  fs.writeFileSync(first, EXAMPLE_PDF);
  fs.writeFileSync(second, EXAMPLE_PDF);

  return [first, second];
};

type Observed = { url: string; status: number | 'failed' | 'pending' };

/** Records every tRPC call to `procedure` the page makes, with how it ended. */
const watchProcedure = (page: Page, procedure: string) => {
  const observed = new Map<object, Observed>();
  const matches = (url: string) => new URL(url).pathname.split('/').pop()?.split(',').includes(procedure) ?? false;

  page.on('request', (request) => {
    if (matches(request.url())) {
      observed.set(request, { url: new URL(request.url()).pathname, status: 'pending' });
    }
  });
  page.on('response', (response) => {
    const entry = observed.get(response.request());

    if (entry) {
      entry.status = response.status();
    }
  });
  page.on('requestfailed', (request) => {
    const entry = observed.get(request);

    if (entry) {
      entry.status = 'failed';
    }
  });

  return {
    list: () => [...observed.values()],
    firstRequest: () => page.waitForRequest((request) => matches(request.url()), { timeout: 30_000 }),
  };
};

const describe = (observed: Observed[]) =>
  observed.length === 0 ? 'no request' : observed.map(({ url, status }) => `${url} answered ${status}`).join('; ');

const signInTo = async (page: Page, server: SignServer, area: 'documents' | 'templates') => {
  const { user, team } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/${area}` });
  await expect(page).toHaveURL(`${server.origin}/t/${team.url}/${area}`);

  return { user, team, url: page.url() };
};

const chooseThroughUploadButton = async (page: Page, buttonName: string, files: string[]) => {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: buttonName }).click(),
  ]);

  await chooser.setFiles(files);
};

/**
 * Drops files onto the page's drop zone with a real drop event. The files are built in the page, from
 * example.pdf padded as `paddedPdf` pads it, so that 66 MiB does not cross the browser protocol.
 */
const dropOntoPage = async (page: Page, specs: FileSpec[] | 'small') => {
  const dataTransfer = await page.evaluateHandle(
    ({ pdfBase64, specs, paddingLine }) => {
      const pdf = Uint8Array.from(atob(pdfBase64), (character) => character.charCodeAt(0));
      const line = new TextEncoder().encode(paddingLine);
      const transfer = new DataTransfer();
      const files =
        specs === 'small'
          ? [
              { name: 'small-one.pdf', size: pdf.length },
              { name: 'small-two.pdf', size: pdf.length },
            ]
          : specs;

      for (const { name, size } of files) {
        if (size === pdf.length) {
          transfer.items.add(new File([pdf], name, { type: 'application/pdf' }));
          continue;
        }

        const padding = new Uint8Array(size - pdf.length - 1);

        for (let offset = 0; offset < padding.length; offset += line.length) {
          padding.set(line.subarray(0, Math.min(line.length, padding.length - offset)), offset);
        }

        padding[padding.length - 1] = 0x0a;
        transfer.items.add(new File([pdf, new Uint8Array([0x0a]), padding], name, { type: 'application/pdf' }));
      }

      return transfer;
    },
    { pdfBase64: EXAMPLE_PDF.toString('base64'), specs, paddingLine: PADDING_LINE },
  );

  // The drop zone's own input carries no test id; the upload buttons' inputs do. It sits inside the zone's root,
  // so drag events dispatched on it bubble to the zone's handlers.
  const zoneInput = page.locator('input[type="file"]:not([data-testid])');

  await expect(zoneInput).toHaveCount(1);

  for (const type of ['dragenter', 'dragover', 'drop']) {
    await zoneInput.dispatchEvent(type, { dataTransfer });
  }
};

/** The specified toast, destructive, with the exact title and description. Soft, so the network is still checked. */
const expectCombinedSizeToast = async (page: Page) => {
  const toasts = page.locator('[data-testid="toast"]');
  const toast = toasts.filter({ hasText: TOAST_TITLE });

  // Whatever toast the screen shows first is recorded, so a red run says what appeared instead.
  await toasts
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => undefined);

  const shown = await toasts.allInnerTexts();

  test.info().annotations.push({ type: 'toasts-shown', description: JSON.stringify(shown) });

  await expect
    .soft(toast, `the combined-size toast appears (toasts shown: ${JSON.stringify(shown)})`)
    .toBeVisible({ timeout: 1_000 });
  await expect.soft(toast.getByText(TOAST_TITLE, { exact: true })).toBeVisible({ timeout: 1_000 });
  await expect.soft(toast.getByText(TOAST_DESCRIPTION, { exact: true })).toBeVisible({ timeout: 1_000 });
  await expect.soft(toast).toHaveClass(/\bdestructive\b/, { timeout: 1_000 });
};

const expectNothingSent = async (page: Page, watch: ReturnType<typeof watchProcedure>, procedure: string) => {
  await page.waitForTimeout(QUIET_MS);

  const observed = watch.list();

  await test.info().attach('observed-requests.json', {
    body: JSON.stringify(observed, null, 2),
    contentType: 'application/json',
  });

  expect.soft(observed, `no ${procedure} request is sent (observed: ${describe(observed)})`).toEqual([]);
};

test.describe('one upload request carries at most 63 MiB of files', () => {
  test('upload_button_documents_refuses_66_mib_without_sending', async ({ page, server, pdfDir }) => {
    const files = writePdfs(pdfDir, TWO_33_MIB);
    const { url } = await signInTo(page, server, 'documents');
    const watch = watchProcedure(page, 'envelope.create');

    await chooseThroughUploadButton(page, 'Upload Document', files);

    await expectCombinedSizeToast(page);
    await expectNothingSent(page, watch, 'envelope.create');
    expect.soft(page.url(), 'the page does not navigate').toBe(url);
  });

  test('upload_button_templates_refuses_66_mib_without_sending', async ({ page, server, pdfDir }) => {
    const files = writePdfs(pdfDir, TWO_33_MIB);
    const { url } = await signInTo(page, server, 'templates');
    const watch = watchProcedure(page, 'envelope.create');

    await chooseThroughUploadButton(page, 'Upload Template', files);

    await expectCombinedSizeToast(page);
    await expectNothingSent(page, watch, 'envelope.create');
    expect.soft(page.url(), 'the page does not navigate').toBe(url);
  });

  test('drop_zone_documents_refuses_66_mib_without_sending', async ({ page, server }) => {
    const { url } = await signInTo(page, server, 'documents');
    const watch = watchProcedure(page, 'envelope.create');

    await dropOntoPage(page, TWO_33_MIB);

    await expectCombinedSizeToast(page);
    await expectNothingSent(page, watch, 'envelope.create');
    expect.soft(page.url(), 'the page does not navigate').toBe(url);
  });

  test('editor_upload_step_refuses_66_mib_without_sending', async ({ page, pdfDir }) => {
    const files = writePdfs(pdfDir, TWO_33_MIB);
    const { user, team } = await seedUser();
    const document = await seedBlankDocument(user, team.id, { internalVersion: 2 });
    const editorPath = `/t/${team.url}/documents/${document.id}/edit?step=uploadAndRecipients`;

    await apiSignin({ page, email: user.email, redirectPath: editorPath });
    await expect(page.getByRole('heading', { name: 'Recipients' })).toBeVisible();

    const rows = page.locator('[data-testid="envelope-items-list"] [data-testid^="envelope-item-row-"]');

    await expect(rows.first()).toBeVisible();

    const before = await rows.count();
    const url = page.url();
    const watch = watchProcedure(page, 'envelope.item.createMany');

    await getEnvelopeItemDropzoneInput(page).setInputFiles(files);

    await expectCombinedSizeToast(page);
    await expectNothingSent(page, watch, 'envelope.item.createMany');
    expect.soft(await rows.count(), 'no item is added to the list').toBe(before);
    expect.soft(page.url(), 'the page does not navigate').toBe(url);
  });

  test('boundary_exactly_63_mib_is_sent', async ({ page, server, pdfDir }) => {
    const files = writePdfs(pdfDir, EXACTLY_63_MIB);

    expect(files.reduce((sum, file) => sum + fs.statSync(file).size, 0)).toBe(COMBINED_LIMIT_BYTES);

    await signInTo(page, server, 'documents');
    const watch = watchProcedure(page, 'envelope.create');
    const sent = watch.firstRequest();

    await chooseThroughUploadButton(page, 'Upload Document', files);

    await sent;
    await expect(page.locator('[data-testid="toast"]').filter({ hasText: TOAST_TITLE })).toHaveCount(0);
  });

  test('boundary_63_mib_plus_one_byte_is_not_sent', async ({ page, server, pdfDir }) => {
    const files = writePdfs(pdfDir, OVER_BY_ONE_BYTE);

    expect(files.reduce((sum, file) => sum + fs.statSync(file).size, 0)).toBe(COMBINED_LIMIT_BYTES + 1);

    const { url } = await signInTo(page, server, 'documents');
    const watch = watchProcedure(page, 'envelope.create');

    await chooseThroughUploadButton(page, 'Upload Document', files);

    await expectCombinedSizeToast(page);
    await expectNothingSent(page, watch, 'envelope.create');
    expect.soft(page.url(), 'the page does not navigate').toBe(url);
  });
});

test.describe('files within 63 MiB upload as today', () => {
  test('small_pdfs_upload_as_today_on_the_documents_upload_button', async ({ page, server, pdfDir }) => {
    const { team } = await signInTo(page, server, 'documents');

    await chooseThroughUploadButton(page, 'Upload Document', smallPdfs(pdfDir));

    await page.waitForURL(new RegExp(`/t/${team.url}/documents/[^/]+/edit`));
    await expect(page.getByRole('heading', { name: 'Recipients' })).toBeVisible();
    await expect(getEnvelopeItemTitleInputs(page)).toHaveCount(2);
  });

  test('small_pdfs_upload_as_today_on_the_templates_upload_button', async ({ page, server, pdfDir }) => {
    const { team } = await signInTo(page, server, 'templates');

    await chooseThroughUploadButton(page, 'Upload Template', smallPdfs(pdfDir));

    await page.waitForURL(new RegExp(`/t/${team.url}/templates/[^/]+/edit`));
    await expect(page.getByRole('heading', { name: 'Recipients' })).toBeVisible();
    await expect(getEnvelopeItemTitleInputs(page)).toHaveCount(2);
  });

  test('small_pdfs_upload_as_today_on_the_documents_drop_zone', async ({ page, server }) => {
    const { team } = await signInTo(page, server, 'documents');

    await dropOntoPage(page, 'small');

    await page.waitForURL(new RegExp(`/t/${team.url}/documents/[^/]+/edit`));
    await expect(page.getByRole('heading', { name: 'Recipients' })).toBeVisible();
    await expect(getEnvelopeItemTitleInputs(page)).toHaveCount(2);
  });

  test('small_pdfs_upload_as_today_on_the_editor_upload_step', async ({ page, pdfDir }) => {
    const { user, team } = await seedUser();
    const document = await seedBlankDocument(user, team.id, { internalVersion: 2 });

    await apiSignin({
      page,
      email: user.email,
      redirectPath: `/t/${team.url}/documents/${document.id}/edit?step=uploadAndRecipients`,
    });
    await expect(page.getByRole('heading', { name: 'Recipients' })).toBeVisible();

    const titles = getEnvelopeItemTitleInputs(page);

    await expect(titles.first()).toBeVisible();

    const before = await titles.count();

    await getEnvelopeItemDropzoneInput(page).setInputFiles(smallPdfs(pdfDir));

    await expect(titles).toHaveCount(before + 2, { timeout: 20_000 });
  });
});
