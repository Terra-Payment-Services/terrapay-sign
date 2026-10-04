import { describe, expect, it } from 'vitest';

import { presignScopeCoversEnvelope } from './presign-scope-covers-envelope';

const envelope = { id: 'envelope_abc', secondaryId: 'document_12' };

describe('presignScopeCoversEnvelope', () => {
  it('admits any envelope in the team when the token has no scope', () => {
    expect(presignScopeCoversEnvelope(undefined, envelope)).toBe(true);
  });

  it('admits the envelope a token is scoped to, in either embed version', () => {
    expect(presignScopeCoversEnvelope('envelopeId:envelope_abc', envelope)).toBe(true);
    expect(presignScopeCoversEnvelope('documentId:12', envelope)).toBe(true);
    expect(presignScopeCoversEnvelope('templateId:4', { id: 'envelope_t', secondaryId: 'template_4' })).toBe(true);
  });

  it.each([
    'envelopeId:envelope_other',
    'documentId:13',
    'documentId:012',
    'documentId:',
    'templateId:12',
    'documentId:12x',
    'teamId:1',
    '',
  ])('refuses another envelope for scope %j', (scope) => {
    expect(presignScopeCoversEnvelope(scope, envelope)).toBe(false);
  });
});
