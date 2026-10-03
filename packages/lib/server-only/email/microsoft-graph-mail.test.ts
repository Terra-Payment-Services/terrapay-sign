import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGraphMessage,
  fitsInOneRequest,
  getGraphToken,
  INLINE_ATTACHMENT_LIMIT_BYTES,
  resetGraphTokenCache,
  sendGraphMail,
  UPLOAD_CHUNK_BYTES,
} from './microsoft-graph-mail';

const credentials = { tenantId: 'tenant', clientId: 'client', clientSecret: 'secret' };

const mail = (overrides: Partial<Parameters<typeof sendGraphMail>[0]> = {}) => ({
  from: { address: 'noreply@example.com', name: 'TerraPay Sign' },
  to: [{ address: 'signer@example.com', name: 'A Signer' }],
  subject: 'Signing Complete!',
  html: '<p>done</p>',
  text: 'done',
  ...overrides,
});

/**
 * A fetch that answers the token endpoint and then whatever the test queues,
 * recording every call so the assertions can be about what Graph was actually
 * asked to do rather than about the return value.
 */
const stubFetch = (
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string>; rejectsWith?: Error }>,
) => {
  const calls: Array<{
    url: string;
    method?: string;
    headers: Record<string, string>;
    body: unknown;
    redirect?: RequestRedirect;
  }> = [];
  let next = 0;

  const impl = vi.fn((url: string | URL, options: RequestInit = {}) => {
    const href = url.toString();

    calls.push({
      url: href,
      method: options.method,
      headers: (options.headers ?? {}) as Record<string, string>,
      body: options.body,
      redirect: options.redirect,
    });

    if (href.includes('/oauth2/v2.0/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'a-token', expires_in: 3600 }), { status: 200 }),
      );
    }

    const queued = responses[next] ?? { status: 200, body: {} };
    next += 1;

    // A request that never comes back with anything: a timeout, a reset, or a
    // redirect the platform turned into a network error.
    if (queued.rejectsWith) {
      return Promise.reject(queued.rejectsWith);
    }

    return Promise.resolve(
      new Response(queued.body === undefined ? null : JSON.stringify(queued.body), {
        status: queued.status ?? 200,
        headers: { 'content-type': 'application/json', ...(queued.headers ?? {}) },
      }),
    );
  });

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { impl: impl as unknown as typeof fetch, calls };
};

/**
 * What Graph actually answers during a chunked upload: `200` with the ranges it
 * still wants, and `201` with a Location only once the attachment exists.
 * Modelled here because accepting any 2xx as success is precisely the defect
 * these tests exist to prevent coming back.
 */
const MORE_WANTED = { status: 200, body: { nextExpectedRanges: ['1-'] } };
const ATTACHED = {
  status: 201,
  body: {},
  headers: { location: 'https://outlook.office.com/api/v2.0/me/messages/x/attachments/y' },
};

const graphCalls = <T extends { url: string }>(calls: T[]): T[] =>
  calls.filter((call) => call.url.includes('graph.microsoft.com'));

const deleteCalls = <T extends { method?: string }>(calls: T[]): T[] =>
  calls.filter((call) => call.method === 'DELETE');

/**
 * A Graph that is reached through something that redirects, which is how the
 * deployment's egress proxy declines a POST it does not like.
 *
 * The request matching `redirected` meets a 307. What happens then is the
 * platform's decision, made from the redirect option the caller set, so this
 * models both outcomes. `error` is a network error, which is what refusing
 * looks like from inside fetch. Following instead replays the POST body at
 * whatever the hop named, and the target here answers 202: the one status this
 * transport reads as a message taken for delivery. So a test that reaches the
 * 202 has proved the contract left for somewhere nobody chose and was written
 * down as sent.
 */
