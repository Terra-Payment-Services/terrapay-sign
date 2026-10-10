# Account matching: failure modes

Copied from `packages/app-tests/e2e/directory-sync/MATCHING-FAILURE-MODES.md`. Written from the specification of this change alone, before any isolated test and without reading the implementation. It treats the matching rules as a module of their own: given the directory as Graph returned it, the Sign accounts with their Microsoft Account rows, the exempt list and the limits, decide who is kept and who is disabled. One line per way that decision could come out wrong. Reviewed and approved by Ram on 2026-10-06, with the decisions below for the entries the specification left open.

"Identity" below means the object id (`oid`) and tenant (`tid`) read from a stored Entra id_token. The specification fixes these rules and nothing finer: an account with a Microsoft identity is kept only if that identity is an enabled member (criteria 1 to 3); an account without one is matched by address, against mail and sign-in name (criteria 2, 4); comparison ignores case and surrounding whitespace (5); admins, the two service accounts and exempt addresses are never disabled (6 to 8); guests keep nothing (9); disabled accounts are untouched (10). Where a line depends on a rule the specification leaves open, it says so.

## Decisions (approved by Ram, 2026-10-06)

- **9.** Object ids compare case-insensitively and ignoring surrounding braces, as GUIDs.
- **15.** A token from another tenant is ignored as an identity. The account is then matched by email, as if no identity were stored.
- **16.** A malformed token, or one with no `oid`, falls back to email matching. A bad token on one account never aborts the run.
- **21.** An account with several in-tenant identities is kept if any one of them is an enabled member.
- **49.** The disable ratio's denominator is only the accounts the sync could disable. It excludes admins, the two service accounts, exempt accounts and already-disabled accounts.
- **58.** An already-disabled account that reappears as an enabled member stays disabled.

## Identity extraction from the stored token

1. A token with a valid `oid` from our tenant is ignored and the account falls back to address matching, so a renamed member is disabled (F1).
2. The `oid` is read from `sub` instead; `sub` is pairwise per application and never equals Graph's `id`, so every Microsoft user looks like a leaver.
3. The `oid` is read from the wrong token part (header or signature) or the payload is decoded as standard base64 rather than base64url, so tokens containing `-` or `_` fail to decode.
4. Base64url padding is required, so a correctly unpadded payload is rejected as malformed.
5. A token with two parts, four parts, an empty payload, or non-base64 text throws and aborts the whole run, rather than being treated as no identity for that one account.
6. A payload that decodes to valid JSON but not an object (`null`, a number, an array, a string) throws, or is read as having claims.
7. `oid` present but not a string (number, object, array, `true`) is coerced with `String()` and compared, so `{"oid": ["<id>"]}` matches.
8. `oid` an empty string or whitespace is treated as an identity that matches a directory entry with an empty or missing `id`.
9. `oid` with different case or braces from Graph's `id` (`{6F1C...}` against `6f1c...`) is judged a different person, disabling a member. Specification silent on whether ids are compared case-insensitively; GUIDs are case-insensitive by definition. Decision: compare case-insensitively, ignoring surrounding braces.
10. `tid` missing is treated as our tenant, so a token of unknown origin is trusted (F8).
11. `tid` from another tenant is trusted because its `oid` matches one of our members (F8).
12. `tid` compared case-sensitively against a configured tenant id written in upper case, so every token from our own tenant is distrusted and every Microsoft user is matched by address only, or disabled.
13. `tid` compared against the issuer's tenant segment only, or against `iss` as a string, so a token whose `iss` names our tenant while `tid` names another is trusted (or the reverse).
14. The tenant is taken from the Account row's `issuer` column alone, which is null on rows written before that column existed, so older rows are mishandled one way or the other.
15. A token with a well-formed identity from another tenant falls back to address matching and is kept by a member who holds the same address. Specification silent: F8 says the identity must not be trusted, not whether the address may still keep the account. Decision: the foreign identity is ignored and the account is matched by email as if it had none, so a member holding the address keeps it.
16. A malformed token, or one with no `oid`, falls back to address matching (or is disabled). Specification silent on which; the decision must at least be the same on every run and must not abort the run for everyone. Decision: fall back to email matching; a bad token on one account never aborts the run.
17. A token's signature or expiry is checked, so every stored token (expired since sign-in) is discarded and every Microsoft user is matched by address only.
18. The provider label is matched exactly as `microsoft` and a row under another label (or a renamed label) is ignored, or rows from another OIDC provider are read as Microsoft identities.

## Several Microsoft rows on one user

19. Only the first row is read, so a user whose first row is from another tenant (or malformed) and whose second is a valid member identity is disabled.
20. Any matching row keeps the account, so a valid foreign-tenant row whose `oid` collides keeps a leaver (F8).
21. One in-tenant row for an enabled member and one in-tenant row for a gone member: the specification does not say whether any enabled identity keeps the account or every identity must be enabled. Decision: kept if any one in-tenant identity is an enabled member.
22. Rows are read in an unstable order, so the decision for a user with two rows differs between runs.

