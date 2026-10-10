import { z } from 'zod';

import { NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL, NEXT_PRIVATE_ENTRA_LOGIN_BASE_URL } from '../../constants/app';
import { AppError, AppErrorCode } from '../../errors/app-error';
import type { GraphFetchFn, MicrosoftGraphCredentials } from '../microsoft-graph/graph-auth';
import { clearGraphTokenCache, getGraphAccessToken, readGraphErrorCode } from '../microsoft-graph/graph-auth';

/**
 * Microsoft Graph client used by the Entra ID access reconciliation job.
 *
 * Authentication is app-only (OAuth 2.0 client credentials) and lives in
 * `../microsoft-graph/graph-auth`, shared with the SharePoint archive so that
 * the two features cannot drift into two token caches. Reading every user in
 * the tenant needs the `User.Read.All` application permission with admin
 * consent. Reading the transitive membership of an access group, which is used
 * instead when one is configured, needs `GroupMember.Read.All` as well.
 *
 * Neither the client secret nor the bearer token is ever logged, returned in a
 * result, or included in a thrown error message. Errors carry the HTTP status
 * and the Graph error code only.
 */

/**
 * Graph caps `$top` at 999 for directory objects.
 */
const GRAPH_PAGE_SIZE = 999;

/**
 * Hard ceiling on the number of pages followed in a single call. At 999 members
 * a page this allows roughly half a million members, far above any plausible
 * directory, and stops a malformed or looping `@odata.nextLink` from spinning
 * forever.
 */
const GRAPH_MAX_PAGES = 500;

/**
 * How long one page request may take before the read is abandoned. Without it
 * a page that never answers holds the run for as long as the HTTP client's own
 * limit allows, which in the e2e run outlasted three attempts in eight minutes,
 * and the run looks hung rather than failed.
 */
const GRAPH_REQUEST_TIMEOUT_MS = 60_000;

export type EntraCredentials = MicrosoftGraphCredentials;

/**
 * The next page to read, from a page's `@odata.nextLink`, or null when there is
 * none. A link is followed only if it is an HTTPS URL on the Graph origin in
 * use, because the request carries the bearer token. Any other link, an empty
 * one included, throws before anything is sent to it, and the error carries no
 * part of the link, which can hold a continuation token or worse.
 */
const nextPageUrl = (nextLink: string | null | undefined, graphOrigin: string): string | null => {
  if (nextLink === null || nextLink === undefined) {
    return null;
  }

  let parsed: URL | null = null;

  try {
    parsed = new URL(nextLink);
  } catch {
    parsed = null;
  }

  if (!parsed || parsed.protocol !== 'https:' || parsed.origin !== graphOrigin) {
    throw new AppError(AppErrorCode.SCHEMA_FAILED, {
      message:
        'Microsoft Graph returned a continuation link that is not an HTTPS URL on the Graph origin in use. ' +
        'Refusing to follow it or to reconcile against a partial directory read.',
    });
  }

  return nextLink;
};

export type EntraDirectoryMember = {
  id: string;
  mail: string | null;
  userPrincipalName: string | null;
  accountEnabled: boolean;
};

type FetchFn = GraphFetchFn;

const ZGraphMemberSchema = z.object({
  id: z.string(),
  mail: z.string().nullish(),
  userPrincipalName: z.string().nullish(),
  accountEnabled: z.boolean().nullish(),
  '@odata.type': z.string().nullish(),
});

const ZGraphMembersResponseSchema = z.object({
  value: z.array(ZGraphMemberSchema),
  '@odata.nextLink': z.string().nullish(),
});

/**
 * Drop every cached access token. Exported for tests and for the rare case
 * where credentials are rotated inside a running process.
 */
export const clearEntraTokenCache = clearGraphTokenCache;

export type GetEntraAccessTokenOptions = {
  credentials: EntraCredentials;
  fetchFn?: FetchFn;
  now?: () => number;
};

/**
 * Acquire an app-only access token for Microsoft Graph.
 */
export const getEntraAccessToken = getGraphAccessToken;

