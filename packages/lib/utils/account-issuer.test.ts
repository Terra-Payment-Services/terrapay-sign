import { describe, expect, it } from 'vitest';

import { decideAccountForIssuer, readIssuerFromIdToken } from './account-issuer';

const ENTRA = 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0';
const ATTACKER = 'https://sso.attacker.example/realms/documenso';

const row = (overrides: Partial<{ id: string; provider: string; issuer: string | null }> = {}) => ({
  id: 'account_1',
  provider: 'organisation_1',
  issuer: ENTRA,
  ...overrides,
});

describe('decideAccountForIssuer', () => {
  it('uses the row the authority and the label both match', () => {
    const account = row();

    const decision = decideAccountForIssuer([account], { provider: 'organisation_1', issuer: ENTRA });

    expect(decision).toEqual({ action: 'use', account });
  });

  // The takeover. An organisation manager edits the portal's well known URL to
  // an authority they run, mints a token carrying somebody else's subject, and
  // the old lookup matched on the label and the subject alone.
  it('refuses a token whose issuer is not the one the row was linked through', () => {
    const decision = decideAccountForIssuer([row()], { provider: 'organisation_1', issuer: ATTACKER });

    expect(decision.action).toBe('refuse');

    if (decision.action !== 'refuse') {
      throw new Error('expected a refusal');
    }

    expect(decision.reason).toContain(ENTRA);
    expect(decision.reason).toContain(ATTACKER);
  });

  it('adopts a row written before the issuer column existed and stamps it', () => {
    const account = row({ issuer: null });

    const decision = decideAccountForIssuer([account], { provider: 'organisation_1', issuer: ENTRA });

    expect(decision).toEqual({ action: 'adopt', account });
  });

  // The label is the only thing a pre-backfill row carries, so it has to be the
  // thing that decides. A null issuer under some other label is somebody else.
  it('does not adopt a null issuer row belonging to another label', () => {
    const decision = decideAccountForIssuer([row({ provider: 'microsoft', issuer: null })], {
      provider: 'organisation_1',
      issuer: ENTRA,
    });

    expect(decision).toEqual({ action: 'none' });
  });

  it('reports no account when nothing holds the subject', () => {
    expect(decideAccountForIssuer([], { provider: 'microsoft', issuer: ENTRA })).toEqual({ action: 'none' });
  });

  // One authority plus one subject is one person, and the unique index says so.
  // Stamping or creating a second row here would hit a constraint violation, so
  // the refusal has to come first and say something a person can act on.
  it('refuses when the same authority and subject are already linked under another label', () => {
    const decision = decideAccountForIssuer([row({ provider: 'microsoft' })], {
      provider: 'organisation_1',
      issuer: ENTRA,
    });

    expect(decision.action).toBe('refuse');

    if (decision.action !== 'refuse') {
      throw new Error('expected a refusal');
    }

    expect(decision.reason).toContain('microsoft');
  });

  it('prefers the issuer match over an unstamped row under the same label', () => {
    const stamped = row({ id: 'account_stamped' });
    const unstamped = row({ id: 'account_unstamped', issuer: null });

    const decision = decideAccountForIssuer([unstamped, stamped], { provider: 'organisation_1', issuer: ENTRA });

    expect(decision).toEqual({ action: 'use', account: stamped });
  });
});

const jwt = (payload: Record<string, unknown>) =>
  `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(
    JSON.stringify(payload),
  ).toString('base64url')}.a-signature`;

describe('readIssuerFromIdToken', () => {
  it('reads iss out of a stored token', () => {
    expect(readIssuerFromIdToken(jwt({ iss: ENTRA, sub: 'a-subject' }))).toEqual({ ok: true, issuer: ENTRA });
  });

  it('reads a payload whose base64url needs no padding fix', () => {
    // Deliberately a payload whose length is not a multiple of four once
    // encoded, because a hand rolled base64 decode is where this goes wrong.
    expect(readIssuerFromIdToken(jwt({ iss: 'https://a.example', x: 'yz' }))).toEqual({
      ok: true,
      issuer: 'https://a.example',
    });
  });

  // The rows a person has to look at. Guessing the issuer from the provider
  // label and whatever is configured today is the assumption the column exists
  // to remove, so every one of these refuses rather than filling something in.
  it('refuses a row with no stored token', () => {
    expect(readIssuerFromIdToken(null)).toEqual({ ok: false, reason: 'No id_token stored' });
    expect(readIssuerFromIdToken(undefined)).toEqual({ ok: false, reason: 'No id_token stored' });
    expect(readIssuerFromIdToken('')).toEqual({ ok: false, reason: 'No id_token stored' });
  });

  it('refuses a token that is not three segments', () => {
    expect(readIssuerFromIdToken('not-a-jwt')).toMatchObject({ ok: false });
    expect(readIssuerFromIdToken('two.segments')).toMatchObject({ ok: false });
  });

  it('refuses a token whose payload is not JSON', () => {
    const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from('not json').toString(
      'base64url',
    )}.a-signature`;

    expect(readIssuerFromIdToken(token)).toEqual({ ok: false, reason: 'id_token payload is not decodable JSON' });
  });

  it('refuses a token whose payload is a JSON array', () => {
    const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from('[1,2]').toString(
      'base64url',
    )}.a-signature`;

    expect(readIssuerFromIdToken(token)).toEqual({ ok: false, reason: 'id_token payload is not a JSON object' });
  });

  it('refuses a token carrying no iss claim', () => {
    expect(readIssuerFromIdToken(jwt({ sub: 'a-subject' }))).toEqual({
      ok: false,
      reason: 'id_token carries no iss claim',
    });
  });

  it('refuses an iss that is not a non-empty string', () => {
    expect(readIssuerFromIdToken(jwt({ iss: '' }))).toMatchObject({ ok: false });
    expect(readIssuerFromIdToken(jwt({ iss: 42 }))).toMatchObject({ ok: false });
  });
});
