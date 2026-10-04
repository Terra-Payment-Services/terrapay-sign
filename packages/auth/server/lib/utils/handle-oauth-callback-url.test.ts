import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOpenIdConfiguration: vi.fn(),
  verifyIdToken: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  deleteCookie: vi.fn(),
  onAuthorize: vi.fn(),
  onCreateUserHook: vi.fn(),
  addUserToSoleOrganisation: vi.fn(),
  loggerError: vi.fn(),
  getEmailBlocklistDomains: vi.fn(),
  accountFindMany: vi.fn(),
  accountUpdate: vi.fn(),
  accountCreate: vi.fn(),
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock('./open-id', () => ({ getOpenIdConfiguration: mocks.getOpenIdConfiguration }));

vi.mock('./verify-id-token', () => ({ verifyIdToken: mocks.verifyIdToken }));

vi.mock('./authorizer', () => ({ onAuthorize: mocks.onAuthorize }));

vi.mock('@documenso/lib/server-only/user/create-user', () => ({ onCreateUserHook: mocks.onCreateUserHook }));

vi.mock('@documenso/lib/server-only/organisation/add-user-to-sole-organisation', () => ({
  addUserToSoleOrganisation: mocks.addUserToSoleOrganisation,
}));

vi.mock('@documenso/lib/utils/logger', () => ({ logger: { error: mocks.loggerError } }));

vi.mock('@documenso/lib/server-only/site-settings/get-email-blocklist-domains', () => ({
  getEmailBlocklistDomains: mocks.getEmailBlocklistDomains,
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    account: { findMany: mocks.accountFindMany, update: mocks.accountUpdate },
    user: { findFirst: mocks.userFindFirst },
    // Hands the callback a transaction client, so the writes inside it are
    // visible to a test rather than silently skipped.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        account: { create: mocks.accountCreate },
        user: { create: mocks.userCreate, update: vi.fn() },
        userSecurityAuditLog: { create: mocks.auditLogCreate },
      }),
  },
}));

vi.mock('hono/cookie', () => ({ deleteCookie: mocks.deleteCookie }));

vi.mock('./token-exchange', () => ({ exchangeAuthorizationCode: mocks.exchangeAuthorizationCode }));

import { handleOAuthCallbackUrl, validateOauth } from './handle-oauth-callback-url';

const ISSUER = 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0';
const JWKS_URI = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';
const STATE = 'the-stored-state';

const clientOptions = {
  id: 'microsoft',
  scope: ['openid', 'email', 'profile'],
  clientId: '00000000-0000-0000-0000-000000000002',
  clientSecret: 'a-secret',
  redirectUrl: 'https://sign.terrapay.com/api/auth/callback/microsoft',
  wellKnownUrl: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
  bypassEmailVerification: true,
};

/**
 * A payload as verifyIdToken would hand it back.
 *
 * `aud` and `exp` are here because assertIdTokenClaims still checks them after
 * the signature has been verified, and that duplication is deliberate.
 */
const verifiedPayload = (overrides: Record<string, unknown> = {}) => ({
  sub: 'a-stable-subject',
  aud: clientOptions.clientId,
  exp: Math.floor(Date.now() / 1000) + 3600,
  email: 'someone@terrapay.com',
  name: 'Someone',
  email_verified: true,
  ...overrides,
});

const createContext = () => {
  const redirect = vi.fn((url: string, status?: number) => ({ url, status }));
  const text = vi.fn((body: string, status?: number) => ({ body, status }));

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    c: {
      req: { query: (key: string) => (key === 'code' ? 'the-code' : STATE) },
      get: () => ({ ipAddress: '10.0.0.1', userAgent: 'a-browser' }),
      redirect,
      text,
    } as unknown as Context,
    redirect,
  };
};

