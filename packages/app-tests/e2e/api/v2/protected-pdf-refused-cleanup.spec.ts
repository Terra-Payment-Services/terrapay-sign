/**
 * A refused upload leaves no stored document data (criterion 16).
 *
 * Written from the specification alone, without reading any implementation.
 *
 * Criteria 7 and 9 refuse some uploads. Whatever the refusal, the file must
 * not be left behind in storage (F15). Each test uses a freshly encrypted
 * file, so its bytes are unique to the test, and looks for leftovers three
 * ways:
 *
 * - DocumentData rows owned by the test's user or team (the columns the
 *   schema documents as "the person whose request minted these bytes" and
 *   "the team the bytes were minted for");
 * - DocumentData rows whose data or initialData is the upload's base64,
 *   which is how the database transport stores bytes;
 * - with the S3 transport, objects in the bucket whose key contains the
 *   upload's unique marker (the transport keys files as
 *   `<random>/<slugged filename>`, seen on stored rows).
 *
 * A DocumentData row for a database-transport upload holds the bytes; for an
 * S3 upload it holds the key, so the marker match covers both.
 *
 * | Test                                                       | Criteria | Failure modes |
 * | ---------------------------------------------------------- | -------- | ------------- |
 * | password pdf refused at envelope create stores nothing      | 16, 7    | F15           |
 * | password pdf refused as an extra document stores nothing    | 16, 7    | F15           |
 * | password pdf refused at the web upload endpoint stores      | 16, 7    | F15           |
 * |   nothing                                                   |          |               |
 * | owner-restricted pdf refused at legacy create stores        | 16, 9    | F15           |
 * |   nothing [x3 ciphers]                                      |          |               |
 */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';

import { apiCreateEnvelope, apiCreateTestContext } from '../../fixtures/api-seeds';
import { apiSignin } from '../../fixtures/authentication';
import {
  API_BASE_URL,
  assertVerifierToolsPresent,
  buildFreshOpenPasswordPdf,
  buildFreshOwnerOnlyPdf,
  OWNER_ONLY_ALGORITHMS,
} from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

const WEBAPP_BASE_URL = API_BASE_URL.replace(/\/api\/v2-beta$/, '');

/**
 * A file name whose distinctive part is lowercase letters only, so it survives
 * the slugging the S3 transport applies to keys (seen on a leftover row:
 * `legacy-AES-256-...` was stored as `<random>/legacy-aes-256-...`).
 */
const uniqueName = (label: string) => {
  const marker = Array.from({ length: 16 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');

  return { filename: `${label}-${marker}.pdf`, marker };
};

const s3ObjectsMarked = async (marker: string) => {
  if (process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT !== 's3') {
    return [];
  }

  const client = new S3Client({
    endpoint: process.env.NEXT_PRIVATE_UPLOAD_ENDPOINT,
    forcePathStyle: process.env.NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE === 'true',
    region: process.env.NEXT_PRIVATE_UPLOAD_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY ?? '',
    },
  });

  const keys: string[] = [];
  let token: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: process.env.NEXT_PRIVATE_UPLOAD_BUCKET, ContinuationToken: token }),
    );

    keys.push(...(page.Contents ?? []).map((object) => object.Key ?? '').filter((key) => key.includes(marker)));
    token = page.NextContinuationToken;
  } while (token);

  return keys;
};

/** Everything a refused upload could have left behind, so one assertion reports all of it. */
const leftovers = async ({
  userId,
  teamId,
  file,
  marker,
}: {
  userId: number;
  teamId: number;
  file: Buffer;
  marker: string;
}) => {
  const base64 = file.toString('base64');

  return {
    documentDataOwnedByUserOrTeam: await prisma.documentData.count({ where: { OR: [{ userId }, { teamId }] } }),
    documentDataHoldingTheBytes: await prisma.documentData.count({
      where: { OR: [{ data: base64 }, { initialData: base64 }, { data: { contains: marker } }] },
    }),
    s3ObjectsWithTheFileName: (await s3ObjectsMarked(marker)).length,
  };
};

const NOTHING_LEFT = { documentDataOwnedByUserOrTeam: 0, documentDataHoldingTheBytes: 0, s3ObjectsWithTheFileName: 0 };

