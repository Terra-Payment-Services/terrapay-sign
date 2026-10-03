import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertIssuerMatchesRetrievalUrl, getOpenIdConfiguration } from './open-id';

const WELL_KNOWN = 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration';

/**
 * The issuer Microsoft publishes at the `common` endpoint, template and all.
 *
 * Copied from a live fetch rather than from documentation. See the note on
 * tenant substitution in open-id.ts for the other shapes and where they came
 * from.
 */
const COMMON_ISSUER = 'https://login.microsoftonline.com/{tenantid}/v2.0';

const configuration = (overrides: Record<string, unknown> = {}) => ({
  issuer: COMMON_ISSUER,
  authorization_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  jwks_uri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
  id_token_signing_alg_values_supported: ['RS256'],
  scopes_supported: ['openid', 'email', 'profile'],
  ...overrides,
});

/**
 * A resolver the address guard is happy with, except for the names a test asks
 * it to point somewhere private. 198.51.101.10 sits outside every reserved
 * block, so it stands in for a real identity provider.
 */
const lookupWith = (overrides: Record<string, string> = {}) => {
  return async (hostname: string): Promise<string[]> => [overrides[hostname] ?? '198.51.101.10'];
};

const serve = (body: Record<string, unknown>) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

const fetchConfiguration = async (
  body: Record<string, unknown>,
  {
    wellKnownUrl = WELL_KNOWN,
    requiredScopes,
    addresses,
  }: { wellKnownUrl?: string; requiredScopes?: string[]; addresses?: Record<string, string> } = {},
) =>
  await getOpenIdConfiguration(wellKnownUrl, {
    requiredScopes,
    fetchFn: serve(body) as unknown as typeof fetch,
    lookup: lookupWith(addresses),
  });

/** Drop a key, which is what a provider that omits a required field looks like. */
const without = (key: string) => {
  const config = configuration();

  delete config[key as keyof typeof config];

  return config;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getOpenIdConfiguration', () => {
  it('returns the fields verification needs', async () => {
    const config = await fetchConfiguration(configuration(), { requiredScopes: ['openid'] });

    expect(config.issuer).toBe(COMMON_ISSUER);
    expect(config.jwks_uri).toBe('https://login.microsoftonline.com/common/discovery/v2.0/keys');
    expect(config.id_token_signing_alg_values_supported).toEqual(['RS256']);
  });

  it('refuses a provider that publishes no issuer', async () => {
    await expect(fetchConfiguration(without('issuer'))).rejects.toThrow();
  });

  it('refuses a provider that publishes no key set', async () => {
    // Without this there is no way to check a signature, and the alternative to
    // failing here is signing people in on tokens nobody verified.
    await expect(fetchConfiguration(without('jwks_uri'))).rejects.toThrow();
  });

  it('refuses a provider that publishes no signing algorithms', async () => {
    await expect(fetchConfiguration(without('id_token_signing_alg_values_supported'))).rejects.toThrow();
  });

  it('refuses an empty list of signing algorithms', async () => {
    await expect(fetchConfiguration(configuration({ id_token_signing_alg_values_supported: [] }))).rejects.toThrow();
  });

  it('refuses a scope the provider does not support', async () => {
    await expect(fetchConfiguration(configuration(), { requiredScopes: ['groups'] })).rejects.toThrow(
      /Requested scopes not supported/,
    );
  });

  it('refuses a document that is not JSON', async () => {
    const fetchFn = vi.fn(async () => new Response('<html>a login page</html>', { status: 200 }));

    await expect(
      getOpenIdConfiguration(WELL_KNOWN, { fetchFn: fetchFn as unknown as typeof fetch, lookup: lookupWith() }),
    ).rejects.toThrow(/not JSON/);
  });
});

