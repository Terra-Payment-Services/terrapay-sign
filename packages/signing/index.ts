import {
  NEXT_PRIVATE_SIGNING_TRANSPORT,
  NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER,
  NEXT_PUBLIC_SIGNING_CONTACT_INFO,
  NEXT_PUBLIC_SIGNING_REASON,
  NEXT_PUBLIC_WEBAPP_URL,
} from '@documenso/lib/constants/app';
import type { DigestAlgorithm, PDF, Signer, SignWarning } from '@libpdf/core';
import { match } from 'ts-pattern';

import { assertSignerHonoursDigest } from './helpers/digest-guard';
import { createValidatingRevocationProvider } from './helpers/revocation/provider';
import { getTimestampAuthority } from './helpers/tsa';
import { createCscSigner } from './transports/csc';
import { createGoogleCloudSigner } from './transports/google-cloud';
import { createLocalSigner } from './transports/local';

export type SignOptions = {
  pdf: PDF;
};

/**
 * The digest every signature we produce declares and is computed under.
 *
 * Stated here rather than left to the library default so that the value the
 * startup guard checks is the same value we hand to `pdf.sign`.
 */
export const SIGNING_DIGEST_ALGORITHM: DigestAlgorithm = 'SHA-256';

let signer: Signer | null = null;

const getSigner = async () => {
  if (signer) {
    return signer;
  }

  const transport = NEXT_PRIVATE_SIGNING_TRANSPORT();

  const candidate = await match(transport)
    .with('local', async () => await createLocalSigner())
    .with('gcloud-hsm', async () => await createGoogleCloudSigner())
    .with('remote-csc', async () => await createCscSigner())
    .otherwise(() => {
      throw new Error(`Unsupported signing transport: ${transport}`);
    });

  // The local signer holds the key, so exercising it costs nothing and happens
  // once per process. Remote transports bill per signature and are trusted to
  // reject a digest they cannot honour, which CscSigner does in its own sign().
  //
  // Checked before it is cached, not after. Assigning first meant a signer that
  // failed this guard was still in the module global, so the next attempt in
  // the same process returned it from the cache above without re-running the
  // check, and emitted exactly the signature the guard had rejected.
  if (transport === 'local') {
    await assertSignerHonoursDigest(candidate, SIGNING_DIGEST_ALGORITHM);
  }

  // eslint-disable-next-line require-atomic-updates
  signer = candidate;

  return signer;
};

export const signPdf = async ({ pdf }: SignOptions) => {
  const signer = await getSigner();

  const tsa = getTimestampAuthority();

  const revocationProvider = createValidatingRevocationProvider();

  const { bytes, warnings } = await pdf.sign({
    signer,
    reason: NEXT_PUBLIC_SIGNING_REASON(),
    location: NEXT_PUBLIC_WEBAPP_URL(),
    contactInfo: NEXT_PUBLIC_SIGNING_CONTACT_INFO(),
    subFilter: NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER() ? 'adbe.pkcs7.detached' : 'ETSI.CAdES.detached',
    digestAlgorithm: SIGNING_DIGEST_ALGORITHM,
    timestampAuthority: tsa ?? undefined,
    longTermValidation: !!tsa,
    revocationProvider,
    archivalTimestamp: !!tsa,
    // A B-LTA signature (signer chain + RFC 3161 timestamp token + LTV
    // revocation data) can exceed the 12288-byte default placeholder,
    // depending on the signing certificate chain and the TSA responder.
    // The unused portion is zero-padding, so over-reserving is cheap.
    estimatedSize: tsa ? 32768 : undefined,
  });

  // @libpdf/core swallows anything a revocation provider throws, so the point
  // where a revoked or unverifiable chain stops the operation has to be here,
  // before the caller ever sees the bytes. See helpers/revocation/provider.ts.
  // Tell it whether anything was supposed to happen. Without a timestamp
  // authority libpdf asks for no revocation data at all, so an empty ledger is
  // expected; with one, an empty ledger means the check silently did not run.
  revocationProvider.assertComplete({ expectChecks: !!tsa });

  reportSigningWarnings(warnings);

  return bytes;
};

/**
 * Surface what the signing library reported.
 *
 * These were previously discarded, which matters most for `MDP_VIOLATION`. That
 * code is raised whenever the incoming document already carries a certification
 * signature, which is what DocuSign and Adobe apply. The name overstates it: the
 * check only looks for the presence of a certification and never reads the
 * permission level saying what the certifier allowed. Most certifications permit
 * later signatures, which is the point of sending a document out to be signed,
 * so this is usually benign.
 *
 * It is worth seeing rather than swallowing, because the case that is not benign,
 * a certification permitting no changes at all, produces a document a reader will
 * flag, and we would otherwise have no idea we had produced it.
 */
const reportSigningWarnings = (warnings: SignWarning[] | undefined): void => {
  for (const warning of warnings ?? []) {
    if (warning.code === 'MDP_VIOLATION') {
      console.warn(
        '[signing] the document already carried a certification signature. Ours was appended as an ' +
          'incremental update, which a certification usually permits, but the permitted level was ' +
          'not read. Check the result in a reader before relying on it.',
      );

      continue;
    }

    console.warn(`[signing] ${warning.code}: ${warning.message}`);
  }
};