const redirectedFetch = (
  redirected: (url: string) => boolean,
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string>; rejectsWith?: Error }> = [],
) => {
  const { impl: direct, calls } = stubFetch(responses);

  const impl = vi.fn((url: string | URL, options: RequestInit = {}) => {
    const href = url.toString();

    if (!redirected(href)) {
      return direct(href, options);
    }

    calls.push({
      url: href,
      method: options.method,
      headers: (options.headers ?? {}) as Record<string, string>,
      body: options.body,
      redirect: options.redirect,
    });

    if (options.redirect === 'error') {
      return Promise.reject(new TypeError('fetch failed'));
    }

    return Promise.resolve(new Response(null, { status: 202 }));
  });

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { impl: impl as unknown as typeof fetch, calls };
};

beforeEach(() => {
  resetGraphTokenCache();
});

describe('getGraphToken', () => {
  it('asks for a client credentials token and reuses it while it is good', async () => {
    const { impl, calls } = stubFetch([]);

    expect(await getGraphToken(credentials, impl)).toBe('a-token');
    expect(await getGraphToken(credentials, impl)).toBe('a-token');

    expect(calls.filter((call) => call.url.includes('/oauth2/v2.0/token'))).toHaveLength(1);
    expect(String(calls[0].body)).toContain('grant_type=client_credentials');
    expect(String(calls[0].body)).toContain('scope=https%3A%2F%2Fgraph.microsoft.com%2F.default');
  });

  it('reports the tenant error rather than a bare status, and never the secret', async () => {
    const impl = vi.fn(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' }),
            { status: 401 },
          ),
        ),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    ) as unknown as typeof fetch;

    // The code, and nothing else. Entra puts request context into
    // error_description, which has been seen to carry submitted parameters, and
    // this error string is logged.
    await expect(getGraphToken(credentials, impl)).rejects.toThrow(/invalid_client/);
    await expect(getGraphToken(credentials, impl)).rejects.not.toThrow(/AADSTS7000215/);
    await expect(getGraphToken(credentials, impl)).rejects.not.toThrow(/Invalid client secret/);
  });
});

describe('fitsInOneRequest', () => {
  it('sends an ordinary notice in one request', () => {
    expect(fitsInOneRequest(mail())).toBe(true);
  });

  it('refuses a single attachment at the inline limit', () => {
    const attachment = { filename: 'contract.pdf', content: Buffer.alloc(INLINE_ATTACHMENT_LIMIT_BYTES) };

    expect(fitsInOneRequest(mail({ attachments: [attachment] }))).toBe(false);
  });

  it('refuses several small attachments that together will not fit', () => {
    // Each is under the per-attachment limit and the set is not. Judged on the
    // base64 size, since that is what travels.
    const attachments = Array.from({ length: 3 }, (_, index) => ({
      filename: `part-${index}.pdf`,
      content: Buffer.alloc(1024 * 1024),
    }));

    expect(fitsInOneRequest(mail({ attachments }))).toBe(false);
  });

  it('accepts one small attachment', () => {
    const attachments = [{ filename: 'receipt.pdf', content: Buffer.alloc(64 * 1024) }];

    expect(fitsInOneRequest(mail({ attachments }))).toBe(true);
  });
});