export type FetchEntraGroupMembersOptions = {
  groupId: string;
  credentials: EntraCredentials;
  fetchFn?: FetchFn;
  now?: () => number;
};

/**
 * Read every user in the access group, following nested groups.
 *
 * `transitiveMembers` is used rather than `members` so that a directory which
 * grants access through nested groups still resolves to the full set of people.
 * The response is paged, and every page is followed to completion. A failure on
 * any page throws, because a partial membership list read as the whole truth
 * would look exactly like "almost everybody has left".
 */
export const fetchEntraGroupMembers = async ({
  groupId,
  credentials,
  fetchFn = fetch,
  now = () => Date.now(),
}: FetchEntraGroupMembersOptions): Promise<EntraDirectoryMember[]> => {
  const accessToken = await getEntraAccessToken({
    credentials,
    loginBaseUrl: NEXT_PRIVATE_ENTRA_LOGIN_BASE_URL(),
    fetchFn,
    now,
  });

  const graphBaseUrl = `${NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL()}/v1.0`;
  const graphOrigin = new URL(graphBaseUrl).origin;

  const members: EntraDirectoryMember[] = [];

  const select = ['id', 'mail', 'userPrincipalName', 'accountEnabled'].join(',');

  let url: string | null =
    `${graphBaseUrl}/groups/${encodeURIComponent(groupId)}/transitiveMembers` +
    `?$select=${select}&$top=${GRAPH_PAGE_SIZE}`;

  let pagesRead = 0;

  while (url) {
    if (pagesRead >= GRAPH_MAX_PAGES) {
      throw new AppError(AppErrorCode.LIMIT_EXCEEDED, {
        message: `Microsoft Graph returned more than ${GRAPH_MAX_PAGES} pages of group members`,
      });
    }

    const response: Response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message:
          `Microsoft Graph transitiveMembers request failed with status ${response.status} ` +
          `(code: ${await readGraphErrorCode(response)})`,
      });
    }

    const parsed = ZGraphMembersResponseSchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new AppError(AppErrorCode.SCHEMA_FAILED, {
        message: 'Microsoft Graph transitiveMembers response did not match the expected shape',
      });
    }

    for (const member of parsed.data.value) {
      const odataType = member['@odata.type'];

      // An absent type is not "probably a user". Microsoft returns directory
      // objects carrying only a type and an id when the application cannot
      // read their properties, and treating those as users was the whole
      // failure: they match no Documenso account, so the people they stand for
      // look absent from the group and get disabled, while the member count
      // still clears the floor because the objects were counted.
      if (!odataType) {
        throw new AppError(AppErrorCode.SCHEMA_FAILED, {
          message:
            `Microsoft Graph returned member ${member.id} with no @odata.type, so it cannot be classified. ` +
            'Refusing to reconcile against a directory read this incomplete.',
        });
      }

      // A transitive membership collection is heterogeneous: nested groups,
      // service principals and devices come back alongside users. Only users
      // can hold a Documenso account.
      if (odataType !== '#microsoft.graph.user') {
        continue;
      }

      // A user we cannot name is a user we cannot match, and an unmatched user
      // is indistinguishable from one who has left. Fail the whole run rather
      // than quietly carry an unidentifiable member into a disable decision.
      if (!member.mail && !member.userPrincipalName) {
        throw new AppError(AppErrorCode.SCHEMA_FAILED, {
          message:
            `Microsoft Graph returned user ${member.id} with neither mail nor userPrincipalName. ` +
            'Refusing to reconcile, because an unidentifiable member is indistinguishable from an absent one.',
        });
      }

      members.push({
        id: member.id,
        mail: member.mail ?? null,
        userPrincipalName: member.userPrincipalName ?? null,
        // Only an explicit `true` is enabled. A null or absent `accountEnabled`
        // vouches for nobody, so such a member keeps no account and does not
        // count toward the minimum, as on the users read.
        accountEnabled: member.accountEnabled === true,
      });
    }

    pagesRead += 1;

    url = nextPageUrl(parsed.data['@odata.nextLink'], graphOrigin);
  }

  return members;
};