describe('the issuer a document claims', () => {
  // The headline case. A document served from somewhere an organisation manager
  // chose, claiming to be Microsoft, publishing keys the manager holds. Every
  // token it then mints verifies against the issuer this document named, and
  // the callback links accounts by email address.
  it('refuses a document that claims an issuer belonging to another host', async () => {
    await expect(
      fetchConfiguration(
        configuration({
          issuer: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0',
          jwks_uri: 'https://idp.attacker.example/keys',
          token_endpoint: 'https://idp.attacker.example/token',
        }),
        { wellKnownUrl: 'https://idp.attacker.example/.well-known/openid-configuration' },
      ),
    ).rejects.toThrow(/may only speak for the host it was served from/);
  });

  it('refuses an issuer on the right host but at an unrelated path', async () => {
    await expect(
      fetchConfiguration(configuration({ issuer: 'https://login.microsoftonline.com/common/v2.0/extra/segments' })),
    ).rejects.toThrow(/does not correspond to the document/);
  });

  it('refuses an issuer whose path is shorter than the one it was served from', async () => {
    await expect(
      fetchConfiguration(configuration({ issuer: 'https://login.microsoftonline.com/common' })),
    ).rejects.toThrow(/does not correspond to the document/);
  });

  it('refuses an issuer that changes more than the tenant', async () => {
    await expect(
      fetchConfiguration(configuration({ issuer: 'https://login.microsoftonline.com/other-tenant/v9.9' })),
    ).rejects.toThrow(/does not correspond to the document/);
  });

  it('refuses an issuer carrying a query string', async () => {
    await expect(
      fetchConfiguration(configuration({ issuer: 'https://login.microsoftonline.com/common/v2.0?tenant=evil' })),
    ).rejects.toThrow(/query or fragment/);
  });

  it('refuses an issuer that is not an http URL', async () => {
    await expect(fetchConfiguration(configuration({ issuer: 'urn:example:issuer' }))).rejects.toThrow(
      /not an http or https URL/,
    );
  });

  it('refuses an issuer that does not parse as a URL at all', async () => {
    await expect(fetchConfiguration(configuration({ issuer: 'login.microsoftonline.com' }))).rejects.toThrow(
      /issuer that is not a URL/,
    );
  });

  it('refuses a discovery URL with no well-known segment to bind against', async () => {
    await expect(
      fetchConfiguration(configuration({ issuer: 'https://idp.example.test' }), {
        wellKnownUrl: 'https://idp.example.test/openid-configuration',
      }),
    ).rejects.toThrow(/does not carry a well-known path/);
  });
});

describe('the Entra shapes that have to keep working', () => {
  // Every expectation below was taken from a live fetch of the endpoint named,
  // because a check calibrated against the specification alone would lock out
  // every member of staff at three of these four deployments.
  it('accepts the tenant GUID form, where issuer and URL match exactly', async () => {
    const issuer = 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0';

    const config = await fetchConfiguration(configuration({ issuer }), {
      wellKnownUrl: `${issuer}/.well-known/openid-configuration`,
    });

    expect(config.issuer).toBe(issuer);
  });

  it('accepts the common endpoint, which publishes a {tenantid} template', async () => {
    const config = await fetchConfiguration(configuration({ issuer: COMMON_ISSUER }));

    expect(config.issuer).toBe(COMMON_ISSUER);
  });

  it('accepts the organizations endpoint, which publishes the same template', async () => {
    const config = await fetchConfiguration(configuration({ issuer: COMMON_ISSUER }), {
      wellKnownUrl: 'https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration',
    });

    expect(config.issuer).toBe(COMMON_ISSUER);
  });

  it('accepts an authority named by verified domain, which answers with the directory GUID', async () => {
    const issuer = 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0';

    const config = await fetchConfiguration(configuration({ issuer }), {
      wellKnownUrl: 'https://login.microsoftonline.com/contoso.com/v2.0/.well-known/openid-configuration',
    });

    expect(config.issuer).toBe(issuer);
  });

  it('accepts the consumers endpoint, which answers with the Microsoft account tenant', async () => {
    const issuer = 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0';

    const config = await fetchConfiguration(configuration({ issuer }), {
      wellKnownUrl: 'https://login.microsoftonline.com/consumers/v2.0/.well-known/openid-configuration',
    });

    expect(config.issuer).toBe(issuer);
  });

  it('ignores the appid query Microsoft documents on the common endpoint', async () => {
    const config = await fetchConfiguration(configuration(), {
      wellKnownUrl: `${WELL_KNOWN}?appid=6731de76-14a6-49ae-97bc-6eba6914391e`,
    });

    expect(config.issuer).toBe(COMMON_ISSUER);
  });
});

