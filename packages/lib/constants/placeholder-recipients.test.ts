import type { Recipient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { findRecipientByPlaceholder } from '../server-only/pdf/helpers';
import { generateAvaliableRecipientPlaceholder, generateRecipientPlaceholder } from '../utils/templates';
import {
  DIRECT_TEMPLATE_RECIPIENT_EMAIL,
  isDirectTemplateRecipientEmail,
  LEGACY_DIRECT_TEMPLATE_RECIPIENT_EMAIL,
} from './direct-templates';
import { isTemplateRecipientEmailPlaceholder } from './placeholder-recipients';

// The PDF helpers load the native canvas module, which this matching logic never touches.
vi.mock('@documenso/skia-canvas', () => ({ FontLibrary: {} }));

const recipientsWithEmails = (...emails: string[]) => {
  return emails.map((email, index) => ({ id: index + 1, email }) as Recipient);
};

describe('placeholder recipient emails', () => {
  it('writes new placeholders on the undeliverable .invalid domain', () => {
    expect(generateRecipientPlaceholder(3)).toEqual({
      name: 'Recipient 3',
      email: 'recipient.3@placeholder.invalid',
    });
  });

  it('recognises both the new and the legacy Documenso placeholder', () => {
    expect(isTemplateRecipientEmailPlaceholder('recipient.1@placeholder.invalid')).toBe(true);
    expect(isTemplateRecipientEmailPlaceholder('recipient.1@documenso.com')).toBe(true);
    expect(isTemplateRecipientEmailPlaceholder('Recipient.12@Documenso.com')).toBe(true);
    expect(isTemplateRecipientEmailPlaceholder('jane@terrapay.com')).toBe(false);
  });

  it('does not reuse an index already held by a legacy placeholder', () => {
    const existing = recipientsWithEmails('recipient.1@documenso.com');

    expect(generateAvaliableRecipientPlaceholder(existing).email).toBe('recipient.2@placeholder.invalid');
  });

  it('matches a PDF placeholder reference to a placeholder recipient in either form', () => {
    const recipients = recipientsWithEmails('recipient.1@documenso.com', 'recipient.2@placeholder.invalid');

    expect(findRecipientByPlaceholder('r1', '{{signature,r1}}', undefined, recipients).id).toBe(1);
    expect(findRecipientByPlaceholder('r2', '{{signature,r2}}', undefined, recipients).id).toBe(2);
    expect(() => findRecipientByPlaceholder('r3', '{{signature,r3}}', undefined, recipients)).toThrow();
  });
});

describe('direct template recipient email', () => {
  it('writes the new .invalid address', () => {
    expect(DIRECT_TEMPLATE_RECIPIENT_EMAIL).toBe('direct.link@placeholder.invalid');
  });

  it('recognises the new address and the legacy address still stored on old templates', () => {
    expect(isDirectTemplateRecipientEmail(DIRECT_TEMPLATE_RECIPIENT_EMAIL)).toBe(true);
    expect(isDirectTemplateRecipientEmail(LEGACY_DIRECT_TEMPLATE_RECIPIENT_EMAIL)).toBe(true);
    expect(isDirectTemplateRecipientEmail('Direct.Link@Documenso.com')).toBe(true);
    expect(isDirectTemplateRecipientEmail('signer@terrapay.com')).toBe(false);
  });
});