const postMultipart = async (
  request: APIRequestContext,
  url: string,
  token: string,
  payload: Record<string, unknown>,
  fileField: string,
  file: Buffer,
  filename: string,
) => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify(payload));
  formData.append(fileField, new File([file], filename, { type: 'application/pdf' }));

  return await request.post(url, { headers: { Authorization: `Bearer ${token}` }, multipart: formData });
};

test('criterion_16_password_pdf_refused_at_envelope_create_leaves_no_stored_document_data', async ({ request }) => {
  const { token, user, team } = await apiCreateTestContext('refused-cleanup-create');
  const file = await buildFreshOpenPasswordPdf();
  const { filename, marker } = uniqueName('password');

  const res = await postMultipart(
    request,
    `${API_BASE_URL}/envelope/create`,
    token,
    { type: 'DOCUMENT', title: filename },
    'files',
    file,
    filename,
  );

  expect(res.status(), `premise: the upload is refused (criterion 7): ${await res.text()}`).toBe(400);
  expect(await leftovers({ userId: user.id, teamId: team.id, file, marker })).toEqual(NOTHING_LEFT);
});

test('criterion_16_password_pdf_refused_as_an_extra_document_leaves_no_stored_document_data', async ({ request }) => {
  const { token, user, team } = await apiCreateTestContext('refused-cleanup-item');
  const { id: envelopeId } = await apiCreateEnvelope(request, token, { title: 'Existing envelope' });

  // The envelope's own first document is legitimately stored; count only what
  // the refused upload adds.
  const ownedBefore = await prisma.documentData.count({ where: { OR: [{ userId: user.id }, { teamId: team.id }] } });

  const file = await buildFreshOpenPasswordPdf();
  const { filename, marker } = uniqueName('password-item');

  const res = await postMultipart(
    request,
    `${API_BASE_URL}/envelope/item/create-many`,
    token,
    { envelopeId },
    'files',
    file,
    filename,
  );

  expect(res.status(), `premise: the upload is refused (criterion 7): ${await res.text()}`).toBe(400);
  expect(await leftovers({ userId: user.id, teamId: team.id, file, marker })).toEqual({
    ...NOTHING_LEFT,
    documentDataOwnedByUserOrTeam: ownedBefore,
  });
});

test('criterion_16_password_pdf_refused_at_the_web_upload_endpoint_leaves_no_stored_document_data', async ({
  page,
}) => {
  const { user, team } = await apiCreateTestContext('refused-cleanup-web');

  await apiSignin({ page, email: user.email });

  const { request } = page.context();
  const file = await buildFreshOpenPasswordPdf();
  const { filename, marker } = uniqueName('password-web');

  const formData = new FormData();
  formData.append('file', new File([file], filename, { type: 'application/pdf' }));

  const res = await request.post(`${WEBAPP_BASE_URL}/api/files/upload-pdf`, {
    multipart: formData,
  });

  expect(res.status(), `premise: the upload is refused (criterion 7): ${await res.text()}`).toBe(400);
  expect(await leftovers({ userId: user.id, teamId: team.id, file, marker })).toEqual(NOTHING_LEFT);
});

for (const algorithm of OWNER_ONLY_ALGORITHMS) {
  test(`criterion_16_owner_restricted_pdf_refused_at_legacy_create_leaves_no_stored_document_data (${algorithm})`, async ({
    request,
  }) => {
    const { token, user, team } = await apiCreateTestContext('refused-cleanup-legacy');
    const file = await buildFreshOwnerOnlyPdf(algorithm);
    const { filename, marker } = uniqueName(`legacy-${algorithm.toLowerCase().replace(/[^a-z]/g, '')}`);

    const res = await postMultipart(
      request,
      `${API_BASE_URL}/document/create`,
      token,
      { title: filename },
      'file',
      file,
      filename,
    );

    expect(
      res.status(),
      `premise: the V1 document is refused (criterion 9): ${await res.text()}`,
    ).toBeGreaterThanOrEqual(400);
    expect(await leftovers({ userId: user.id, teamId: team.id, file, marker })).toEqual(NOTHING_LEFT);
  });
}