describe('buildGraphMessage', () => {
  it('prefers the HTML body and carries every recipient kind', () => {
    const message = buildGraphMessage(
      mail({
        cc: [{ address: 'cc@example.com' }],
        bcc: [{ address: 'bcc@example.com' }],
        replyTo: [{ address: 'legal@terrapay.com' }],
      }),
      { inlineAttachments: false },
    );

    expect(message.body).toEqual({ contentType: 'HTML', content: '<p>done</p>' });
    expect(message.toRecipients).toEqual([{ emailAddress: { address: 'signer@example.com', name: 'A Signer' } }]);
    expect(message.ccRecipients).toEqual([{ emailAddress: { address: 'cc@example.com' } }]);
    expect(message.bccRecipients).toEqual([{ emailAddress: { address: 'bcc@example.com' } }]);
    expect(message.replyTo).toEqual([{ emailAddress: { address: 'legal@terrapay.com' } }]);
  });

  it('falls back to the text body when there is no HTML', () => {
    const message = buildGraphMessage(mail({ html: undefined }), { inlineAttachments: false });

    expect(message.body).toEqual({ contentType: 'Text', content: 'done' });
  });

  it('keeps only x- headers, which are the only ones Graph accepts', () => {
    const message = buildGraphMessage(mail({ headers: { 'X-Documenso-Envelope': 'abc', Subject: 'not this one' } }), {
      inlineAttachments: false,
    });

    expect(message.internetMessageHeaders).toEqual([{ name: 'X-Documenso-Envelope', value: 'abc' }]);
  });

  it('leaves attachments out of the draft on the upload path', () => {
    const attachments = [{ filename: 'contract.pdf', content: Buffer.from('pdf') }];

    expect(buildGraphMessage(mail({ attachments }), { inlineAttachments: false }).attachments).toBeUndefined();
    expect(buildGraphMessage(mail({ attachments }), { inlineAttachments: true }).attachments).toEqual([
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'contract.pdf',
        contentType: 'application/octet-stream',
        contentBytes: Buffer.from('pdf').toString('base64'),
      },
    ]);
  });
});

