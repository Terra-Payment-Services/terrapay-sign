/**
 * Binding a stored account to the authority that created it.
 *
 * `Account.provider` is our own label. It is 'microsoft' for the built-in
 * client, and the organisation's cuid for an enterprise SSO portal. Neither
 * name says anything about which authority issued the token, and the URL
 * behind the label is editable: an organisation manager sets `wellKnownUrl` on
 * the portal, and a deployment sets `NEXT_PRIVATE_MICROSOFT_TENANT` on the
 * built-in provider.
 *
 * Verifying `iss` against the discovery document at sign in closes the case
 * where two authorities are live under two labels at once. It cannot see the
 * case where one label is repointed after rows already exist under it. Then a
 * manager names an authority they control, mints a token carrying a subject
 * that belongs to somebody else, and the old lookup matches the victim's row on
 * the label and the subject and hands over their session.
 *
 * `Account.issuer` records the authority that created a row, so
 * the lookup can tell a returning person from a token that arrived under the
 * same label from somewhere else.
 */

/** The fields of an `Account` row this decision reads. */
export type AccountIssuerCandidate = {
  /** Our label for the configured authority. */
  provider: string;
  /** The `iss` recorded when the row was written, or null before the backfill. */
  issuer: string | null;
};

export type DecideAccountForIssuerOptions = {
  /** The label the person is signing in under. */
  provider: string;
  /** The `iss` the presented token was verified against. */
  issuer: string;
};

/**
 * What to do with the rows found for a subject.
 *
 * `adopt` means the row predates the issuer column and has to be stamped as it
 * is used, which is how an estate converges without a flag day.
 */
export type AccountIssuerDecision<T extends AccountIssuerCandidate> =
  | { action: 'use'; account: T }
  | { action: 'adopt'; account: T }
  | { action: 'refuse'; reason: string }
  | { action: 'none' };

/**
 * Choose the account a verified token may sign in to.
 *
 * Candidates are every row holding the subject under either this label or this
 * issuer. Both halves matter: the label finds the row an attacker is aiming at,
 * and the issuer finds the row that already belongs to this authority under a
 * different label.
 *
 * @param candidates - rows matching the subject on label or issuer
 * @param options - the label being signed in under and the verified issuer
 * @returns which row to use, whether it needs stamping, or why the sign in
 *   cannot continue
 */
export const decideAccountForIssuer = <T extends AccountIssuerCandidate>(
  candidates: T[],
  { provider, issuer }: DecideAccountForIssuerOptions,
): AccountIssuerDecision<T> => {
  const sameLabel = candidates.filter((candidate) => candidate.provider === provider);

  // The ordinary case. This authority wrote this row under this label, and the
  // person signing in is the person who owns it.
  const exact = sameLabel.find((candidate) => candidate.issuer === issuer);

  if (exact) {
    return { action: 'use', account: exact };
  }

  // The same authority and subject already recorded under another label. One
  // authority plus one subject is one person, and the unique index on
  // (issuer, providerAccountId) says so, which means writing or stamping a
  // second row here would collide. Refusing says what happened instead of
  // surfacing a constraint violation.
  const linkedElsewhere = candidates.find((candidate) => candidate.issuer === issuer);

  if (linkedElsewhere) {
    return {
      action: 'refuse',
      reason:
        `This identity is already linked to an account under the provider "${linkedElsewhere.provider}". ` +
        `Sign in there, or ask an administrator to unlink it before using "${provider}".`,
    };
  }

  // A row written before the issuer column existed. Nothing on it says which
  // authority produced it, so the label is all there is to go on. It is
  // accepted and stamped, and the backfill script exists so that this window
  // closes rather than lasting for as long as the estate does.
  const unstamped = sameLabel.find((candidate) => candidate.issuer === null);

  if (unstamped) {
    return { action: 'adopt', account: unstamped };
  }

  // The attack. The row under this label was written by one authority and the
  // token was signed by another, so whoever is at the far end of the current
  // configuration is not the person who owns this account.
  const mismatch = sameLabel.find((candidate) => candidate.issuer !== null);

  if (mismatch) {
    return {
      action: 'refuse',
      reason:
        `This account was linked through "${mismatch.issuer}" and the token presented came from "${issuer}". ` +
        `Refusing to sign in as the existing account.`,
    };
  }

  return { action: 'none' };
};

export type IdTokenIssuerResult = { ok: true; issuer: string } | { ok: false; reason: string };

/**
 * Read `iss` out of a stored ID token without calling anybody.
 *
 * This is for the backfill, where the question is which authority wrote a row
 * that already exists. The signature is not checked and cannot usefully be: the
 * token was verified against the authority's own key set when the row was
 * written, the keys have rotated since, and a row whose issuer we are recovering
 * is one nobody is signing in with right now.
 *
 * The alternative, reading the label and looking up whatever URL is configured
 * against it today, is the assumption this whole column exists to remove.
 *
 * @param idToken - the `id_token` column as stored, which may be absent
 * @returns the issuer, or the reason a person has to look at this row
 */
export const readIssuerFromIdToken = (idToken: string | null | undefined): IdTokenIssuerResult => {
  if (typeof idToken !== 'string' || idToken.length === 0) {
    return { ok: false, reason: 'No id_token stored' };
  }

  const segments = idToken.split('.');

  if (segments.length !== 3) {
    return { ok: false, reason: 'id_token is not a three part JWT' };
  }

  let payload: unknown;

  try {
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'id_token payload is not decodable JSON' };
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'id_token payload is not a JSON object' };
  }

  const issuer = (payload as Record<string, unknown>).iss;

  if (typeof issuer !== 'string' || issuer.length === 0) {
    return { ok: false, reason: 'id_token carries no iss claim' };
  }

  return { ok: true, issuer };
};
