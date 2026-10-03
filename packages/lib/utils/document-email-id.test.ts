import type { OrganisationGlobalSettings } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { extractDerivedDocumentMeta } from './document';

/**
 * Organisation sender addresses were removed. A new document's meta must never carry an
 * emailId, whether one arrives in the request or is inherited from team settings.
 */

const settings = {
  documentLanguage: 'en',
  documentTimezone: null,
  documentDateFormat: 'yyyy-MM-dd hh:mm a',
  emailId: 'settings_email',
  emailReplyTo: null,
  emailDocumentSettings: null,
} as unknown as Omit<OrganisationGlobalSettings, 'id'>;

describe('extractDerivedDocumentMeta emailId', () => {
  it('ignores an emailId passed in the request', () => {
    expect(extractDerivedDocumentMeta(settings, { emailId: 'request_email' }).emailId).toBeNull();
  });

  it('does not inherit an emailId from settings', () => {
    expect(extractDerivedDocumentMeta(settings, undefined).emailId).toBeNull();
  });
});