describe('sendGraphMail', () => {
  it('sends a plain notice as one call to the from mailbox', async () => {
    const { impl, calls } = stubFetch([{ status: 202 }]);

    await sendGraphMail(mail(), { credentials, fetchImpl: impl });

    const sent = graphCalls(calls);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://graph.microsoft.com/v1.0/users/noreply%40example.com/sendMail');
    expect(sent[0].headers.authorization).toBe('Bearer a-token');
    expect(JSON.parse(String(sent[0].body)).saveToSentItems).toBe(false);
  });

  it('refuses a message with no recipients rather than asking Graph to', async () => {
    const { impl, calls } = stubFetch([]);

    await expect(sendGraphMail(mail({ to: [] }), { credentials, fetchImpl: impl })).rejects.toThrow(/no recipients/);
    expect(graphCalls(calls)).toHaveLength(0);
  });

  it('creates a draft, uploads the attachment and sends it when it will not fit', async () => {
    // The shape that matters: a completion email carrying a real signed
    // contract. The one this fork was tested against is 5.4 MB, which the
    // single request path cannot carry at all.
    const content = Buffer.alloc(5 * 1024 * 1024, 7);
    const chunks = Math.ceil(content.length / UPLOAD_CHUNK_BYTES);
    const { impl, calls } = stubFetch([
      { body: { id: 'draft-1' } },
      { body: { uploadUrl: 'https://outlook.office.com/session' } },
      ...Array.from({ length: chunks - 1 }, () => MORE_WANTED),
      ATTACHED,
      { status: 202 },
    ]);

    await sendGraphMail(mail({ attachments: [{ filename: 'contract.pdf', content }] }), {
      credentials,
      fetchImpl: impl,
    });

    const urls = graphCalls(calls).map((call) => call.url);

    expect(urls[0]).toBe('https://graph.microsoft.com/v1.0/users/noreply%40example.com/messages');
    expect(urls[1]).toContain('/messages/draft-1/attachments/createUploadSession');
    expect(urls.at(-1)).toContain('/messages/draft-1/send');

    // Never through sendMail, which would have failed on the size.
    expect(urls.some((url) => url.endsWith('/sendMail'))).toBe(false);
  });

  it('refuses to send when the last chunk does not confirm the attachment', async () => {
    // The defect this whole rewrite exists for. Graph answers an incomplete
    // upload with 200 and the ranges it still wants; only 201 with a Location
    // means the attachment was created. Accepting any 2xx sent a completion
    // email with no contract on it and recorded it as delivered.
    const content = Buffer.alloc(INLINE_ATTACHMENT_LIMIT_BYTES + 1, 1);
    const { impl, calls } = stubFetch([
      { body: { id: 'draft-2' } },
      { body: { uploadUrl: 'https://outlook.office.com/session' } },
      MORE_WANTED,
      { status: 200, body: {} },
    ]);

    await expect(
      sendGraphMail(mail({ attachments: [{ filename: 'c.pdf', content }] }), { credentials, fetchImpl: impl }),
    ).rejects.toThrow(/did not confirm c\.pdf was attached/);

    expect(graphCalls(calls).some((call) => call.url.endsWith('/send'))).toBe(false);
  });

  it('refuses to continue when Graph does not ask for more bytes', async () => {
    const content = Buffer.alloc(UPLOAD_CHUNK_BYTES * 2, 1);
    const { impl, calls } = stubFetch([
      { body: { id: 'draft-3' } },
      { body: { uploadUrl: 'https://outlook.office.com/session' } },
      { status: 200, body: {} },
    ]);

    await expect(
      sendGraphMail(mail({ attachments: [{ filename: 'c.pdf', content }] }), { credentials, fetchImpl: impl }),
    ).rejects.toThrow(/did not ask for more of c\.pdf/);

    expect(graphCalls(calls).some((call) => call.url.endsWith('/send'))).toBe(false);
  });

  it('attaches a small document directly rather than opening a session for it', async () => {
    // Three 1 MB documents exceed the inline ceiling together but none reaches
    // it alone, and Graph refuses an upload session below that ceiling. Judging
    // them collectively sent every one down a path that rejects them, so a
    // completion email carrying several small documents never sent at all.
    const attachments = Array.from({ length: 3 }, (_, index) => ({
      filename: `part-${index}.pdf`,
      content: Buffer.alloc(1024 * 1024, index),
    }));
    const { impl, calls } = stubFetch([
      { body: { id: 'draft-4' } },
      { status: 201, body: { id: 'att-1' } },
      { status: 201, body: { id: 'att-2' } },
      { status: 201, body: { id: 'att-3' } },
      { status: 202 },
    ]);

    await sendGraphMail(mail({ attachments }), { credentials, fetchImpl: impl });

    const urls = graphCalls(calls).map((call) => call.url);

    expect(urls.filter((url) => url.endsWith('/messages/draft-4/attachments'))).toHaveLength(3);
    expect(urls.some((url) => url.includes('createUploadSession'))).toBe(false);
    expect(urls.at(-1)).toContain('/send');
  });

  it('sends every chunk with the content type Graph requires', async () => {
    const content = Buffer.alloc(UPLOAD_CHUNK_BYTES + 11, 3);
    const { impl, calls } = stubFetch([
      { body: { id: 'draft-5' } },
      { body: { uploadUrl: 'https://outlook.office.com/session' } },
      MORE_WANTED,
      ATTACHED,
      { status: 202 },
    ]);

    await sendGraphMail(mail({ attachments: [{ filename: 'big.pdf', content }] }), {
      credentials,
      fetchImpl: impl,
    });

    const uploads = calls.filter((call) => call.url === 'https://outlook.office.com/session');

    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.headers['content-type']).toBe('application/octet-stream');
      // The upload URL carries its own authorisation.
      expect(upload.headers.authorization).toBeUndefined();
    }
    expect(uploads.map((upload) => upload.headers['content-range'])).toEqual([
      `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${content.length}`,
      `bytes ${UPLOAD_CHUNK_BYTES}-${content.length - 1}/${content.length}`,
    ]);
  });

  it('refuses an upload url that is not a Microsoft host', async () => {
    // The bytes are a signed contract and the URL is opaque and
    // pre-authenticated, so a tampered session response must not be able to
    // redirect them, including to somewhere inside our own network.
    const content = Buffer.alloc(INLINE_ATTACHMENT_LIMIT_BYTES + 1, 1);
    const { impl, calls } = stubFetch([
      { body: { id: 'draft-6' } },
      { body: { uploadUrl: 'http://169.254.169.254/latest/meta-data' } },
    ]);

    await expect(
      sendGraphMail(mail({ attachments: [{ filename: 'c.pdf', content }] }), { credentials, fetchImpl: impl }),
    ).rejects.toThrow(/not a Microsoft upload host/);

    expect(calls.some((call) => call.url.includes('169.254.169.254'))).toBe(false);
  });

  it('says which mailbox was refused when the access policy does not admit it', async () => {
    const { impl } = stubFetch([
      {
        status: 403,
        body: { error: { code: 'ErrorAccessDenied', message: 'Access to OData is disabled.' } },
      },
    ]);

    await expect(sendGraphMail(mail(), { credentials, fetchImpl: impl })).rejects.toThrow(
      /send mail as noreply@example\.com \(403\): ErrorAccessDenied/,
    );
  });

  it('does not repeat what the provider said, only the code', async () => {
    const { impl } = stubFetch([
      {
        status: 403,
        body: { error: { code: 'ErrorAccessDenied', message: 'token=abc123 secret=hunter2' } },
      },
    ]);

    await expect(sendGraphMail(mail(), { credentials, fetchImpl: impl })).rejects.not.toThrow(/hunter2/);
  });

  it('fails rather than sending a half uploaded attachment', async () => {
    const content = Buffer.alloc(INLINE_ATTACHMENT_LIMIT_BYTES + 1, 1);
    const { impl, calls } = stubFetch([
      { body: { id: 'draft-7' } },
      { body: { uploadUrl: 'https://outlook.office.com/session' } },
      { status: 507, body: { error: { code: 'InsufficientStorage' } } },
    ]);

    await expect(
      sendGraphMail(mail({ attachments: [{ filename: 'c.pdf', content }] }), { credentials, fetchImpl: impl }),
    ).rejects.toThrow(/rejected bytes 0-/);

    expect(graphCalls(calls).some((call) => call.url.endsWith('/send'))).toBe(false);
  });

  it('refuses a final chunk that is 200 even when it carries a Location', async () => {
    const content = Buffer.alloc(INLINE_ATTACHMENT_LIMIT_BYTES + 1, 1);
    const { impl, calls } = stubFetch([
      { body: { id: 'draft-8' } },
      { body: { uploadUrl: 'https://outlook.office.com/session' } },
      MORE_WANTED,
      { status: 200, body: {}, headers: { location: 'https://outlook.office.com/a/b' } },
    ]);

    await expect(
      sendGraphMail(mail({ attachments: [{ filename: 'c.pdf', content }] }), { credentials, fetchImpl: impl }),
    ).rejects.toThrow(/did not confirm c\.pdf was attached/);

    expect(graphCalls(calls).some((call) => call.url.endsWith('/send'))).toBe(false);
  });

  it('refuses a final chunk that is 201 without a Location', async () => {
    const content = Buffer.alloc(INLINE_ATTACHMENT_LIMIT_BYTES + 1, 1);
    const { impl, calls } = stubFetch([
      { body: { id: 'draft-9' } },
      { body: { uploadUrl: 'https://outlook.office.com/session' } },
      MORE_WANTED,
      { status: 201, body: {} },
    ]);

    await expect(
      sendGraphMail(mail({ attachments: [{ filename: 'c.pdf', content }] }), { credentials, fetchImpl: impl }),
    ).rejects.toThrow(/did not confirm c\.pdf was attached/);

    expect(graphCalls(calls).some((call) => call.url.endsWith('/send'))).toBe(false);
  });

  it('refuses a small attachment that Graph did not return an id for', async () => {
    // The same rule as the chunked path. A 2xx with no created attachment is
    // not proof, and sending on it puts out a completion email with nothing
    // attached.
    const attachments = [{ filename: 'small.pdf', content: Buffer.alloc(1024 * 1024, 1) }];
    const { impl, calls } = stubFetch([{ body: { id: 'draft-10' } }, { status: 202, body: {} }]);

    await expect(
      sendGraphMail(mail({ attachments: [...attachments, ...attachments, ...attachments] }), {
        credentials,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/did not confirm small\.pdf was attached/);

    expect(graphCalls(calls).some((call) => call.url.endsWith('/send'))).toBe(false);
  });

  it('refuses an upload host that is allowed but on an unexpected port', async () => {
    const content = Buffer.alloc(INLINE_ATTACHMENT_LIMIT_BYTES + 1, 1);
    const { impl } = stubFetch([
      { body: { id: 'draft-11' } },
      { body: { uploadUrl: 'https://outlook.office.com:8443/session' } },
    ]);

    await expect(
      sendGraphMail(mail({ attachments: [{ filename: 'c.pdf', content }] }), { credentials, fetchImpl: impl }),
    ).rejects.toThrow(/not a Microsoft upload host/);
  });

  it('will not follow a redirect away from the checked upload origin', async () => {
    const content = Buffer.alloc(INLINE_ATTACHMENT_LIMIT_BYTES + 1, 1);
    const { impl, calls } = stubFetch([
      { body: { id: 'draft-12' } },
      { body: { uploadUrl: 'https://outlook.office.com/session' } },
      ATTACHED,
      { status: 202 },
    ]);

    await sendGraphMail(mail({ attachments: [{ filename: 'c.pdf', content }] }), {
      credentials,
      fetchImpl: impl,
    });

    // The origin is checked once, before the first byte, so the request must
    // refuse a redirect rather than let it move the destination afterwards.
    const uploads = calls.filter((call) => call.url === 'https://outlook.office.com/session');

    expect(uploads).toHaveLength(1);
    for (const upload of uploads) {
      expect(upload.redirect).toBe('error');
    }
  });

  it('refuses a 200 from sendMail, which is not an answer Graph gives', async () => {
    // Graph documents one success for this call: 202 with an empty body. A 200
    // is something else answering, and the likeliest something else is the
    // proxy this deployment's outbound traffic goes through, serving its own
    // page. Accepting it recorded a signing request as sent that never reached
    // Exchange, and a body-less 200 leaves nothing to notice it by afterwards.
    const { impl } = stubFetch([{ status: 200, body: {} }]);

    await expect(sendGraphMail(mail(), { credentials, fetchImpl: impl })).rejects.toThrow(
      /did not accept the request to send mail as noreply@example\.com: expected 202 Accepted, got 200/,
    );
  });

  it('refuses a 204 from sendMail as readily as a failure status', async () => {
    const { impl } = stubFetch([{ status: 204, body: undefined }]);

    await expect(sendGraphMail(mail(), { credentials, fetchImpl: impl })).rejects.toThrow(/expected 202 Accepted/);
  });

  it('refuses a draft send that answers anything but 202, attachment or no attachment', async () => {
    // The attachment went up and Graph confirmed it, so the draft is complete
    // and sitting in the mailbox. That makes the send the only step left to get
    // wrong, and it is the step with no body to inspect. Reporting success off
    // a 200 here leaves a finished contract in Drafts while the audit log says
    // the recipient has it.
    const content = Buffer.alloc(INLINE_ATTACHMENT_LIMIT_BYTES + 1, 1);
    const { impl, calls } = stubFetch([
      { body: { id: 'draft-13' } },
      { body: { uploadUrl: 'https://outlook.office.com/session' } },
      ATTACHED,
      { status: 200, body: {} },
    ]);

    await expect(
      sendGraphMail(mail({ attachments: [{ filename: 'c.pdf', content }] }), { credentials, fetchImpl: impl }),
    ).rejects.toThrow(/did not accept the request to send draft draft-13 as noreply@example\.com/);

    // The draft is named in the error because it is what was being sent, and
    // it is taken out of the mailbox on the way past rather than left to pile
    // up behind a retry.
    expect(graphCalls(calls).some((call) => call.url.endsWith('/messages/draft-13/send'))).toBe(true);
    expect(deleteCalls(calls).map((call) => call.url)).toEqual([
      'https://graph.microsoft.com/v1.0/users/noreply%40example.com/messages/draft-13',
    ]);
  });

  it('reports a refused send by Graph error code rather than by the missing 202', async () => {
    // A 4xx still goes through assertOk first, so an operator reading the log
    // gets ErrorAccessDenied and the sender hint rather than a bare status.
    const { impl } = stubFetch([{ status: 403, body: { error: { code: 'ErrorSendAsDenied' } } }]);

    await expect(sendGraphMail(mail(), { credentials, fetchImpl: impl })).rejects.toThrow(
      /refused to send mail as noreply@example\.com \(403\): ErrorSendAsDenied/,
    );
  });

  it('asks Entra once when several sends start with a cold cache', async () => {
    const { impl, calls } = stubFetch([{ status: 202 }, { status: 202 }, { status: 202 }]);

    await Promise.all([
      sendGraphMail(mail(), { credentials, fetchImpl: impl }),
      sendGraphMail(mail(), { credentials, fetchImpl: impl }),
      sendGraphMail(mail(), { credentials, fetchImpl: impl }),
    ]);

    expect(calls.filter((call) => call.url.includes('/oauth2/v2.0/token'))).toHaveLength(1);
  });

  it('forgets a token Entra has rejected so the next send gets a new one', async () => {
    const { impl, calls } = stubFetch([
      { status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } },
      { status: 202 },
    ]);

    await expect(sendGraphMail(mail(), { credentials, fetchImpl: impl })).rejects.toThrow(/401/);

    // A token can stop working before the expiry it was issued with. Without
    // eviction every later send reuses the dead one until the local clock
    // catches up.
    await sendGraphMail(mail(), { credentials, fetchImpl: impl });

    expect(calls.filter((call) => call.url.includes('/oauth2/v2.0/token'))).toHaveLength(2);
  });
});

