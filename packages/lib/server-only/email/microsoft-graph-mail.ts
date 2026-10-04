/**
 * Sending mail through Microsoft Graph with an application permission.
 *
 * This exists because of a deadline rather than a preference. The deployment
 * sends through `smtp.office365.com` with a username and password, and
 * Microsoft turns off basic authentication for SMTP AUTH at the end of
 * December 2026. That path carries signing invitations and completion notices,
 * so losing it does not degrade reporting, it stops the product working.
 * Graph app-only sending is unaffected, needs no licensed mailbox, and can be
 * confined to a single mailbox by an application access policy in Entra.
 *
 * The logic lives here rather than in `@documenso/email` so that it is covered
 * by the existing test suite: packages/lib already runs vitest, and the
 * nodemailer side is a thin shim over what this exports.
 *
 * ## Why there are two ways to send
 *
 * `POST /users/{mailbox}/sendMail` takes the whole message, attachments
 * included, as one request body, and Graph caps that body at 4 MB. The
 * completion email attaches the signed PDF, and a real signed contract runs
 * well past that: the DocuSign contract this fork was tested against is
 * 5.4 MB on its own. Sending that through the simple path fails, and it fails
 * on exactly the documents that matter most.
 *
 * So a message that does not fit is created as a draft, each attachment is
 * uploaded through an upload session, and the draft is then sent. Three calls
 * instead of one, which is why it is not the only path: reminders and
 * invitations carry no attachment and should not pay for it.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';

/**
 * Largest attachment Graph will accept inline on a message.
 *
 * Microsoft documents 3 MB as the ceiling for a `fileAttachment` sent this
 * way. Anything at or above it has to go through an upload session.
 */
export const INLINE_ATTACHMENT_LIMIT_BYTES = 3 * 1024 * 1024;

/**
 * Largest whole request `sendMail` will accept.
 *
 * Held below Graph's 4 MB so that the headers, the HTML body and base64
 * expansion cannot push a message that looked small enough over the edge.
 */
export const INLINE_MESSAGE_LIMIT_BYTES = 3 * 1024 * 1024;

/**
 * Upload session chunk size. Graph requires every chunk except the last to be
 * a multiple of 320 KiB, so this is that unit times ten rather than a round
 * number of megabytes.
 */
export const UPLOAD_CHUNK_BYTES = 320 * 1024 * 10;

/** Renew a token this long before it actually expires. */
const TOKEN_MARGIN_SECONDS = 60;

/**
 * Ceiling on every Graph request.
 *
 * Without one a request that never settles leaves the job neither succeeded
 * nor failed. The worker lock then expires, another run starts, and the first
 * request may still be in flight, which is how one completion email becomes
 * two. Chunk uploads get longer because they carry megabytes.
 */
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Longer, and deliberately so, on the two calls that actually send.
 *
 * `/sendMail` and `/messages/{id}/send` are not idempotent and Graph offers no
 * idempotency key for them. If one is accepted and the answer is lost, this
 * transport reports failure, the job retries, and the recipient gets the mail
 * twice. A timeout is still wanted, because a request that never settles is
 * worse, but it is set far above any plausible healthy latency so that it
 * fires on a genuinely dead connection rather than on a slow one.
 *
 * The residual risk is the same shape as the completion fan-out, which is not
 * idempotent either. Closing it properly means recording the Graph message id
 * before sending and checking on retry whether that draft has already left the
 * Drafts folder, which is a larger change than this one.
 */
const SEND_TIMEOUT_MS = 120_000;

/**
 * Hosts Graph is allowed to hand us an upload URL on.
 *
 * The URL is opaque and pre-authenticated, and we PUT signed contract bytes to
 * it, so a malformed or tampered response must not be able to point that at an
 * arbitrary address. Microsoft documents the large-attachment upload URL as
 * HTTPS on Outlook's service hosts.
 */
const UPLOAD_HOSTS = ['outlook.office.com', 'outlook.office365.com'];