describe('validateOauth', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getOpenIdConfiguration.mockResolvedValue({
      issuer: ISSUER,
      authorization_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      jwks_uri: JWKS_URI,
      id_token_signing_alg_values_supported: ['RS256', 'HS256'],
      scopes_supported: ['openid', 'email', 'profile'],
    });

    mocks.deleteCookie.mockImplementation((_c: unknown, name: string) => {
      if (name.endsWith('_oauth_state')) {
        return STATE;
      }

      if (name.endsWith('_code_verifier')) {
        return 'the-verifier';
      }

      return `${STATE} /documents`;
    });

    mocks.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'an-access-token',
      accessTokenExpiresAt: new Date('2026-09-15T13:00:00Z'),
      idToken: 'header.payload.signature',
    });

    mocks.verifyIdToken.mockResolvedValue(verifiedPayload());
  });

  it('verifies the token against the authority discovery named', async () => {
    const { c } = createContext();

    await validateOauth({ c, clientOptions });

    expect(mocks.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'header.payload.signature',
      issuer: ISSUER,
      audience: clientOptions.clientId,
      jwksUri: JWKS_URI,
      // Passed through whole. The narrowing to what can be verified happens in
      // verifyIdToken, against the same list.
      advertisedSigningAlgorithms: ['RS256', 'HS256'],
    });
  });

  it('reads the identity out of the verified payload', async () => {
    const { c } = createContext();

    // The raw token here is three words with dots between them. Anything that
    // still decoded it instead of using the verified payload would fail.
    mocks.verifyIdToken.mockResolvedValue(
      verifiedPayload({ sub: 'the-verified-subject', email: 'verified@terrapay.com', name: 'Verified Person' }),
    );

    const result = await validateOauth({ c, clientOptions });

    expect(result.sub).toBe('the-verified-subject');
    expect(result.email).toBe('verified@terrapay.com');
    expect(result.name).toBe('Verified Person');
  });

  it('refuses the sign in when the signature does not verify', async () => {
    const { c } = createContext();

    mocks.verifyIdToken.mockRejectedValue(new Error('The identity token failed verification'));

    await expect(validateOauth({ c, clientOptions })).rejects.toThrow(/failed verification/);
  });

  it('refuses a verified token that came from another directory', async () => {
    const { c } = createContext();

    // A signature check settles who wrote the token. It does not settle which
    // Entra directory the person came from, so the claim checks still run.
    mocks.verifyIdToken.mockResolvedValue(verifiedPayload({ aud: 'another-application' }));

    await expect(validateOauth({ c, clientOptions })).rejects.toThrow(/different application/);
  });
});