describe('other providers that have to keep working', () => {
  it('accepts an issuer with no path, which is what Google publishes', async () => {
    const config = await fetchConfiguration(
      configuration({
        issuer: 'https://accounts.google.com',
        token_endpoint: 'https://accounts.google.com/token',
        jwks_uri: 'https://accounts.google.com/certs',
      }),
      { wellKnownUrl: 'https://accounts.google.com/.well-known/openid-configuration' },
    );

    expect(config.issuer).toBe('https://accounts.google.com');
  });

  it('accepts a realm path, which is what Keycloak publishes', async () => {
    const issuer = 'https://idp.example.test/realms/documenso';

    const config = await fetchConfiguration(
      configuration({
        issuer,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        jwks_uri: `${issuer}/protocol/openid-connect/certs`,
      }),
      { wellKnownUrl: `${issuer}/.well-known/openid-configuration` },
    );

    expect(config.issuer).toBe(issuer);
  });

  it('accepts the issuer-prefixed placement RFC 8414 defines', () => {
    // The well-known segment sits between the host and the issuer path here,
    // rather than being appended to it. Both placements are in the RFC.
    expect(() =>
      assertIssuerMatchesRetrievalUrl(
        'https://idp.example.test/tenant-a',
        'https://idp.example.test/.well-known/oauth-authorization-server/tenant-a',
      ),
    ).not.toThrow();
  });
});