describe('redirects', () => {
  // Fetch follows redirects unless told otherwise, and on a cross-origin 307 or
  // 308 it drops the Authorization header and replays the POST body. The body
  // is the message. So the default hands a signing request, attachments and
  // all, to whichever host the hop names, and a 202 from that host is
  // indistinguishable here from Exchange taking the mail. Each of these tests
  // reaches the 202 if the guard is off.

  it('refuses a redirected sendMail although the hop answers 202', async () => {
    const { impl, calls } = redirectedFetch((url) => url.endsWith('/sendMail'));

    await expect(sendGraphMail(mail(), { credentials, fetchImpl: impl })).rejects.toThrow(/fetch failed/);

    expect(graphCalls(calls).map((call) => call.redirect)).toEqual(['error']);
  });

  it('refuses a redirected draft creation before any attachment goes anywhere', async () => {
    const content = Buffer.alloc(INLINE_ATTACHMENT_LIMIT_BYTES + 1, 1);
    const { impl, calls } = redirectedFetch((url) => url.endsWith('/messages'));

    await expect(
      sendGraphMail(mail({ attachments: [{ filename: 'c.pdf', content }] }), { credentials, fetchImpl: impl }),
    ).rejects.toThrow(/fetch failed/);

    // One call, and it went nowhere. A followed redirect here would have handed
    // the message over and come back with an id-less 202 body.
    expect(graphCalls(calls)).toHaveLength(1);
  });

  it('refuses a redirected draft send and takes the draft out of the mailbox', async () => {
    const content = Buffer.alloc(INLINE_ATTACHMENT_LIMIT_BYTES + 1, 1);
    const { impl, calls } = redirectedFetch(
      (url) => url.endsWith('/send'),
      [
        { body: { id: 'draft-14' } },
        { body: { uploadUrl: 'https://outlook.office.com/session' } },
        ATTACHED,
        { status: 204, body: undefined },
      ],
    );

    await expect(
      sendGraphMail(mail({ attachments: [{ filename: 'c.pdf', content }] }), { credentials, fetchImpl: impl }),
    ).rejects.toThrow(/fetch failed/);

    expect(deleteCalls(calls).map((call) => call.url)).toEqual([
      'https://graph.microsoft.com/v1.0/users/noreply%40example.com/messages/draft-14',
    ]);
  });

  it('refuses a redirect on every call it makes, including the token request', async () => {
    // The token body carries the client secret, and a 307 replays it at the
    // target as readily as it replays a contract.
    const content = Buffer.alloc(UPLOAD_CHUNK_BYTES + 11, 3);
    const attachments = [
      { filename: 'big.pdf', content },
      { filename: 'small.pdf', content: Buffer.alloc(1024, 1) },
    ];
    const { impl, calls } = stubFetch([
      { body: { id: 'draft-15' } },
      { body: { uploadUrl: 'https://outlook.office.com/session' } },
      MORE_WANTED,
      ATTACHED,
      { status: 201, body: { id: 'att-1' } },
      { status: 202 },
    ]);

    await sendGraphMail(mail({ attachments }), { credentials, fetchImpl: impl });

    expect(calls.length).toBeGreaterThan(6);
    expect(calls.every((call) => call.redirect === 'error')).toBe(true);
  });
});