## Address matching (accounts with no identity)

23. Only `mail` is compared, so a member with no mailbox (`mail` null, sign-in name set) does not keep the account.
24. Only `userPrincipalName` is compared, so a member whose sign-in name differs from their mail address does not keep the account.
25. A null `mail` is turned into the string `"null"` or `""` and matches a Sign account with that address.
26. Case is folded with `toLowerCase` on one side only, or not at all (F7).
27. Whitespace is trimmed on one side only, or internal whitespace is also stripped, so `a b@x` matches `ab@x`.
28. Non-ASCII case folding (`İ`, `ß`, Kelvin sign) differs between the two sides' normalisation, so an address matches, or fails to match, depending on locale.
29. Plus-addressing or dots are normalised away, so `jo+old@x` is kept by the member `jo@x`. The specification asks for case and whitespace only.
30. A guest's address (`mail` `bob@partner.com`, sign-in name `bob_partner.com#EXT#@tenant.onmicrosoft.com`) keeps a Sign account with that address (criterion 9).
31. A disabled Entra user's address keeps a Sign account.
32. An address held by an enabled member keeps an account that has a Microsoft identity whose `oid` is gone (criterion 3, F2): the address is consulted when the identity has already decided.
33. The address keeps an account whose identity is a guest or disabled user, because the address happens to belong to a different enabled member.
34. Two directory entries share an address (a member and a guest, or a disabled and an enabled user) and the later one overwrites the earlier in a lookup map, so the outcome depends on page order.
35. `proxyAddresses` or `otherMails` are consulted without the specification asking for it, so an alias keeps an account.

## Directory membership

36. `userType` missing from the response (not selected) is read as Member, so guests are kept.
37. `accountEnabled` missing from the response (not selected) is read as enabled, or as disabled, so either everyone is kept or everyone is a leaver.
38. `userType` compared case-sensitively (`member` against `Member`).
39. A member with `accountEnabled: null` treated as enabled.

## Exemptions and privileged accounts

40. Exempt list split on `,` without trimming, so ` ops@x` never matches.
41. Exempt list compared case-sensitively, though the specification says any case.
42. An empty entry (`a@x,,b@x` or a trailing comma) becomes `""` and matches an account with an empty or null address, or every account.
43. The exempt list matched against the directory address rather than the Sign address, so an exempt account renamed in Entra loses its exemption, or the reverse.
44. Service accounts recognised by their migration-time addresses (`serviceaccount@documenso.com`) rather than the addresses the server renames them to at start (`serviceaccount@<host>`), so after start-up they are disabled.
45. Service accounts recognised by address alone, so a person who registers that address is never disabled. (The sign-in callback refuses those addresses, but address matching would still exempt a pre-existing row.)
46. Admin status read from a single role value rather than the `roles` array, so a user with `[USER, ADMIN]` is disabled.

## Disable limit and minimum

47. Exempt accounts counted as accounts to disable, so a run with many exempt non-members stops when it should act (criterion 8).
48. Exempt accounts counted in the denominator, inflating it so a run that should stop goes ahead (F5).
49. Admins, service accounts or already-disabled accounts counted in the denominator. The specification does not say which accounts are "considered"; each choice moves the threshold, and the choice has to be stated. Decision: the denominator excludes admins, the two service accounts, exempt accounts and already-disabled accounts.
50. The comparison is `>=` where the specification says exactly the ratio is allowed, or the ratio is computed by float division and `3/30` style ties land on the wrong side. Comparing `toDisable <= ratio * considered` has its own float error (`0.1 * 3`); an integer form such as `toDisable * 10 <= considered * 10 * ratio` rounded once is safer.
51. Zero considered accounts divides by zero; `NaN > ratio` is false, so the run goes ahead.
52. The minimum compared with `<=` instead of `<`, so exactly the minimum stops the run (criterion 12).
53. The minimum counted over everything Graph returned (guests, disabled users) instead of enabled members, so a tenant that lost its members but kept its guests passes.
54. The minimum counted after deduplication or after removing exempt addresses, so it is checked against a different number than the directory returned.
55. A non-numeric, blank or fractional setting parsed with `parseInt` or `Number` and producing `NaN`, `0`, or a truncated value that switches the check off (F5). `parseInt('1e3')` is 1; `Number('')` is 0; `Number('Infinity')` passes `isNaN`.
56. A ratio above 1 or `Infinity` accepted outside production, so the limit never applies.

## Already-disabled accounts