describe('the addresses a discovery document points at', () => {
  const loopbackForms = [
    ['localhost by name', 'http://localhost:8080/realms/test/protocol/openid-connect/certs'],
    ['the loopback literal', 'https://127.0.0.1/keys'],
    ['another address in 127.0.0.0/8', 'https://127.0.0.2/keys'],
    ['the IPv6 loopback', 'https://[::1]/keys'],
    ['the unspecified address', 'https://0.0.0.0/keys'],
    ['loopback in decimal', 'https://2130706433/keys'],
    ['loopback in hex', 'https://0x7f000001/keys'],
    ['loopback as IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/keys'],
  ] as const;

  // The exemption these replace allowed the first two by comparing hostname
  // strings, and had nothing to say about the other six. `wellKnownUrl` is set
  // by an organisation manager through the enterprise portal, so pointing the
  // key set at loopback made the production server fetch whatever else was
  // listening there.
  it.each(loopbackForms)('refuses a key set on %s', async (_name, jwksUri) => {
    await expect(
      fetchConfiguration(configuration({ jwks_uri: jwksUri }), { addresses: { localhost: '127.0.0.1' } }),
    ).rejects.toThrow(/jwks_uri we will not contact/);
  });

  it('refuses a key set on a name that resolves to loopback', async () => {
    await expect(
      fetchConfiguration(configuration({ jwks_uri: 'https://keys.attacker.example/jwks.json' }), {
        addresses: { 'keys.attacker.example': '127.0.0.1' },
      }),
    ).rejects.toThrow(/jwks_uri we will not contact/);
  });

  it('refuses a key set served over plain HTTP', async () => {
    // Anyone on the path answers with their own keys, and then every token they
    // mint verifies.
    await expect(fetchConfiguration(configuration({ jwks_uri: 'http://keys.example.com/jwks.json' }))).rejects.toThrow(
      /jwks_uri we will not contact/,
    );
  });

  // This is the one that carries a credential. The callback posts the client id
  // and the decrypted client secret here under HTTP Basic.
  it('refuses a token endpoint on a private address', async () => {
    await expect(
      fetchConfiguration(configuration({ token_endpoint: 'https://token.attacker.example/token' }), {
        addresses: { 'token.attacker.example': '10.0.0.5' },
      }),
    ).rejects.toThrow(/token_endpoint we will not contact/);
  });

  it('refuses a token endpoint on the cloud metadata address', async () => {
    await expect(
      fetchConfiguration(configuration({ token_endpoint: 'https://169.254.169.254/latest/meta-data/' })),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('refuses a token endpoint served over plain HTTP', async () => {
    await expect(
      fetchConfiguration(
        configuration({ token_endpoint: 'http://login.microsoftonline.com/common/oauth2/v2.0/token' }),
      ),
    ).rejects.toThrow(/token_endpoint we will not contact/);
  });

  it('refuses a discovery URL that resolves into a private range', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));

    await expect(
      getOpenIdConfiguration('https://sso.internal.example/.well-known/openid-configuration', {
        fetchFn: fetchFn as unknown as typeof fetch,
        lookup: lookupWith({ 'sso.internal.example': '172.16.4.9' }),
      }),
    ).rejects.toThrow(/not publicly routable/);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a discovery URL on plain HTTP', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));

    await expect(
      getOpenIdConfiguration('http://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration', {
        fetchFn: fetchFn as unknown as typeof fetch,
        lookup: lookupWith(),
      }),
    ).rejects.toThrow(/only https are allowed/);

    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('the local development escape hatch', () => {
  const localConfiguration = () =>
    configuration({
      issuer: 'http://localhost:8080/realms/documenso',
      authorization_endpoint: 'http://localhost:8080/realms/documenso/protocol/openid-connect/auth',
      token_endpoint: 'http://localhost:8080/realms/documenso/protocol/openid-connect/token',
      jwks_uri: 'http://localhost:8080/realms/documenso/protocol/openid-connect/certs',
    });

  const LOCAL_WELL_KNOWN = 'http://localhost:8080/realms/documenso/.well-known/openid-configuration';

  it('stays shut unless somebody opens it on purpose', async () => {
    await expect(
      fetchConfiguration(localConfiguration(), {
        wellKnownUrl: LOCAL_WELL_KNOWN,
        addresses: { localhost: '127.0.0.1' },
      }),
    ).rejects.toThrow(/only https are allowed/);
  });

  it('lets a developer run an identity provider on their own machine', async () => {
    vi.stubEnv('NEXT_PRIVATE_OIDC_ALLOW_LOCAL_AUTHORITY', 'true');

    const config = await fetchConfiguration(localConfiguration(), {
      wellKnownUrl: LOCAL_WELL_KNOWN,
      addresses: { localhost: '127.0.0.1' },
    });

    expect(config.jwks_uri).toContain('localhost');
  });

  it('cannot be opened in a production build', async () => {
    vi.stubEnv('NEXT_PRIVATE_OIDC_ALLOW_LOCAL_AUTHORITY', 'true');
    vi.stubEnv('NODE_ENV', 'production');

    await expect(
      fetchConfiguration(localConfiguration(), {
        wellKnownUrl: LOCAL_WELL_KNOWN,
        addresses: { localhost: '127.0.0.1' },
      }),
    ).rejects.toThrow(/only https are allowed/);
  });

  it('cannot be opened on a deployment served over https', async () => {
    // Covers a deployment that never set NODE_ENV. sign.terrapay.com is https,
    // and the apex carries HSTS, so there is no plain-http way to run it.
    vi.stubEnv('NEXT_PRIVATE_OIDC_ALLOW_LOCAL_AUTHORITY', 'true');
    vi.stubEnv('NEXT_PUBLIC_WEBAPP_URL', 'https://sign.terrapay.com');

    await expect(
      fetchConfiguration(localConfiguration(), {
        wellKnownUrl: LOCAL_WELL_KNOWN,
        addresses: { localhost: '127.0.0.1' },
      }),
    ).rejects.toThrow(/only https are allowed/);
  });
});