/**
 * What every request in this file does with a redirect, which is refuse it.
 *
 * Entra and Graph answer these endpoints with the result. A 3xx is not an
 * answer either of them gives, so one arriving means something between this
 * process and Exchange took the request: the egress proxy the deployment
 * leaves through, or a name that now resolves somewhere it did not.
 *
 * Fetch follows redirects by default, and the WHATWG algorithm strips the
 * Authorization header on a cross-origin hop while replaying the POST body on
 * a 307 or 308. The body is the message: recipients, subject, and on the
 * simple path the attachments too. So the default hands a signing request, or
 * a signed contract, to whatever host the hop names, and if that host answers
 * 202 then `assertAccepted` writes down a send that Exchange never saw. A 301,
 * 302 or 303 turns the POST into a GET and drops the body, which reaches the
 * same place by a different road: a final status describing a message nobody
 * sent. Only the caller can tell those apart from the real thing, and the
 * caller sees one response, the last one.
 *
 * Refusing costs nothing in a healthy deployment and turns a redirect into a
 * network error the job framework retries, which is what a request that never
 * reached Graph deserves.
 */
const REFUSE_REDIRECT = 'error' as const;

/**
 * Said on a 403 from either send path, because the likeliest cause is not a
 * missing permission.
 *
 * An organisation that has verified an email domain can pick its own sender
 * address, and `getEmailContext` then hands that address to whichever transport
 * the environment provides. Graph sends as `/users/{that address}`, and the
 * Entra application access policy admits one mailbox, so it refuses. The
 * refusal is correct; what was missing was any way to tell it apart from a
 * permission problem while reading a log.
 */
const SENDER_HINT =
  'If this address is an organisation custom sender rather than the configured mailbox, the Entra ' +
  'application access policy on this registration will refuse it. The policy is the control, so widen ' +
  'it deliberately or clear the custom sender; do not work around it in the application.';

export type GraphCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

export type GraphAddress = {
  address: string;
  name?: string;
};

export type GraphAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
  /** Set on an image the HTML shows through `cid:`, which Graph then sends inline. */
  contentId?: string;
};

