import fs from 'node:fs';
import path from 'node:path';

import type { GraphAttachment } from './microsoft-graph-mail';

/**
 * Carry the email templates' own images inside the message.
 *
 * The templates point their logo, illustration and icons at
 * `{NEXT_PUBLIC_WEBAPP_URL}/static/*.png`. Outlook blocks remote images until
 * the reader asks for them, so every notice arrived as empty boxes with alt
 * text, and an outside signer has no reason to trust the sender enough to
 * click. An inline attachment referenced by `cid:` is part of the message and
 * shows without asking.
 *
 * Only images under the app's own `/static/` with a plain file name are taken.
 * Anything else, such as an organisation's uploaded logo, keeps its address,
 * and so does an image the reader cannot find, so a missing file costs a
 * picture rather than the send.
 *
 * @param html - the rendered body
 * @param baseUrl - the app's public URL, which the templates built the addresses from
 * @param readImage - returns the file for a name such as `logo.png`, or null
 * @returns the body with each embedded image pointed at its attachment, and the attachments
 */
export const embedEmailImages = (
  html: string,
  baseUrl: string,
  readImage: (name: string) => Buffer | null,
): { html: string; attachments: GraphAttachment[] } => {
  const prefix = `${baseUrl.replace(/\/$/, '')}/static/`;
  const attachments = new Map<string, GraphAttachment>();

  const rewritten = html.replace(
    /(<img\b[^>]*?\bsrc=)(["'])([^"']*)\2/gi,
    (match, head: string, quote: string, src: string) => {
      if (!src.startsWith(prefix)) {
        return match;
      }

      const name = src.slice(prefix.length);

      if (!/^[a-z0-9-]+\.png$/.test(name)) {
        return match;
      }

      if (!attachments.has(name)) {
        const content = readImage(name);

        if (!content) {
          return match;
        }

        attachments.set(name, { filename: name, content, contentType: 'image/png', contentId: name });
      }

      return `${head}${quote}cid:${name}${quote}`;
    },
  );

  return { html: rewritten, attachments: [...attachments.values()] };
};

/**
 * Read an email image from the app's `public/static`, where the server's
 * working directory puts it in the image and in development alike.
 */
export const readStaticEmailImage = (name: string): Buffer | null => {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'public/static', name));
  } catch {
    return null;
  }
};
