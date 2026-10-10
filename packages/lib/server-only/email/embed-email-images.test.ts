import { describe, expect, it } from 'vitest';

import { embedEmailImages } from './embed-email-images';
import { buildGraphMessage } from './microsoft-graph-mail';

const BASE = 'https://sign.example.com';
const png = (name: string) => Buffer.from(`png:${name}`);
const files = (name: string) => (['logo.png', 'completed.png', 'download.png'].includes(name) ? png(name) : null);

describe('embedEmailImages', () => {
  it('sends a completion notice with its images inside it and no remote image left', () => {
    const html =
      `<img src="${BASE}/static/logo.png" alt="TerraPay">` +
      `<img alt="" src="${BASE}/static/completed.png"/>` +
      `<img src='${BASE}/static/download.png'>` +
      `<img src="${BASE}/static/logo.png" alt="again">`;

    const result = embedEmailImages(html, `${BASE}/`, files);

    expect(result.html).not.toContain(BASE);
    expect(result.html).toBe(
      '<img src="cid:logo.png" alt="TerraPay"><img alt="" src="cid:completed.png"/>' +
        '<img src=\'cid:download.png\'><img src="cid:logo.png" alt="again">',
    );
    expect(result.attachments).toEqual([
      { filename: 'logo.png', content: png('logo.png'), contentType: 'image/png', contentId: 'logo.png' },
      {
        filename: 'completed.png',
        content: png('completed.png'),
        contentType: 'image/png',
        contentId: 'completed.png',
      },
      { filename: 'download.png', content: png('download.png'), contentType: 'image/png', contentId: 'download.png' },
    ]);
  });

  it('leaves other hosts, odd names and missing files where they point', () => {
    const html =
      '<img src="https://cdn.example.com/static/logo.png">' +
      `<img src="${BASE}/static/../secret.png">` +
      `<img src="${BASE}/api/branding/logo">` +
      `<img src="${BASE}/static/clock.png">`;

    const result = embedEmailImages(html, BASE, files);

    expect(result.html).toBe(html);
    expect(result.attachments).toEqual([]);
  });

  it('marks embedded images inline for Graph and leaves the signed PDF an ordinary attachment', () => {
    const { attachments } = embedEmailImages(`<img src="${BASE}/static/logo.png">`, BASE, files);

    const message = buildGraphMessage(
      {
        from: { address: 'noreply@example.com' },
        to: [{ address: 'signer@example.com' }],
        subject: 'Signing Complete!',
        html: '<img src="cid:logo.png">',
        attachments: [
          { filename: 'contract.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' },
          ...attachments,
        ],
      },
      { inlineAttachments: true },
    );

    expect(message.attachments).toEqual([
      expect.not.objectContaining({ isInline: true }),
      expect.objectContaining({ name: 'logo.png', isInline: true, contentId: 'logo.png' }),
    ]);
  });
});