export type GraphMailInput = {
  from: GraphAddress;
  to: GraphAddress[];
  cc?: GraphAddress[];
  bcc?: GraphAddress[];
  replyTo?: GraphAddress[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: GraphAttachment[];
};

type Fetch = typeof fetch;

export type GraphMailOptions = {
  credentials: GraphCredentials;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: Fetch;
  /** Whether Graph keeps a copy in the mailbox's Sent Items. */
  saveToSentItems?: boolean;
};

type CachedToken = { accessToken: string; expiresAt: number };

const tokens = new Map<string, CachedToken>();

/**
 * Token requests in flight, so that a cold start under load asks Entra once
 * rather than once per queued mail.
 */
const inFlight = new Map<string, Promise<string>>();

/** Empties the token cache. Tests use it; nothing else needs to. */
export const resetGraphTokenCache = (): void => {
  tokens.clear();
  inFlight.clear();
};

const cacheKey = (credentials: GraphCredentials) => `${credentials.tenantId}:${credentials.clientId}`;

/**
 * A client credentials token for the tenant, from the cache when one is still
 * good.
 *
 * @throws {Error} When the token endpoint refuses. The message carries the
 *   status and Entra's error code, which is the difference between a wrong
 *   secret and a missing permission, and never the secret itself.
 */
export const getGraphToken = async (credentials: GraphCredentials, fetchImpl: Fetch = fetch): Promise<string> => {
  const key = cacheKey(credentials);
  const cached = tokens.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  const pending = inFlight.get(key);

  if (pending) {
    return await pending;
  }

  const request = requestToken(credentials, fetchImpl, key).finally(() => inFlight.delete(key));

  inFlight.set(key, request);

  return await request;
};

/**
 * Forget a token Entra has since rejected.
 *
 * A token can stop working before the expiry it was issued with, and without
 * this every later send fails until the local clock catches up.
 */
const evictGraphToken = (credentials: GraphCredentials, token: string): void => {
  const key = cacheKey(credentials);

  if (tokens.get(key)?.accessToken === token) {
    tokens.delete(key);
  }
};

const requestToken = async (credentials: GraphCredentials, fetchImpl: Fetch, key: string): Promise<string> => {
  const response = await fetchImpl(`${LOGIN}/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }).toString(),
    // The body carries the client secret, and a 307 or 308 replays it at the
    // redirect target.
    redirect: REFUSE_REDIRECT,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`Microsoft Graph refused the token request (${response.status}): ${describeError(body)}`);
  }

  const { access_token: accessToken, expires_in: expiresIn } = (body ?? {}) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!accessToken) {
    throw new Error('Microsoft Graph returned a token response with no access_token');
  }

  tokens.set(key, {
    accessToken,
    expiresAt: Date.now() + Math.max(0, (expiresIn ?? 3600) - TOKEN_MARGIN_SECONDS) * 1000,
  });

  return accessToken;
};

/**
 * Turn a mail into the Graph message shape.
 *
 * Attachments are included only when `inlineAttachments` is true. The large
 * path creates the draft without them and uploads each one afterwards.
 */
export const buildGraphMessage = (
  mail: GraphMailInput,
  { inlineAttachments }: { inlineAttachments: boolean },
): Record<string, unknown> => {
  const recipients = (addresses: GraphAddress[] | undefined) =>
    (addresses ?? []).map((address) => ({
      emailAddress: { address: address.address, ...(address.name ? { name: address.name } : {}) },
    }));

  // Graph carries one body. Documenso renders both, and the HTML is the one
  // recipients are meant to see; the text part exists for clients that cannot
  // show it, which Graph has no field for.
  const body = mail.html
    ? { contentType: 'HTML', content: mail.html }
    : { contentType: 'Text', content: mail.text ?? '' };

  const headers = Object.entries(mail.headers ?? {});

  return {
    subject: mail.subject,
    body,
    from: { emailAddress: { address: mail.from.address, ...(mail.from.name ? { name: mail.from.name } : {}) } },
    toRecipients: recipients(mail.to),
    ...(mail.cc?.length ? { ccRecipients: recipients(mail.cc) } : {}),
    ...(mail.bcc?.length ? { bccRecipients: recipients(mail.bcc) } : {}),
    ...(mail.replyTo?.length ? { replyTo: recipients(mail.replyTo) } : {}),
    // Graph rejects anything not prefixed x-, so the rest are dropped rather
    // than failing the send over a header nobody reads.
    ...(headers.length
      ? {
          internetMessageHeaders: headers
            .filter(([name]) => name.toLowerCase().startsWith('x-'))
            .map(([name, value]) => ({ name, value })),
        }
      : {}),
    ...(inlineAttachments && mail.attachments?.length
      ? {
          attachments: mail.attachments.map((attachment) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: attachment.filename,
            contentType: attachment.contentType ?? 'application/octet-stream',
            contentBytes: attachment.content.toString('base64'),
            ...inline(attachment),
          })),
        }
      : {}),
  };
};

const inline = (attachment: GraphAttachment) =>
  attachment.contentId ? { isInline: true, contentId: attachment.contentId } : {};

/**
 * Whether the message is small enough to send in a single request.
 *
 * Judged on the base64 size the attachments will become rather than their size
 * on disk, because that is what travels.
 */
export const fitsInOneRequest = (mail: GraphMailInput): boolean => {
  const attachments = mail.attachments ?? [];

  if (attachments.some((attachment) => attachment.content.length >= INLINE_ATTACHMENT_LIMIT_BYTES)) {
    return false;
  }

  const attachmentBytes = attachments.reduce((total, attachment) => total + base64Length(attachment.content.length), 0);
  const bodyBytes = Buffer.byteLength(mail.html ?? mail.text ?? '', 'utf8');

  return attachmentBytes + bodyBytes < INLINE_MESSAGE_LIMIT_BYTES;
};

/**
 * Send a mail as the `from` mailbox.
 *
 * The application must hold `Mail.Send` and, if an application access policy
 * is in place, that policy must admit this mailbox. Both failures come back
 * from Graph as an authorisation error naming the mailbox.
 *
 * Returning normally means Graph answered 202 and took the message for
 * delivery, which is as much as any client can know at this point. Microsoft
 * says so in the reference: a 202 records acceptance, and the processing behind
 * it has not finished, with Exchange Online limits and throttling still to
 * come. A caller that writes this down as sent is writing down an acceptance,
 * on the same footing as an SMTP 250, and a later bounce is a separate event
 * that no return value here could have carried.
 *
 * @returns The Graph message id on the upload path, or null on the simple one,
 *   which returns no identifier.
 */
export const sendGraphMail = async (
  mail: GraphMailInput,
  { credentials, fetchImpl = fetch, saveToSentItems = false }: GraphMailOptions,
): Promise<string | null> => {
  if (!mail.to.length && !mail.cc?.length && !mail.bcc?.length) {
    throw new Error('Refusing to send a message with no recipients');
  }

  const token = await getGraphToken(credentials, fetchImpl);
  const mailbox = encodeURIComponent(mail.from.address);
  const authorised = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const unauthorised = (response: Response) => {
    if (response.status === 401) {
      evictGraphToken(credentials, token);
    }
  };

  if (fitsInOneRequest(mail)) {
    const attempted = `send mail as ${mail.from.address}`;
    const response = await fetchImpl(`${GRAPH}/users/${mailbox}/sendMail`, {
      method: 'POST',
      headers: authorised,
      body: JSON.stringify({ message: buildGraphMessage(mail, { inlineAttachments: true }), saveToSentItems }),
      redirect: REFUSE_REDIRECT,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    unauthorised(response);
    await assertOk(response, attempted, SENDER_HINT);
    assertAccepted(response, attempted);

    return null;
  }

  // Too big for one request. Create it as a draft, put the attachments on it,
  // then send it. A draft left behind by a failure part way through the
  // attachments is deliberate: it is incomplete, it is evidence of which
  // attachment Graph would not confirm, and it is in the mailbox rather than
  // lost. A draft whose send failed is a different thing and is deleted below.
  const draftResponse = await fetchImpl(`${GRAPH}/users/${mailbox}/messages`, {
    method: 'POST',
    headers: authorised,
    body: JSON.stringify(buildGraphMessage(mail, { inlineAttachments: false })),
    redirect: REFUSE_REDIRECT,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  unauthorised(draftResponse);

  const draft = await assertOk(
    draftResponse,
    `create a draft as ${mail.from.address}`,
    // Verified against the tenant on 15 September 2026: with Mail.Send alone
    // this call returns 403 ErrorAccessDenied, which says nothing about why.
    // Sending needs Mail.Send; creating the draft that carries a large
    // attachment needs Mail.ReadWrite as well.
    'Creating a draft needs the Mail.ReadWrite application permission, which is separate from ' +
      'Mail.Send. Check that it is granted, and that any Exchange application access policy on ' +
      'this registration admits the mailbox.',
  );
  const messageId = (draft as { id?: string } | null)?.id;

  if (!messageId) {
    throw new Error('Microsoft Graph created a draft with no id');
  }

  // Each attachment picks its own route by its own size, not by whether the
  // message as a whole fitted. Graph refuses an upload session for anything
  // under the inline ceiling with ErrorAttachmentSizeShouldNotBeLessThanMinimumSize,
  // so sending three 1 MB documents down the session path, which is what
  // judging them collectively did, fails every one of them.
  for (const attachment of mail.attachments ?? []) {
    if (attachment.content.length < INLINE_ATTACHMENT_LIMIT_BYTES) {
      await addSmallAttachment({ mailbox, messageId, attachment, headers: authorised, fetchImpl, unauthorised });
    } else {
      await uploadAttachment({ mailbox, messageId, attachment, headers: authorised, fetchImpl, unauthorised });
    }
  }

  const attempted = `send draft ${messageId} as ${mail.from.address}`;

  try {
    const sendResponse = await fetchImpl(`${GRAPH}/users/${mailbox}/messages/${messageId}/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      redirect: REFUSE_REDIRECT,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    unauthorised(sendResponse);
    await assertOk(sendResponse, attempted, SENDER_HINT);
    assertAccepted(sendResponse, attempted);
  } catch (failure) {
    await discardDraft({
      mailbox,
      messageId,
      headers: { authorization: `Bearer ${token}` },
      fetchImpl,
      unauthorised,
      failure,
    });
  }

  return messageId;
};

/**
 * Delete a draft whose send did not go through, then rethrow.
 *
 * By this point the draft is the finished message with every attachment on it,
 * so leaving it puts a signed contract in a mailbox that other people can
 * open. Worse, the module keeps no state: a queued retry starts again at draft
 * creation, so a refusal that repeats leaves one full copy of the contract per
 * attempt and nothing ever collects them.
 *
 * ## The ambiguous send, and which way this fails
 *
 * A timeout, or a status this transport will not read as acceptance, can sit
 * on top of a send Graph did take. That message has already left and no delete
 * recalls it. The retry then puts out a duplicate whether this draft survives
 * or not, since nothing here remembers an id across attempts, and giving the
 * module state to remember one is a bigger change than this.
 *
 * So the real choice is between a duplicate with a clean mailbox and a
 * duplicate with a pile of contracts behind it, and it is made in favour of
 * the clean mailbox. Somebody who receives a signing request twice says so,
 * and that is the failure a person can see and correct.
 *
 * A 404 on the delete carries information rather than a problem: the message
 * is no longer in Drafts, which is what an accepted send looks like from here.
 *
 * @throws Always: the original failure when the draft is gone, or an error
 *   naming both that failure and the draft still sitting in the mailbox.
 */
const discardDraft = async ({
  mailbox,
  messageId,
  headers,
  fetchImpl,
  unauthorised,
  failure,
}: {
  mailbox: string;
  messageId: string;
  headers: Record<string, string>;
  fetchImpl: Fetch;
  unauthorised: (response: Response) => void;
  failure: unknown;
}): Promise<never> => {
  let response: Response;

  try {
    response = await fetchImpl(`${GRAPH}/users/${mailbox}/messages/${messageId}`, {
      method: 'DELETE',
      headers,
      redirect: REFUSE_REDIRECT,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw draftLeftBehind(failure, mailbox, messageId, error instanceof Error ? error.message : String(error));
  }

  unauthorised(response);

  if (!response.ok) {
    throw draftLeftBehind(failure, mailbox, messageId, `Graph answered ${response.status}`);
  }

  throw failure;
};

/**
 * Say that the cleanup failed as well as the send.
 *
 * Both halves belong in one message. The send failure is what the operator is
 * looking at; the draft is what somebody has to go and remove, and a cleanup
 * that fails quietly is how it would be missed.
 */
const draftLeftBehind = (failure: unknown, mailbox: string, messageId: string, detail: string): Error => {
  const reason = failure instanceof Error ? failure.message : String(failure);

  return new Error(
    `${reason.endsWith('.') ? reason : `${reason}.`} Deleting draft ${messageId} afterwards failed too ` +
      `(${detail}), so the whole message, attachments and all, is still in the Drafts folder of ` +
      `${decodeURIComponent(mailbox)} and has to be removed by hand.`,
    { cause: failure },
  );
};

/**
 * Put an attachment small enough to go inline onto an existing draft.
 *
 * Used on the draft path for anything below the upload-session minimum, which
 * Graph will not open a session for at all.
 */
const addSmallAttachment = async ({
  mailbox,
  messageId,
  attachment,
  headers,
  fetchImpl,
  unauthorised,
}: {
  mailbox: string;
  messageId: string;
  attachment: GraphAttachment;
  headers: Record<string, string>;
  fetchImpl: Fetch;
  unauthorised: (response: Response) => void;
}): Promise<void> => {
  const response = await fetchImpl(`${GRAPH}/users/${mailbox}/messages/${messageId}/attachments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: attachment.filename,
      contentType: attachment.contentType ?? 'application/octet-stream',
      contentBytes: attachment.content.toString('base64'),
      ...inline(attachment),
    }),
    redirect: REFUSE_REDIRECT,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  unauthorised(response);

  const created = await assertOk(response, `attach ${attachment.filename}`);

  // Same rule as the upload-session path: a 2xx is not proof. Graph returns the
  // attachment it made, with an id. Anything else and the draft must not be
  // sent, or a completion email goes out without the contract on it.
  if (response.status !== 201 || typeof (created as { id?: unknown } | null)?.id !== 'string') {
    throw new Error(
      `Microsoft Graph did not confirm ${attachment.filename} was attached: expected 201 with the created ` +
        `attachment, got ${response.status}. The message must not be sent without it.`,
    );
  }
};

/**
 * Put one large attachment on a draft through an upload session.
 *
 * Only for attachments at or above the inline ceiling. Graph refuses to open a
 * session for anything smaller.
 *
 * The completion check is the point of this function. Microsoft's protocol
 * answers an incomplete upload with `200` and a `nextExpectedRanges` list, and
 * answers the final chunk with `201 Created` plus a `Location` naming the
 * attachment it made. Treating any 2xx as success means a run that ends on a
 * `200` exits the loop on its own local cursor, the caller posts `/send`, and
 * the recipient receives a completion email with no contract on it while the
 * audit log records a successful send. So the last response has to prove the
 * attachment exists, and an early response has to prove Graph wants more.
 */
const uploadAttachment = async ({
  mailbox,
  messageId,
  attachment,
  headers,
  fetchImpl,
  unauthorised,
}: {
  mailbox: string;
  messageId: string;
  attachment: GraphAttachment;
  headers: Record<string, string>;
  fetchImpl: Fetch;
  unauthorised: (response: Response) => void;
}): Promise<void> => {
  const sessionResponse = await fetchImpl(
    `${GRAPH}/users/${mailbox}/messages/${messageId}/attachments/createUploadSession`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        AttachmentItem: {
          attachmentType: 'file',
          name: attachment.filename,
          size: attachment.content.length,
          contentType: attachment.contentType ?? 'application/octet-stream',
        },
      }),
      redirect: REFUSE_REDIRECT,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  unauthorised(sessionResponse);

  const session = await assertOk(sessionResponse, `open an upload session for ${attachment.filename}`);
  const uploadUrl = (session as { uploadUrl?: string } | null)?.uploadUrl;

  if (!uploadUrl) {
    throw new Error(`Microsoft Graph opened an upload session for ${attachment.filename} with no uploadUrl`);
  }

  assertUploadUrlIsMicrosoft(uploadUrl, attachment.filename);

  const total = attachment.content.length;
  let completed = false;

  for (let start = 0; start < total; start += UPLOAD_CHUNK_BYTES) {
    const end = Math.min(start + UPLOAD_CHUNK_BYTES, total) - 1;
    const chunk = attachment.content.subarray(start, end + 1);
    const isFinal = end === total - 1;

    // The upload URL carries its own authorisation, so the bearer token is
    // deliberately not sent here.
    const response = await fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(chunk.length),
        'content-range': `bytes ${start}-${end}/${total}`,
      },
      body: new Uint8Array(chunk),
      // On top of the reason every other call refuses one: this origin was
      // checked once, before the first byte, and a redirect would send the
      // rest of the contract somewhere that was never checked.
      redirect: REFUSE_REDIRECT,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Microsoft Graph rejected bytes ${start}-${end} of ${attachment.filename} (${response.status})`);
    }

    const body: unknown = await response.json().catch(() => null);

    if (isFinal) {
      // Both, not either. Microsoft documents the completion answer as 201
      // Created carrying a Location for the attachment it made. A 200 with a
      // Location, or a 201 without one, is not that answer, and treating
      // either as success is how the original defect sent a draft with no
      // contract on it.
      const location = response.headers.get('location');

      if (response.status !== 201 || !location) {
        throw new Error(
          `Microsoft Graph did not confirm ${attachment.filename} was attached: the last chunk returned ` +
            `${response.status}${location ? ' with' : ' without'} a Location, rather than 201 with one. ` +
            'The upload is incomplete and the message must not be sent without it.',
        );
      }

      completed = true;
    } else if (!hasNextExpectedRange(body)) {
      throw new Error(
        `Microsoft Graph did not ask for more of ${attachment.filename} after bytes ${start}-${end}. ` +
          'The upload cannot be continued safely.',
      );
    }
  }

  if (!completed) {
    throw new Error(`Upload of ${attachment.filename} ended without Graph confirming the attachment`);
  }
};

/**
 * Whether Graph asked for more bytes, which is how it acknowledges a chunk
 * that is not the last one.
 */
const hasNextExpectedRange = (body: unknown): boolean => {
  if (!body || typeof body !== 'object') {
    return false;
  }

  const { nextExpectedRanges: ranges } = body as { nextExpectedRanges?: unknown };

  return Array.isArray(ranges) && ranges.length > 0;
};

/**
 * Refuse an upload URL that does not belong to Microsoft.
 *
 * The URL is opaque and pre-authenticated and we send signed contract bytes to
 * it, so a malformed or tampered session response must not be able to redirect
 * those bytes somewhere else, including somewhere inside our own network.
 */
const assertUploadUrlIsMicrosoft = (uploadUrl: string, filename: string): void => {
  let url: URL;

  try {
    url = new URL(uploadUrl);
  } catch {
    throw new Error(`Microsoft Graph returned an unparseable upload URL for ${filename}`);
  }

  // Exact hosts, not suffixes, and no port. Microsoft documents the upload URL
  // as HTTPS on Outlook's service host; anything broader trusts more of the
  // internet than the protocol requires, and a port would let an allowed name
  // reach an unexpected listener.
  const trusted = url.protocol === 'https:' && url.port === '' && UPLOAD_HOSTS.includes(url.hostname);

  if (!trusted) {
    throw new Error(
      `Refusing to upload ${filename} to ${url.protocol}//${url.host}, which is not a Microsoft upload host`,
    );
  }
};

/**
 * Insist on the one answer Graph documents for the two calls that send.
 *
 * Microsoft specifies `202 Accepted` with an empty body for both
 * `/sendMail` and `/messages/{id}/send`, and notes that the 202 means the
 * message was taken for delivery rather than delivered. That is the signal this
 * transport wants, and it is worth having exactly.
 *
 * `assertOk` passes the whole 2xx band, and behind it on these two calls there
 * was nothing else looking. The attachment steps can insist on the created
 * attachment because Graph hands one back. A send returns no body, so the
 * status is the entirety of the evidence, and reading it loosely means any 200
 * from anything counts as a message going out. Traffic from this deployment
 * leaves through a proxy, and a proxy that declines a POST answers with a page
 * and a status of its own choosing.
 *
 * Strictness is not free here. If Graph ever answered an accepted send with
 * some other 2xx, this throws, the job retries and the recipient reads the same
 * signing request twice. The long timeouts above already take on that shape of
 * risk, because a duplicate email gets reported by whoever receives it, whereas
 * a signing request the audit log calls sent leaves no trace for anyone to
 * follow.
 *
 * @throws {Error} When the status is anything other than 202.
 */
const assertAccepted = (response: Response, attempted: string): void => {
  if (response.status !== 202) {
    throw new Error(
      `Microsoft Graph did not accept the request to ${attempted}: expected 202 Accepted, got ` +
        `${response.status}. Nothing here proves the message was taken for delivery, so treat it as unsent.`,
    );
  }
};

/**
 * @throws {Error} Naming what was attempted, the status, and Graph's own error
 *   code, which is what distinguishes a missing permission from a mailbox the
 *   application access policy does not admit.
 */
const assertOk = async (response: Response, attempted: string, hint?: string): Promise<unknown> => {
  if (response.ok) {
    return response.status === 204 ? null : await response.json().catch(() => null);
  }

  const body: unknown = await response.json().catch(() => null);
  const because = hint && response.status === 403 ? ` ${hint}` : '';

  throw new Error(`Microsoft Graph refused to ${attempted} (${response.status}): ${describeError(body)}.${because}`);
};

/**
 * Name the failure without repeating anything the provider sent us.
 *
 * Entra and Graph put request context into `error_description` and
 * `error.message`, and that has been observed to include submitted parameters
 * and headers. Those strings are copied into a thrown Error, which Nodemailer
 * and the job framework then log, so echoing them risks putting the client
 * secret or a pre-authenticated upload URL in the logs. Only the error *code*
 * is reported, and only when it looks like a code rather than prose: the code
 * is what distinguishes a wrong secret from a missing permission, and it is a
 * short identifier from a fixed vocabulary.
 *
 * The repository's other Graph client avoids response bodies entirely for the
 * same reason. See packages/lib/server-only/microsoft-graph/graph-auth.ts.
 */
const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

const describeError = (body: unknown): string => {
  if (!body || typeof body !== 'object') {
    return 'no error code returned';
  }

  const { error } = body as { error?: unknown };

  const code =
    typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null
        ? (error as { code?: unknown }).code
        : undefined;

  if (typeof code !== 'string' || !CODE_SHAPE.test(code)) {
    return 'no error code returned';
  }

  return code;
};

/** How many bytes a buffer of this length becomes once base64 encoded. */
const base64Length = (bytes: number): number => 4 * Math.ceil(bytes / 3);
