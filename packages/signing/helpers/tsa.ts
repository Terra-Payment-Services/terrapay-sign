import {
  NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY,
  NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY_KEY_SHA256,
} from '@documenso/lib/constants/app';
import { once } from 'remeda';

import { VerifyingTimestampAuthority } from './timestamp/authority';

const KEY_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Read the pinned timestamp keys.
 *
 * @throws when any entry is not a SHA-256 hash, so a typo stops signing
 *   loudly rather than leaving the pin silently off.
 */
export const parsePinnedKeys = (value: string | undefined): string[] => {
  const pins = (value ?? '')
    .split(',')
    .map((entry) => entry.replace(/[\s:]/g, '').toLowerCase())
    .filter(Boolean);

  for (const pin of pins) {
    if (!KEY_HASH_PATTERN.test(pin)) {
      throw new Error(
        'NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY_KEY_SHA256 must list SHA-256 hashes of SubjectPublicKeyInfo: ' +
          '64 hex characters each, colons optional, separated by commas.',
      );
    }
  }

  return pins;
};

const setupTimestampAuthorities = once(() => {
  const timestampAuthority = NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY();

  if (!timestampAuthority) {
    return null;
  }

  const pinnedKeySha256 = parsePinnedKeys(NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY_KEY_SHA256());

  const timestampAuthorities = timestampAuthority
    .trim()
    .split(',')
    .filter(Boolean)
    .map((url) => {
      // Deliberately not libpdf's HttpTimestampAuthority. That one accepts a
      // token on the HTTP status and the ASN.1 shape alone, never checking the
      // signature, the certificate, the imprint or the nonce, so anything able
      // to answer for the authority could set the time our documents claim.
      // See timestamp/verify.ts.
      return new VerifyingTimestampAuthority(url, { pinnedKeySha256 });
    });

  return timestampAuthorities;
});

export const getTimestampAuthority = () => {
  const authorities = setupTimestampAuthorities();

  if (!authorities) {
    return null;
  }

  // Pick a random authority
  return authorities[Math.floor(Math.random() * authorities.length)];
};