describe('handleOAuthCallbackUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getOpenIdConfiguration.mockResolvedValue({
      issuer: ISSUER,
      authorization_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      jwks_uri: JWKS_URI,
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'profile'],
    });

    mocks.deleteCookie.mockImplementation((_c: unknown, name: string) => {
      if (name.endsWith('_oauth_state')) {
        return STATE;
      }

      if (name.endsWith('_code_verifier')) {
        return 'the-verifier';
      }

      return `${STATE} /documents`;
    });

    mocks.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'an-access-token',
      accessTokenExpiresAt: new Date('2026-09-15T13:00:00Z'),
      idToken: 'header.payload.signature',
    });
  });

  it('never reaches an account when verification fails', async () => {
    const { c } = createContext();

    mocks.verifyIdToken.mockRejectedValue(new Error('The identity token failed verification'));

    await expect(handleOAuthCallbackUrl({ c, clientOptions })).rejects.toThrow(/failed verification/);

    // The point of the check is that nothing downstream of it runs. An account
    // found or created from an unverified token is the whole finding.
    expect(mocks.accountFindMany).not.toHaveBeenCalled();
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
    expect(mocks.onAuthorize).not.toHaveBeenCalled();
  });

  it('keys the account on the subject from the verified payload', async () => {
    const { c } = createContext();

    mocks.verifyIdToken.mockResolvedValue(verifiedPayload({ sub: 'the-verified-subject' }));

    mocks.accountFindMany.mockResolvedValue([{ id: 'account_1', userId: 7, provider: 'microsoft', issuer: ISSUER }]);

    await handleOAuthCallbackUrl({ c, clientOptions });

    expect(mocks.accountFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          providerAccountId: 'the-verified-subject',
          OR: [{ provider: 'microsoft' }, { issuer: ISSUER }],
        },
      }),
    );
    expect(mocks.onAuthorize).toHaveBeenCalledWith({ userId: 7 }, c);
  });

  // `NEXT_PRIVATE_MICROSOFT_TENANT` is configuration, and configuration changes.
  // Point the label at an authority you control, mint a token carrying somebody
  // else's subject, and the old lookup handed over their session.
  it('refuses a token from an authority the account was not linked through', async () => {
    const { c } = createContext();

    mocks.accountFindMany.mockResolvedValue([
      { id: 'account_1', userId: 7, provider: 'microsoft', issuer: 'https://sso.attacker.example/realms/documenso' },
    ]);

    await expect(handleOAuthCallbackUrl({ c, clientOptions })).rejects.toThrow(/Refusing to sign in/);

    expect(mocks.onAuthorize).not.toHaveBeenCalled();
    expect(mocks.accountUpdate).not.toHaveBeenCalled();
  });

  it('adopts a row written before the issuer column existed, and stamps it', async () => {
    const { c } = createContext();

    mocks.accountFindMany.mockResolvedValue([{ id: 'account_1', userId: 7, provider: 'microsoft', issuer: null }]);
    mocks.accountUpdate.mockResolvedValue({});

    await handleOAuthCallbackUrl({ c, clientOptions });

    expect(mocks.accountUpdate).toHaveBeenCalledWith({ where: { id: 'account_1' }, data: { issuer: ISSUER } });
    expect(mocks.onAuthorize).toHaveBeenCalledWith({ userId: 7 }, c);
  });

  it('records the issuer when it links an account to an existing user', async () => {
    const { c } = createContext();

    mocks.accountFindMany.mockResolvedValue([]);
    mocks.userFindFirst.mockResolvedValue({ id: 7, emailVerified: new Date() });

    await handleOAuthCallbackUrl({ c, clientOptions });

    expect(mocks.accountCreate).toHaveBeenCalledTimes(1);
    expect(mocks.accountCreate.mock.calls[0][0].data).toMatchObject({ provider: 'microsoft', issuer: ISSUER });
  });

  it('records the issuer when it creates an account for a new user', async () => {
    const { c } = createContext();

    mocks.accountFindMany.mockResolvedValue([]);
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: 9, email: 'someone@terrapay.com' });
    mocks.getEmailBlocklistDomains.mockResolvedValue([]);
    mocks.onCreateUserHook.mockResolvedValue(undefined);

    await handleOAuthCallbackUrl({ c, clientOptions });

    expect(mocks.accountCreate).toHaveBeenCalledTimes(1);
    expect(mocks.accountCreate.mock.calls[0][0].data).toMatchObject({ provider: 'microsoft', issuer: ISSUER });
  });

  it('gives a new user no personal organisation', async () => {
    const { c } = createContext();

    mocks.accountFindMany.mockResolvedValue([]);
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: 9, email: 'someone@terrapay.com' });
    mocks.getEmailBlocklistDomains.mockResolvedValue([]);
    mocks.onCreateUserHook.mockResolvedValue(undefined);

    await handleOAuthCallbackUrl({ c, clientOptions });

    expect(mocks.onCreateUserHook).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }), {
      skipPersonalOrganisation: true,
    });
  });

  describe('a new user', () => {
    beforeEach(() => {
      mocks.verifyIdToken.mockResolvedValue(verifiedPayload());
      mocks.accountFindMany.mockResolvedValue([]);
      mocks.userFindFirst.mockResolvedValue(null);
      mocks.userCreate.mockResolvedValue({ id: 9, email: 'someone@terrapay.com' });
      mocks.getEmailBlocklistDomains.mockResolvedValue([]);
      mocks.onCreateUserHook.mockResolvedValue(undefined);
      mocks.addUserToSoleOrganisation.mockResolvedValue('added');
    });

    it('joins the organisation when they come through Microsoft', async () => {
      const { c } = createContext();

      await handleOAuthCallbackUrl({ c, clientOptions });

      expect(mocks.addUserToSoleOrganisation).toHaveBeenCalledWith({ userId: 9 });
      expect(mocks.onAuthorize).toHaveBeenCalledWith({ userId: 9 }, c);
    });

    it('refuses them outright when they come through another provider, before any account exists', async () => {
      const { c } = createContext();

      await expect(handleOAuthCallbackUrl({ c, clientOptions: { ...clientOptions, id: 'oidc' } })).rejects.toThrow(
        /Microsoft Entra only/,
      );

      expect(mocks.verifyIdToken).not.toHaveBeenCalled();
      expect(mocks.userCreate).not.toHaveBeenCalled();
      expect(mocks.addUserToSoleOrganisation).not.toHaveBeenCalled();
      expect(mocks.onAuthorize).not.toHaveBeenCalled();
    });

    it('still signs them in when joining the organisation fails', async () => {
      const { c } = createContext();

      mocks.addUserToSoleOrganisation.mockRejectedValue(new Error('Organisation group not found'));

      await handleOAuthCallbackUrl({ c, clientOptions });

      expect(mocks.loggerError).toHaveBeenCalledWith(expect.objectContaining({ userId: 9 }));
      expect(mocks.onAuthorize).toHaveBeenCalledWith({ userId: 9 }, c);
    });
  });

  it('does not touch organisation membership for a returning user', async () => {
    const { c } = createContext();

    mocks.verifyIdToken.mockResolvedValue(verifiedPayload());
    mocks.accountFindMany.mockResolvedValue([{ id: 'account_1', userId: 7, provider: 'microsoft', issuer: ISSUER }]);

    await handleOAuthCallbackUrl({ c, clientOptions });

    expect(mocks.addUserToSoleOrganisation).not.toHaveBeenCalled();
  });
});