const ZGraphTenantUserSchema = z.object({
  id: z.string(),
  mail: z.string().nullish(),
  userPrincipalName: z.string().nullish(),
  accountEnabled: z.boolean().nullish(),
  userType: z.string().nullish(),
});

const ZGraphTenantUsersResponseSchema = z.object({
  value: z.array(ZGraphTenantUserSchema),
  '@odata.nextLink': z.string().nullish(),
});

export type FetchEntraTenantUsersOptions = {
  credentials: EntraCredentials;
  fetchFn?: FetchFn;
  now?: () => number;
};

/**
 * Read every member user in the tenant, for a deployment where anybody with an
 * enabled account in the directory may use the instance.
 *
 * Guest accounts are left out, so a Documenso account whose address belongs to
 * a guest is treated as absent from the directory. A guest is somebody else's
 * employee invited into this tenant, and holding a guest account is not what
 * entitles anybody to this instance.
 *
 * As with the group read, every page is followed to completion and a failure on
 * any page throws rather than returning a partial list.
 */
export const fetchEntraTenantUsers = async ({
  credentials,
  fetchFn = fetch,
  now = () => Date.now(),
}: FetchEntraTenantUsersOptions): Promise<EntraDirectoryMember[]> => {
  const accessToken = await getEntraAccessToken({
    credentials,
    loginBaseUrl: NEXT_PRIVATE_ENTRA_LOGIN_BASE_URL(),
    fetchFn,
    now,
  });

  const graphBaseUrl = `${NEXT_PRIVATE_ENTRA_GRAPH_BASE_URL()}/v1.0`;
  const graphOrigin = new URL(graphBaseUrl).origin;

  const members: EntraDirectoryMember[] = [];

  const select = ['id', 'mail', 'userPrincipalName', 'accountEnabled', 'userType'].join(',');

  let url: string | null = `${graphBaseUrl}/users?$select=${select}&$top=${GRAPH_PAGE_SIZE}`;

  let pagesRead = 0;

  while (url) {
    if (pagesRead >= GRAPH_MAX_PAGES) {
      throw new AppError(AppErrorCode.LIMIT_EXCEEDED, {
        message: `Microsoft Graph returned more than ${GRAPH_MAX_PAGES} pages of tenant users`,
      });
    }

    const response: Response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message:
          `Microsoft Graph users request failed with status ${response.status} ` +
          `(code: ${await readGraphErrorCode(response)})`,
      });
    }

    const parsed = ZGraphTenantUsersResponseSchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new AppError(AppErrorCode.SCHEMA_FAILED, {
        message: 'Microsoft Graph users response did not match the expected shape',
      });
    }

    // `/users` is a collection of users only, so there is no `@odata.type` to
    // classify by, unlike the heterogeneous `transitiveMembers` collection.
    for (const user of parsed.data.value) {
      if (!user.mail && !user.userPrincipalName) {
        throw new AppError(AppErrorCode.SCHEMA_FAILED, {
          message:
            `Microsoft Graph returned user ${user.id} with neither mail nor userPrincipalName. ` +
            'Refusing to reconcile, because an unidentifiable user is indistinguishable from an absent one.',
        });
      }

      // Only an explicit `Guest` is excluded. An absent `userType` is read as
      // a member, because reading it as a guest would disable somebody on a
      // field Graph did not fill in, and leaving an account alone is the safe
      // direction of failure.
      if (user.userType === 'Guest') {
        continue;
      }

      members.push({
        id: user.id,
        mail: user.mail ?? null,
        userPrincipalName: user.userPrincipalName ?? null,
        // Only an explicit `true` is enabled. A null or absent `accountEnabled`
        // vouches for nobody: such a user keeps no account and does not count
        // toward the minimum, so a Graph that stopped returning the field
        // trips the floor rather than either locking everybody out or keeping
        // leavers in.
        accountEnabled: user.accountEnabled === true,
      });
    }

    pagesRead += 1;

    url = nextPageUrl(parsed.data['@odata.nextLink'], graphOrigin);
  }

  return members;
};