describe('a draft whose send fails', () => {
  const large = { filename: 'contract.pdf', content: Buffer.alloc(INLINE_ATTACHMENT_LIMIT_BYTES + 1, 1) };

  const uploaded = (...after: Array<{ status?: number; body?: unknown; rejectsWith?: Error }>) => [
    { body: { id: 'draft-16' } },
    { body: { uploadUrl: 'https://outlook.office.com/session' } },
    ATTACHED,
    ...after,
  ];

  it('deletes the draft when Graph refuses the send', async () => {
    // The draft at this point is the finished contract. A refusal that repeats
    // would otherwise leave one complete copy in the mailbox per retry, and
    // nothing in this module ever goes back for them.
    const { impl, calls } = stubFetch(uploaded({ status: 403, body: { error: { code: 'ErrorSendAsDenied' } } }));

    await expect(sendGraphMail(mail({ attachments: [large] }), { credentials, fetchImpl: impl })).rejects.toThrow(
      /ErrorSendAsDenied/,
    );

    expect(deleteCalls(calls).map((call) => call.url)).toEqual([
      'https://graph.microsoft.com/v1.0/users/noreply%40example.com/messages/draft-16',
    ]);
  });

  it('deletes the draft when the send never answers', async () => {
    // The ambiguous one. Graph may have taken this message, and if it did, the
    // retry sends a duplicate whatever happens to the draft, so the draft goes.
    const { impl, calls } = stubFetch(
      uploaded({ rejectsWith: new DOMException('The operation was aborted', 'TimeoutError') }, { status: 204 }),
    );

    await expect(sendGraphMail(mail({ attachments: [large] }), { credentials, fetchImpl: impl })).rejects.toThrow(
      /aborted/,
    );

    expect(deleteCalls(calls)).toHaveLength(1);
  });

  it('says the draft is still there when deleting it fails too', async () => {
    const { impl } = stubFetch(uploaded({ status: 200, body: {} }, { status: 500, body: {} }));

    const failure = await sendGraphMail(mail({ attachments: [large] }), { credentials, fetchImpl: impl }).then(
      () => new Error('the send answered 200 and was treated as a success'),
      (error: Error) => error,
    );

    // Both halves. The send failure is what an operator is reading; the draft
    // is what somebody has to go and remove.
    expect(failure.message).toMatch(/did not accept the request to send draft draft-16/);
    expect(failure.message).toMatch(/Deleting draft draft-16 afterwards failed too \(Graph answered 500\)/);
    expect(failure.message).toMatch(/Drafts folder of noreply@example\.com/);
  });

  it('says the draft is still there when the delete itself never answers', async () => {
    const { impl } = stubFetch(uploaded({ status: 200, body: {} }, { rejectsWith: new TypeError('fetch failed') }));

    await expect(sendGraphMail(mail({ attachments: [large] }), { credentials, fetchImpl: impl })).rejects.toThrow(
      /failed too \(fetch failed\), so the whole message/,
    );
  });

  it('leaves the draft alone when Graph accepts the send', async () => {
    const { impl, calls } = stubFetch(uploaded({ status: 202 }));

    expect(await sendGraphMail(mail({ attachments: [large] }), { credentials, fetchImpl: impl })).toBe('draft-16');
    expect(deleteCalls(calls)).toHaveLength(0);
  });
});
