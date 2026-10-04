import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { embedEmailImages, readStaticEmailImage } from '@documenso/lib/server-only/email/embed-email-images';
import type {
  GraphAddress,
  GraphAttachment,
  GraphCredentials,
} from '@documenso/lib/server-only/email/microsoft-graph-mail';
import { sendGraphMail } from '@documenso/lib/server-only/email/microsoft-graph-mail';
import type { SentMessageInfo, Transport } from 'nodemailer';
import type { Address } from 'nodemailer/lib/mailer';
import type MailMessage from 'nodemailer/lib/mailer/mail-message';

import { normalizeMailHeaders } from './normalize-headers';

const VERSION = '1.0.0';

type NodeMailerAddress = string | Address | Array<string | Address> | undefined;

/**
 * Transport for sending through Microsoft Graph with an application permission.
 *
 * A shim only. Everything that decides what Graph is sent, including the
 * choice between a single request and an upload session for a message too
 * large for one, lives in `@documenso/lib/server-only/email/microsoft-graph-mail`
 * where the test suite reaches it.
 *
 * The mailbox sent as is the message's own `from` address, which the
 * application takes from `NEXT_PRIVATE_SMTP_FROM_ADDRESS`. Graph will refuse
 * any mailbox the registration's application access policy does not admit,
 * which is the control that keeps a tenant-wide `Mail.Send` grant from being
 * able to send as anybody.
 *
 * What the callback reports as `accepted` means Graph answered 202 and took the
 * message for delivery. Nodemailer's field is named for that, and it is the
 * same claim an SMTP 250 makes, so a caller writing an EMAIL_SENT audit entry
 * off it is on firm ground. Delivery happens afterwards, inside Exchange
 * Online, and arrives as a bounce or not at all; no return value from here
 * could have told anyone about it.
 */
export class MicrosoftGraphTransport implements Transport<SentMessageInfo> {
  public name = 'MicrosoftGraphTransport';
  public version = VERSION;

  private _credentials: GraphCredentials;
  private _sender: string | null;

  public static makeTransport(credentials: Partial<GraphCredentials> & { sender?: string | null }) {
    return new MicrosoftGraphTransport(credentials);
  }

  constructor(credentials: Partial<GraphCredentials> & { sender?: string | null }) {
    const { tenantId = '', clientId = '', clientSecret = '', sender = null } = credentials;

    this._credentials = { tenantId, clientId, clientSecret };
    this._sender = sender ? sender.trim().toLowerCase() : null;
  }

  public send(mail: MailMessage, callback: (_err: Error | null, _info: SentMessageInfo) => void) {
    const [from] = toGraphAddresses(mail.data.from);

    if (!from) {
      return callback(new Error('Missing required field "from"'), null);
    }

    // Every team on this deployment sends from the shared mailbox, and the
    // Entra application access policy admits only that one. An organisation
    // that verified its own email domain could pick a different sender, which
    // Graph would refuse. Refusing here instead means the error names the
    // setting that caused it rather than arriving as a Microsoft access
    // denial three calls later.
    if (this._sender && from.address.trim().toLowerCase() !== this._sender) {
      return callback(
        new Error(
          `Refusing to send as ${from.address}. This deployment sends only as ${this._sender}, which is the ` +
            'one mailbox the Entra application access policy admits. Clear the organisation custom sender, or ' +
            'widen the policy deliberately and set NEXT_PRIVATE_SMTP_FROM_ADDRESS to match.',
        ),
        null,
      );
    }

    const to = toGraphAddresses(mail.data.to);
    const cc = toGraphAddresses(mail.data.cc);
    const bcc = toGraphAddresses(mail.data.bcc);

    const html = mail.data.html?.toString();
    const images = html
      ? embedEmailImages(html, NEXT_PUBLIC_WEBAPP_URL(), readStaticEmailImage)
      : { html, attachments: [] };

    sendGraphMail(
      {
        from,
        to,
        cc,
        bcc,
        replyTo: toGraphAddresses(mail.data.replyTo),
        subject: mail.data.subject ?? '',
        html: images.html,
        text: mail.data.text?.toString(),
        headers: normalizeMailHeaders(mail.data.headers),
        attachments: [...toGraphAttachments(mail.data.attachments), ...images.attachments],
      },
      { credentials: this._credentials },
    )
      .then((messageId) =>
        callback(null, {
          messageId: messageId ?? '',
          envelope: { from: mail.data.from, to: mail.data.to },
          accepted: mail.data.to,
          rejected: [],
          pending: [],
        }),
      )
      .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null));
  }
}

/**
 * Convert nodemailer's several address shapes into the one Graph takes.
 */
const toGraphAddresses = (address: NodeMailerAddress): GraphAddress[] => {
  if (!address) {
    return [];
  }

  const one = (value: string | Address): GraphAddress =>
    typeof value === 'string' ? { address: value } : { address: value.address, name: value.name };

  return Array.isArray(address) ? address.map(one) : [one(address)];
};

/**
 * Convert nodemailer attachments into the shape the Graph client takes.
 *
 * Documenso attaches the signed PDF as a Buffer, which is the only form this
 * handles. A stream or a path would arrive here as something Graph cannot be
 * given a size for, and an attachment silently dropped from a completion email
 * is worse than a send that fails, so anything else throws.
 */
const toGraphAttachments = (attachments: MailMessage['data']['attachments']): GraphAttachment[] => {
  if (!attachments?.length) {
    return [];
  }

  return attachments.map((attachment, index) => {
    const { content, filename, contentType } = attachment;

    if (!Buffer.isBuffer(content) && typeof content !== 'string') {
      throw new Error(
        `Attachment ${index} (${String(filename ?? 'unnamed')}) is not a buffer or a string, which this transport cannot send`,
      );
    }

    return {
      filename: typeof filename === 'string' ? filename : `attachment-${index + 1}`,
      content: Buffer.isBuffer(content) ? content : Buffer.from(content),
      contentType: typeof contentType === 'string' ? contentType : undefined,
    };
  });
};
