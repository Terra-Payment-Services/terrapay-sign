import { pinnedFetch } from '@documenso/lib/server-only/http/pinned-fetch';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createValidatingRevocationProvider } from './provider';
import { buildOcspResponse, createTestPki, fixedLookup, type TestPki } from './test-support';

// The pinned transport is replaced so the test can see what reaches it without
// sending anything off the machine. Responder addresses have to be public, so a
// loopback server cannot stand in here the way it does for OpenID.
vi.mock('@documenso/lib/server-only/http/pinned-fetch', () => ({ pinnedFetch: vi.fn() }));

const OCSP_URL = 'http://ocsp.example.test/';
const CRL_URL = 'http://crl.example.test/ca.crl';
const RESPONDER_ADDRESS = '198.51.101.10';

let pki: TestPki;

beforeAll(async () => {
  pki = await createTestPki({ ocspUrl: OCSP_URL, crlUrl: CRL_URL });
});

describe('the revocation provider without an injected fetch', () => {
  it('sends the OCSP request through the pinned transport to the checked address', async () => {
    const response = await buildOcspResponse({
      certificate: pki.leaf.certificate,
      issuer: pki.ca.certificate,
      responder: pki.responder,
    });

    vi.mocked(pinnedFetch).mockResolvedValue(new Response(response.slice() as unknown as BodyInit, { status: 200 }));

    const provider = createValidatingRevocationProvider({ mode: 'strict', lookup: fixedLookup(RESPONDER_ADDRESS) });

    await expect(provider.getOCSP(pki.leaf.der, pki.ca.der)).resolves.toEqual(response);

    expect(vi.mocked(pinnedFetch)).toHaveBeenCalledWith(OCSP_URL, expect.any(Object), [RESPONDER_ADDRESS]);
  });
});
