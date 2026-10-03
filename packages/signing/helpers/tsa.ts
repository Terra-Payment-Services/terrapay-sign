import { NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY } from '@documenso/lib/constants/app';
import { once } from 'remeda';

import { VerifyingTimestampAuthority } from './timestamp/authority';

const setupTimestampAuthorities = once(() => {
  const timestampAuthority = NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY();

  if (!timestampAuthority) {
    return null;
  }

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
      return new VerifyingTimestampAuthority(url);
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