57. A disabled account is re-disabled, which expires tokens and disables webhooks that someone re-enabled deliberately (criterion 10: left as they are).
58. A disabled account that reappears as an enabled member is re-enabled. The specification says left as they are. Decision: it stays disabled.
59. Disabled accounts counted as accounts to disable, pushing a run over the limit.

## Determinism and data handling

60. The decision depends on page order or map iteration order, so the same directory gives different results on two runs.
61. A leaver's full id_token, or the Graph access token, is written to the log when the run reports who it would disable.
62. The dry-run report names accounts by internal id only, so an operator cannot tell who would be disabled.

## Added by mutation testing (2026-10-06)

Stryker run against `reconcile-directory-access.ts` with the isolated suite showed that nothing in entries 1 to 62 pinned the behaviours below. The specification covers 63 (criterion 14); 64 to 67 are reporting and partial-failure behaviours the specification does not fix. Ram approved 63 to 67 on 2026-10-06. Entries 68 to 70 came from a second run, after the fixes for 8, 9, 12 and 53 added object-id normalisation.

63. A failed directory read (a thrown error from the Graph read) is treated as an empty or partial directory and the run disables accounts, or the failure is not logged (criterion 14, F4). Approved by Ram, 2026-10-06.
64. A run stopped by a safety limit does not say in the log why it stopped: which accounts it would have disabled, or how many members the directory returned against the minimum. Approved by Ram, 2026-10-06.
65. One account that cannot be disabled (a database error) aborts the rest of the run, or is reported as disabled instead of failed. Approved by Ram, 2026-10-06.
66. The run's result misreports what happened: a stopped run lists accounts as disabled or omits those it would have disabled, or admins and exempt accounts are miscounted (an exempt admin counted as both). Approved by Ram, 2026-10-06.
67. A live run disables an account without logging which, so there is no audit trail of who the sync disabled. Approved by Ram, 2026-10-06.

68. A stored object id, or a directory id, with surrounding whitespace (`' 6f1c... '`, or `' { 6F1C... } '`) is judged a different person, disabling a member. Expected: whitespace around the id, and around the id inside surrounding braces, is ignored. This is an inference from decision 9 and from criterion 5's trimming of addresses, not a decision Ram has made.
69. Braces that do not surround the whole id (`{6f1c...` or `6f1c...}`, or text outside the braces as in `6f1c0001-{1111-...}` or `{6f1c0001-}1111-...`) are stripped as if they did, so a mangled id matches a member, or a member is matched through a different id. Expected, from decision 9: only a matching pair around the whole id is stripped, and anything else does not match.
70. An empty or blank id on either side (`''`, `'   '`, `'{}'`, `'{  }'`) normalises to the same nothing and keeps an account whose stored id is equally empty.

## Surviving mutants judged equivalent

Stryker score for the isolated suite after the fixes and entries 68 to 70: 84.34% (167 killed, 31 survived, 0 without coverage), with every test in the suite run. The earlier score of 84.30% (145 killed, 27 survived) was measured before the fixes, with the seven then-failing tests left out. Each survivor was judged as follows.

- Upper-casing instead of lower-casing addresses (one mutant). Equivalent within the specification, which asks only for case-insensitive comparison. It differs only for letters whose upper and lower forms are not a round trip, such as `ß`, where upper-casing would match `strasse` to `straße`. Whether that should match is a decision the specification has not made.
- Adding a null `mail` or `userPrincipalName` to the set of entitled addresses (two mutants). Equivalent: entry 25 shows an empty or `"null"` Sign address still does not match, so the guard is redundant.
- Token parsing: the empty segment list for a non-string token, the emptied `catch` around payload decoding, and the object check on the decoded payload (three mutants). Equivalent: entries 5, 6 and 7 still yield no identity through the later checks, without throwing.
- The zero-denominator guard and the `candidates > 0` guard on the disable limit (three mutants). Equivalent: with no accounts considered there is nothing to disable (entry 51), and a ratio of zero never exceeds a non-negative maximum.
- Upper-casing instead of lower-casing object ids (one mutant). Equivalent: both sides go through the same normalisation, and a GUID's letters are `a` to `f`, whose cases round-trip.
- The null filter on normalised directory ids, removed or made always true (two mutants), and the `normalised !== null` guard on the stored side made always true (one mutant). Equivalent individually: entry 70's tests exercise the empty-id case, but each guard masks the removal of the other. A null in the directory set never meets a null stored id, because the stored side checks first, and the stored-side guard never sees a null in the set, because the filter removed it. Only both mutations together would let an empty id keep an account, and Stryker mutates one at a time.
- Log wording (eighteen mutants): the start and completion lines, the explanatory tail of the minimum and limit messages, the percentages in the limit message, and the closing words of the per-account lines. No behaviour depends on them beyond what 62, 64 and 67 pin. The percentages are a display defect at worst.
