import { afterEach, describe, expect, it, vi } from 'vitest';

import { CscError, createCscClient } from './csc-client';
import { type CscMockRoute, installCscMockProvider } from './csc-test-support';

const BASE_URL = 'https://csc.example.test';

const CLIENT_OPTIONS = {
  baseUrl: BASE_URL,
  clientId: 'service-account',
  clientSecret: 'service-secret',
};

const LEAF_DER = new Uint8Array([0x30, 0x82, 0x01, 0x01]);
const INTERMEDIATE_DER = new Uint8Array([0x30, 0x82, 0x01, 0x02]);

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const tokenRoute =
  (accessToken = 'access-token-1', expiresIn = 3600): CscMockRoute =>
  () => ({ body: { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn } });

const credentialInfoRoute: CscMockRoute = () => ({
  body: {
    cert: { certificates: [base64(LEAF_DER), base64(INTERMEDIATE_DER)], status: 'valid' },
    key: { status: 'enabled', algo: ['1.2.840.113549.1.1.1'], len: 2048 },
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createCscClient', () => {
  describe('base URL validation', () => {
    it('rejects a plain http base URL', () => {
      expect(() => createCscClient({ ...CLIENT_OPTIONS, baseUrl: 'http://csc.example.test' })).toThrow(CscError);
      expect(() => createCscClient({ ...CLIENT_OPTIONS, baseUrl: 'http://csc.example.test' })).toThrow(
        /must use https/,
      );
    });

    it('rejects a value that is not a URL at all', () => {
      expect(() => createCscClient({ ...CLIENT_OPTIONS, baseUrl: 'csc.example.test' })).toThrow(/not a valid URL/);
    });

    it('tolerates a trailing slash on the base URL', async () => {
      const provider = installCscMockProvider({ '/oauth2/token': tokenRoute() });

      const client = createCscClient({ ...CLIENT_OPTIONS, baseUrl: `${BASE_URL}/` });

      await client.getAccessToken();

      expect(provider.requestsTo('/oauth2/token')).toHaveLength(1);
    });
  });

  describe('access token', () => {
    it('requests a client credentials grant and returns the token', async () => {
      const provider = installCscMockProvider({ '/oauth2/token': tokenRoute('token-abc') });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(client.getAccessToken()).resolves.toBe('token-abc');

      const [request] = provider.requestsTo('/oauth2/token');

      expect(request.body).toMatchObject({
        grant_type: 'client_credentials',
        client_id: 'service-account',
        client_secret: 'service-secret',
        scope: 'service',
      });
    });

    it('reuses the token within its lifetime and refreshes it after expiry', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      let issued = 0;

      const provider = installCscMockProvider({
        '/oauth2/token': () => {
          issued += 1;

          return { body: { access_token: `token-${issued}`, expires_in: 3600 } };
        },
      });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(client.getAccessToken()).resolves.toBe('token-1');

      // Well inside the token's hour.
      vi.setSystemTime(new Date('2026-01-01T00:30:00Z'));
      await expect(client.getAccessToken()).resolves.toBe('token-1');
      expect(provider.requestsTo('/oauth2/token')).toHaveLength(1);

      // Past expiry.
      vi.setSystemTime(new Date('2026-01-01T01:05:00Z'));
      await expect(client.getAccessToken()).resolves.toBe('token-2');
      expect(provider.requestsTo('/oauth2/token')).toHaveLength(2);
    });

    it('refreshes shortly before expiry rather than exactly at it', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      installCscMockProvider({ '/oauth2/token': tokenRoute('token-skew', 3600) });

      const client = createCscClient(CLIENT_OPTIONS);

      await client.getAccessToken();

      // 30 seconds before the nominal expiry, inside the 60 second skew.
      vi.setSystemTime(new Date('2026-01-01T00:59:30Z'));

      await client.getAccessToken();

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });

    it('surfaces a failed token request as an error', async () => {
      installCscMockProvider({
        '/oauth2/token': () => ({
          status: 401,
          body: { error: 'invalid_client', error_description: 'client authentication failed' },
        }),
      });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(client.getAccessToken()).rejects.toThrow(CscError);
      await expect(client.getAccessToken()).rejects.toThrow(
        /HTTP 401 \(invalid_client: client authentication failed\)/,
      );
    });

    it('rejects a token response with no access token', async () => {
      installCscMockProvider({ '/oauth2/token': () => ({ body: { token_type: 'Bearer', expires_in: 3600 } }) });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(client.getAccessToken()).rejects.toThrow(/no access token/);
    });

    it('rejects a token response that is not JSON', async () => {
      installCscMockProvider({ '/oauth2/token': () => ({ rawBody: '<html>maintenance</html>' }) });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(client.getAccessToken()).rejects.toThrow(/not JSON/);
    });

    it('refuses a redirect rather than following it', async () => {
      installCscMockProvider({ '/oauth2/token': () => ({ status: 302 }) });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(client.getAccessToken()).rejects.toThrow(/redirected \(HTTP 302\)/);
    });

    it('does not follow redirects at the fetch layer', async () => {
      installCscMockProvider({ '/oauth2/token': tokenRoute() });

      const client = createCscClient(CLIENT_OPTIONS);

      await client.getAccessToken();

      expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    });

    it('attaches an abort signal to every request', async () => {
      installCscMockProvider({ '/oauth2/token': tokenRoute() });

      const client = createCscClient(CLIENT_OPTIONS);

      await client.getAccessToken();

      const init = vi.mocked(fetch).mock.calls[0][1];

      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('credentials/info', () => {
    it('asks for the chain and certificate info, and decodes the certificates', async () => {
      const provider = installCscMockProvider({
        '/oauth2/token': tokenRoute('bearer-1'),
        '/csc/v2/credentials/info': credentialInfoRoute,
      });

      const client = createCscClient(CLIENT_OPTIONS);
      const info = await client.getCredentialInfo('cred-1');

      const [request] = provider.requestsTo('/csc/v2/credentials/info');

      expect(request.body).toMatchObject({ credentialID: 'cred-1', certificates: 'chain', certInfo: true });
      expect(request.authorization).toBe('Bearer bearer-1');

      expect(info.certificates).toEqual([LEAF_DER, INTERMEDIATE_DER]);
      expect(info.keyAlgorithms).toEqual(['1.2.840.113549.1.1.1']);
      expect(info.keyLength).toBe(2048);
      expect(info.keyStatus).toBe('enabled');
    });

    it('accepts a provider that puts the certificates at the top level', async () => {
      installCscMockProvider({
        '/oauth2/token': tokenRoute(),
        '/csc/v2/credentials/info': () => ({
          body: { certificates: [base64(LEAF_DER)], key: { status: 'enabled', algo: ['1.2.840.113549.1.1.1'] } },
        }),
      });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(client.getCredentialInfo('cred-1')).resolves.toMatchObject({ certificates: [LEAF_DER] });
    });

    it('rejects a credential with no certificates', async () => {
      installCscMockProvider({
        '/oauth2/token': tokenRoute(),
        '/csc/v2/credentials/info': () => ({ body: { cert: { certificates: [] }, key: { algo: ['1.2.840'] } } }),
      });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(client.getCredentialInfo('cred-1')).rejects.toThrow(/no certificates/);
    });

    it('rejects a credential that reports no key algorithms', async () => {
      installCscMockProvider({
        '/oauth2/token': tokenRoute(),
        '/csc/v2/credentials/info': () => ({ body: { cert: { certificates: [base64(LEAF_DER)] }, key: {} } }),
      });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(client.getCredentialInfo('cred-1')).rejects.toThrow(/no key algorithms/);
    });

    it('rejects a certificate that is not valid base64', async () => {
      installCscMockProvider({
        '/oauth2/token': tokenRoute(),
        '/csc/v2/credentials/info': () => ({
          body: { cert: { certificates: ['not base64!!'] }, key: { algo: ['1.2.840.113549.1.1.1'] } },
        }),
      });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(client.getCredentialInfo('cred-1')).rejects.toThrow(/not valid base64/);
    });
  });

  describe('credentials/authorize', () => {
    it('sends the hashes, the signature count and the PIN, and returns the SAD', async () => {
      const provider = installCscMockProvider({
        '/oauth2/token': tokenRoute(),
        '/csc/v2/credentials/authorize': () => ({ body: { SAD: 'sad-value', expiresIn: 300 } }),
      });

      const client = createCscClient(CLIENT_OPTIONS);

      const result = await client.authorize({ credentialID: 'cred-1', hashes: ['aGFzaA=='], pin: '1234' });

      expect(result).toEqual({ sad: 'sad-value', expiresIn: 300 });

      const [request] = provider.requestsTo('/csc/v2/credentials/authorize');

      expect(request.body).toMatchObject({
        credentialID: 'cred-1',
        numSignatures: 1,
        hash: ['aGFzaA=='],
        PIN: '1234',
      });
    });

    it('omits the PIN when none is configured', async () => {
      const provider = installCscMockProvider({
        '/oauth2/token': tokenRoute(),
        '/csc/v2/credentials/authorize': () => ({ body: { SAD: 'sad-value' } }),
      });

      const client = createCscClient(CLIENT_OPTIONS);

      await client.authorize({ credentialID: 'cred-1', hashes: ['aGFzaA=='] });

      expect(provider.requestsTo('/csc/v2/credentials/authorize')[0].body).not.toHaveProperty('PIN');
    });

    it('rejects an authorisation that returns no SAD', async () => {
      installCscMockProvider({
        '/oauth2/token': tokenRoute(),
        '/csc/v2/credentials/authorize': () => ({ body: { expiresIn: 300 } }),
      });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(client.authorize({ credentialID: 'cred-1', hashes: ['aGFzaA=='] })).rejects.toThrow(
        /no Signature Activation Data/,
      );
    });

    it('rejects an authorisation with no hashes', async () => {
      installCscMockProvider({ '/oauth2/token': tokenRoute() });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(client.authorize({ credentialID: 'cred-1', hashes: [] })).rejects.toThrow(/at least one hash/);
    });
  });

  describe('signatures/signHash', () => {
    it('sends the SAD, hashes and algorithm OIDs, and decodes the signatures', async () => {
      const signature = new Uint8Array([1, 2, 3, 4, 5]);

      const provider = installCscMockProvider({
        '/oauth2/token': tokenRoute(),
        '/csc/v2/signatures/signHash': () => ({ body: { signatures: [base64(signature)] } }),
      });

      const client = createCscClient(CLIENT_OPTIONS);

      const signatures = await client.signHash({
        credentialID: 'cred-1',
        sad: 'sad-value',
        hashes: ['aGFzaA=='],
        hashAlgorithmOid: '2.16.840.1.101.3.4.2.1',
        signAlgorithmOid: '1.2.840.113549.1.1.1',
      });

      expect(signatures).toEqual([signature]);

      expect(provider.requestsTo('/csc/v2/signatures/signHash')[0].body).toMatchObject({
        credentialID: 'cred-1',
        SAD: 'sad-value',
        hash: ['aGFzaA=='],
        hashAlgo: '2.16.840.1.101.3.4.2.1',
        signAlgo: '1.2.840.113549.1.1.1',
      });
    });

    it('omits hashAlgo when the signature algorithm already names a digest', async () => {
      const provider = installCscMockProvider({
        '/oauth2/token': tokenRoute(),
        '/csc/v2/signatures/signHash': () => ({ body: { signatures: [base64(new Uint8Array([9]))] } }),
      });

      const client = createCscClient(CLIENT_OPTIONS);

      await client.signHash({
        credentialID: 'cred-1',
        sad: 'sad-value',
        hashes: ['aGFzaA=='],
        signAlgorithmOid: '1.2.840.10045.4.3.2',
      });

      expect(provider.requestsTo('/csc/v2/signatures/signHash')[0].body).not.toHaveProperty('hashAlgo');
    });

    it('rejects a response whose signature count does not match the hash count', async () => {
      installCscMockProvider({
        '/oauth2/token': tokenRoute(),
        '/csc/v2/signatures/signHash': () => ({ body: { signatures: [] } }),
      });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(
        client.signHash({ credentialID: 'cred-1', sad: 'sad', hashes: ['aGFzaA=='], signAlgorithmOid: '1.2.840' }),
      ).rejects.toThrow(/returned 0 signatures for 1 hashes/);
    });

    it('rejects an empty signature value', async () => {
      installCscMockProvider({
        '/oauth2/token': tokenRoute(),
        '/csc/v2/signatures/signHash': () => ({ body: { signatures: [''] } }),
      });

      const client = createCscClient(CLIENT_OPTIONS);

      await expect(
        client.signHash({ credentialID: 'cred-1', sad: 'sad', hashes: ['aGFzaA=='], signAlgorithmOid: '1.2.840' }),
      ).rejects.toThrow(/signature that is not a non-empty string/);
    });
  });

  describe('secret hygiene', () => {
    it('keeps the bearer token, SAD and PIN out of error messages', async () => {
      installCscMockProvider({
        '/oauth2/token': tokenRoute('super-secret-token'),
        '/csc/v2/credentials/authorize': () => ({ body: { SAD: 'super-secret-sad' } }),
        '/csc/v2/signatures/signHash': () => ({ status: 500, body: { error: 'internal_error' } }),
      });

      const client = createCscClient(CLIENT_OPTIONS);

      const { sad } = await client.authorize({ credentialID: 'cred-1', hashes: ['aGFzaA=='], pin: 'secret-pin' });

      const error = await client
        .signHash({ credentialID: 'cred-1', sad, hashes: ['aGFzaA=='], signAlgorithmOid: '1.2.840' })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(CscError);
      expect(String(error)).not.toContain('super-secret-token');
      expect(String(error)).not.toContain('super-secret-sad');
      expect(String(error)).not.toContain('secret-pin');
    });
  });
});
