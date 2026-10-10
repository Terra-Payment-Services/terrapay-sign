/**
 * Microsoft Graph and the Microsoft identity platform token endpoint, stood up
 * on loopback for one test.
 *
 * Only the published contract is honoured, so an implementation that relies on
 * something Microsoft does not promise fails here as it would against the real
 * service:
 *
 * - Token: `POST {login}/{tenant}/oauth2/v2.0/token`, form encoded, client
 *   credentials grant, `scope` ending in `/.default`. Errors use the
 *   identity platform's `{ error, error_description, error_codes }` shape.
 *   https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow
 * - Users: `GET {graph}/v1.0/users` with a bearer token from the endpoint
 *   above. `$filter` is evaluated against each user (string comparison is
 *   case-insensitive, as Graph's is for directory properties). `$select`
 *   projects; without it the response carries Graph's default user
 *   properties, which do not include `accountEnabled` or `userType`. `$top`
 *   is 1 to 999. Results are paged with an absolute `@odata.nextLink` that
 *   must be followed as given. Errors use Graph's `{ error: { code, message,
 *   innerError } }` shape.
 *   https://learn.microsoft.com/graph/api/user-list
 *   https://learn.microsoft.com/graph/paging
 *   https://learn.microsoft.com/graph/errors
 * - Group members: `GET {graph}/v1.0/groups/{id}/members` (direct) and
 *   `/transitiveMembers` (flattened through nested groups), each optionally
 *   cast to users with `/microsoft.graph.user`. Items are directoryObjects
 *   carrying `@odata.type`; nested groups appear as `#microsoft.graph.group`
 *   unless the cast drops them. `$select` and `$top` (1 to 999, default 100)
 *   work as for users. `$filter`, `$search`, `$orderby` and the cast are
 *   advanced queries: Graph requires `ConsistencyLevel: eventual` and
 *   `$count=true` with them, and so does the stub. Paging is by
 *   `@odata.nextLink`. An unknown group is 404 `Request_ResourceNotFound`.
 *   https://learn.microsoft.com/graph/api/group-list-members
 *   https://learn.microsoft.com/graph/api/group-list-transitivemembers
 *   https://learn.microsoft.com/graph/aad-advanced-queries
 *
 * Graph and login are separate servers on separate ports, so a client that
 * sends one to the other's setting is caught. Both speak HTTPS, as Microsoft
 * does, with a certificate made for this process; the Sign server trusts it
 * through NODE_EXTRA_CA_CERTS (see `caFile`). A third HTTPS server, "elsewhere",
 * stands for any host that is not Graph: it records whatever reaches it.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export type DirectoryUser = {
  id: string;
  displayName: string;
  mail: string | null;
  userPrincipalName: string;
  /** `null` is sent as null; leave it out with `absent`. */
  accountEnabled: boolean | null;
  userType: 'Member' | 'Guest';
  proxyAddresses?: string[];
  otherMails?: string[];
  /** Properties left out of every response, even when `$select` names them. */
  absent?: (keyof DirectoryUser)[];
};

export type Fault =
  | { kind: 'status'; status: number; body?: unknown; headers?: Record<string, string> }
  /** Accept the request and never answer it. */
  | { kind: 'hang' }
  /** Answer 200 with this exact body. */
  | { kind: 'body'; body: string; contentType?: string }
  /** Send the start of a valid page, then drop the connection. */
  | { kind: 'truncated' }
  /** Drop the connection without answering at all. */
  | { kind: 'reset' };

export type GraphStubOptions = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  users: DirectoryUser[];
  /** Largest page the stub will serve, whatever `$top` asks for. */
  maxPageSize?: number;
  tokenFault?: Fault;
  /** Fault for the nth page of a listing, counting the first page as 1. */
  pageFaults?: Record<number, Fault>;
  /** Awaited before page n is answered. */
  beforePage?: (page: number) => Promise<void>;
  /**
   * Groups by object id. A member is the id of a user in `users` or of another
   * group here.
   */
  groups?: Record<string, { displayName?: string; members: string[] }>;
  /**
   * Replace the `@odata.nextLink` of page n. Given the link the stub would
   * have sent and the origins in play; return the link to send instead.
   */
  nextLinkFor?: (page: number, link: string, origins: { graph: string; elsewhere: string }) => string;
};

export type TranscriptEntry = {
  at: string;
  server: 'login' | 'graph' | 'elsewhere';
  method: string;
  url: string;
  authorization?: string;
  body?: string;
  status?: number;
  page?: number;
  /** The client gave up before an answer was sent. */
  abandoned?: boolean;
};

const GRAPH_DEFAULT_USER_PROPERTIES = [
  'businessPhones',
  'displayName',
  'givenName',
  'jobTitle',
  'mail',
  'mobilePhone',
  'officeLocation',
  'preferredLanguage',
  'surname',
  'userPrincipalName',
  'id',
];

const FILTERABLE = new Set(['id', 'accountEnabled', 'userType', 'mail', 'userPrincipalName', 'displayName']);

class UnsupportedQuery extends Error {}

const graphError = (code: string, message: string) => ({
  error: {
    code,
    message,
    innerError: { date: new Date().toISOString(), 'request-id': randomUUID(), 'client-request-id': randomUUID() },
  },
});

const loginError = (error: string, code: number, description: string) => ({
  error,
  error_description: `AADSTS${code}: ${description}`,
  error_codes: [code],
  timestamp: new Date().toISOString(),
  trace_id: randomUUID(),
  correlation_id: randomUUID(),
});

// ── $filter ────────────────────────────────────────────────────────────────

type Token = { type: 'ident' | 'string' | 'literal' | 'op' | 'paren' | 'comma'; value: string };

const tokenise = (input: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }

    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch });
      i++;
      continue;
    }

    if (ch === "'") {
      let value = '';
      i++;

      for (;;) {
        if (i >= input.length) {
          throw new UnsupportedQuery('Unterminated string literal');
        }

        if (input[i] === "'" && input[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }

        if (input[i] === "'") {
          i++;
          break;
        }

        value += input[i];
        i++;
      }

      tokens.push({ type: 'string', value });
      continue;
    }

    const word = /^[A-Za-z_][A-Za-z0-9_/]*/.exec(input.slice(i));

    if (word) {
      const value = word[0];
      i += value.length;

      if (['eq', 'ne', 'and', 'or', 'not', 'in'].includes(value)) {
        tokens.push({ type: 'op', value });
      } else if (['true', 'false', 'null'].includes(value)) {
        tokens.push({ type: 'literal', value });
      } else {
        tokens.push({ type: 'ident', value });
      }

      continue;
    }

    throw new UnsupportedQuery(`Unexpected character ${ch}`);
  }

  return tokens;
};

type Predicate = (user: DirectoryUser) => boolean;

const parseFilter = (input: string): Predicate => {
  const tokens = tokenise(input);
  let pos = 0;

  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  const value = (): unknown => {
    const token = take();

    if (!token) {
      throw new UnsupportedQuery('Expected a value');
    }

    if (token.type === 'string') {
      return token.value;
    }

    if (token.type === 'literal') {
      return token.value === 'null' ? null : token.value === 'true';
    }

    throw new UnsupportedQuery(`Expected a value, got ${token.value}`);
  };

  const property = (name: string) => {
    if (!FILTERABLE.has(name)) {
      throw new UnsupportedQuery(`Property ${name} is not filterable`);
    }

    return (user: DirectoryUser) => (user as Record<string, unknown>)[name];
  };

  const equal = (a: unknown, b: unknown) =>
    typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;

  const comparison = (): Predicate => {
    const token = take();

    if (!token) {
      throw new UnsupportedQuery('Unexpected end of filter');
    }

    if (token.type === 'paren' && token.value === '(') {
      const inner = disjunction();
      const close = take();

      if (!close || close.value !== ')') {
        throw new UnsupportedQuery('Expected )');
      }

      return inner;
    }

    if (token.type === 'op' && token.value === 'not') {
      const inner = comparison();

      return (user) => !inner(user);
    }

    if (token.type === 'ident' && token.value === 'startswith') {
      take();
      const left = take();
      take();
      const prefix = value();
      take();

      if (!left || left.type !== 'ident' || typeof prefix !== 'string') {
        throw new UnsupportedQuery('Bad startswith');
      }

      const read = property(left.value);

      return (user) =>
        String(read(user) ?? '')
          .toLowerCase()
          .startsWith(prefix.toLowerCase());
    }

    if (token.type !== 'ident') {
      throw new UnsupportedQuery(`Unexpected ${token.value}`);
    }

    const read = property(token.value);
    const op = take();

    if (!op || op.type !== 'op') {
      throw new UnsupportedQuery('Expected an operator');
    }

    if (op.value === 'in') {
      const open = take();

      if (!open || open.value !== '(') {
        throw new UnsupportedQuery('Expected (');
      }

      const values: unknown[] = [value()];

      while (peek()?.type === 'comma') {
        take();
        values.push(value());
      }

      take();

      return (user) => values.some((v) => equal(read(user), v));
    }

    const right = value();

    if (op.value === 'eq') {
      return (user) => equal(read(user), right);
    }

    if (op.value === 'ne') {
      return (user) => !equal(read(user), right);
    }

    throw new UnsupportedQuery(`Operator ${op.value} is not supported here`);
  };

  const conjunction = (): Predicate => {
    let left = comparison();

    while (peek()?.type === 'op' && peek()?.value === 'and') {
      take();
      const right = comparison();
      const l = left;
      left = (user) => l(user) && right(user);
    }

    return left;
  };

  const disjunction = (): Predicate => {
    let left = conjunction();

    while (peek()?.type === 'op' && peek()?.value === 'or') {
      take();
      const right = conjunction();
      const l = left;
      left = (user) => l(user) || right(user);
    }

    return left;
  };

  const predicate = disjunction();

  if (pos !== tokens.length) {
    throw new UnsupportedQuery('Trailing tokens in filter');
  }

  return predicate;
};

// ── Servers ────────────────────────────────────────────────────────────────

const readBody = async (req: http.IncomingMessage) =>
  await new Promise<string>((resolve) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => resolve(data));
  });

const listen = async (server: https.Server) =>
  await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`https://127.0.0.1:${port}`);
    });
  });

let tls: { key: string; cert: string; caFile: string } | undefined;

/**
 * A self-signed certificate for 127.0.0.1, made once per process with the
 * openssl command line. Node cannot issue an X.509 certificate itself, and a
 * private key checked into the repository would trip the secret scan.
 */
const tlsMaterial = () => {
  if (tls) {
    return tls;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dirsync-tls-'));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const made = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ],
    { encoding: 'utf8' },
  );

  if (made.status !== 0) {
    throw new Error(`openssl could not make the stub's certificate:\n${made.stderr ?? made.error}`);
  }

  tls = { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8'), caFile: certFile };

  return tls;
};

type GroupObject = { kind: 'group'; id: string; displayName: string };
type Listed = DirectoryUser | GroupObject;

type Listing = {
  matched: Listed[];
  select: string[] | null;
  pageSize: number;
  count: boolean;
  query: string;
  /** The path the listing was read from, which its nextLink repeats. */
  path: string;
  context: string;
  /** Group members carry `@odata.type`; a plain user listing does not. */
  typed: boolean;
};

const isGroup = (item: Listed): item is GroupObject => (item as GroupObject).kind === 'group';

export const startGraphStub = async (options: GraphStubOptions) => {
  const transcript: TranscriptEntry[] = [];
  const issuedTokens = new Set<string>();
  const listings = new Map<string, Listing & { offset: number; page: number }>();
  const sockets = new Set<import('node:stream').Duplex>();
  let graphOrigin = '';
  let elsewhereOrigin = '';

  const record = (entry: Omit<TranscriptEntry, 'at'>) => {
    const full = { at: new Date().toISOString(), ...entry };
    transcript.push(full);
    return full;
  };

  const send = (res: http.ServerResponse, entry: TranscriptEntry, status: number, body: unknown, headers = {}) => {
    entry.status = status;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const applyFault = (res: http.ServerResponse, entry: TranscriptEntry, fault: Fault, goodBody: () => string) => {
    if (fault.kind === 'hang') {
      return;
    }

    if (fault.kind === 'reset') {
      res.socket?.destroy();
      return;
    }

    if (fault.kind === 'status') {
      send(
        res,
        entry,
        fault.status,
        fault.body ?? graphError('generalException', 'Fault injected by the test.'),
        fault.headers,
      );
      return;
    }

    if (fault.kind === 'body') {
      entry.status = 200;
      res.writeHead(200, { 'content-type': fault.contentType ?? 'application/json; charset=utf-8' });
      res.end(fault.body);
      return;
    }

    const full = goodBody();
    entry.status = 200;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(full)),
    });
    res.write(full.slice(0, Math.floor(full.length / 2)));
    setTimeout(() => res.socket?.destroy(), 20);
  };

  const track = (server: https.Server) => {
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
  };

  const material = tlsMaterial();
  const serverOptions = { key: material.key, cert: material.cert };

  const login = https.createServer(serverOptions, (req, res) => {
    void (async () => {
      const body = await readBody(req);
      const url = new URL(req.url ?? '/', 'http://stub');
      const entry = record({
        server: 'login',
        method: req.method ?? '',
        url: url.pathname,
        body: body.replace(/client_secret=[^&]*/, 'client_secret=REDACTED'),
      });

      // The response, not the request: by the time the body has been read,
      // the request's own close event has already fired on Node 26.
      res.on('close', () => {
        if (entry.status === undefined) {
          entry.abandoned = true;
        }
      });

      const match = /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(url.pathname);

      if (req.method !== 'POST' || !match) {
        send(res, entry, 404, loginError('invalid_request', 900561, 'The endpoint only accepts POST requests.'));
        return;
      }

      if (options.tokenFault) {
        applyFault(res, entry, options.tokenFault, () => '{}');
        return;
      }

      const form = new URLSearchParams(body);
      let clientId = form.get('client_id');
      let clientSecret = form.get('client_secret');
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');

      if (basic) {
        const [id, secret] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
        clientId = clientId ?? decodeURIComponent(id);
        clientSecret = clientSecret ?? decodeURIComponent(secret ?? '');
      }

      // Microsoft documents the tenant in this path as a GUID or a domain
      // name. Nothing promises that braces or whitespace are accepted, so the
      // stub takes the bare GUID only, in any case (GUIDs are not
      // case-sensitive).
      if (decodeURIComponent(match[1]).toLowerCase() !== options.tenantId.toLowerCase()) {
        send(res, entry, 400, loginError('invalid_request', 90002, `Tenant '${match[1]}' not found.`));
        return;
      }

      if (form.get('grant_type') !== 'client_credentials') {
        send(
          res,
          entry,
          400,
          loginError('unsupported_grant_type', 70003, 'The app requested an unsupported grant type.'),
        );
        return;
      }

      if (clientId !== options.clientId) {
        send(
          res,
          entry,
          400,
          loginError('unauthorized_client', 700016, `Application with identifier '${clientId}' was not found.`),
        );
        return;
      }

      if (clientSecret !== options.clientSecret) {
        send(res, entry, 401, loginError('invalid_client', 7000215, 'Invalid client secret provided.'));
        return;
      }

      if (!form.get('scope')?.endsWith('/.default')) {
        send(res, entry, 400, loginError('invalid_scope', 1002012, 'The provided value for scope is not valid.'));
        return;
      }

      const accessToken = randomBytes(32).toString('base64url');
      issuedTokens.add(accessToken);

      send(res, entry, 200, {
        token_type: 'Bearer',
        expires_in: 3599,
        ext_expires_in: 3599,
        access_token: accessToken,
      });
    })();
  });

  const pageBody = (listing: Listing & { offset: number; page: number }, token: string | null) => {
    const slice = listing.matched.slice(listing.offset, listing.offset + listing.pageSize);
    const properties = listing.select ?? GRAPH_DEFAULT_USER_PROPERTIES;
    const value = slice.map((item) => {
      if (isGroup(item)) {
        // A group has no user properties; it answers with what it has.
        return Object.fromEntries([
          ['@odata.type', '#microsoft.graph.group'],
          ['id', item.id],
          ...(properties.includes('displayName') ? [['displayName', item.displayName]] : []),
        ]);
      }

      const user = item;
      const projected = properties
        .filter((p) => !(user.absent ?? []).includes(p as keyof DirectoryUser))
        .map((p) => {
          const raw = (user as Record<string, unknown>)[p];
          const empty = ['businessPhones', 'proxyAddresses', 'otherMails'].includes(p) ? [] : null;

          return [p, raw === undefined ? empty : raw];
        });

      return Object.fromEntries(listing.typed ? [['@odata.type', '#microsoft.graph.user'], ...projected] : projected);
    });

    const page: Record<string, unknown> = {
      '@odata.context': `${graphOrigin}/v1.0/$metadata#${listing.context}`,
    };

    if (listing.count) {
      page['@odata.count'] = listing.matched.length;
    }

    if (token) {
      const link = `${graphOrigin}${listing.path}?${listing.query}${listing.query ? '&' : ''}$skiptoken=${token}`;

      page['@odata.nextLink'] = options.nextLinkFor
        ? options.nextLinkFor(listing.page, link, { graph: graphOrigin, elsewhere: elsewhereOrigin })
        : link;
    }

    page.value = value;

    return JSON.stringify(page);
  };

  /** Direct members, or every member reached through nested groups. */
  const groupMembers = (groupId: string, transitive: boolean): Listed[] => {
    const seen = new Set<string>();
    const out: Listed[] = [];

    const visit = (id: string) => {
      for (const memberId of options.groups?.[id]?.members ?? []) {
        if (seen.has(memberId)) {
          continue;
        }

        seen.add(memberId);

        const nested = options.groups?.[memberId];

        if (nested) {
          out.push({ kind: 'group', id: memberId, displayName: nested.displayName ?? memberId });

          if (transitive) {
            visit(memberId);
          }

          continue;
        }

        const user = options.users.find((u) => u.id === memberId);

        if (user) {
          out.push(user);
        }
      }
    };

    visit(groupId);

    return out;
  };

  const graph = https.createServer(serverOptions, (req, res) => {
    void (async () => {
      await readBody(req);
      const url = new URL(req.url ?? '/', 'http://stub');
      const entry = record({
        server: 'graph',
        method: req.method ?? '',
        url: `${url.pathname}${url.search}`,
        authorization: req.headers.authorization ? req.headers.authorization.replace(/ .*/, ' REDACTED') : undefined,
      });

      // The response, not the request: by the time the body has been read,
      // the request's own close event has already fired on Node 26.
      res.on('close', () => {
        if (entry.status === undefined) {
          entry.abandoned = true;
        }
      });

      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');

      if (!bearer || !issuedTokens.has(bearer[1])) {
        send(
          res,
          entry,
          401,
          graphError(
            'InvalidAuthenticationToken',
            bearer ? 'Access token validation failure.' : 'Access token is empty.',
          ),
        );
        return;
      }

      const groupPath = /^\/v1\.0\/groups\/([^/]+)\/(members|transitiveMembers)(\/microsoft\.graph\.user)?$/.exec(
        url.pathname,
      );

      if (req.method !== 'GET' || (url.pathname !== '/v1.0/users' && !groupPath)) {
        send(res, entry, 404, graphError('Request_ResourceNotFound', `Resource '${url.pathname}' does not exist.`));
        return;
      }

      const groupId = groupPath ? decodeURIComponent(groupPath[1]) : null;

      if (groupId !== null && !options.groups?.[groupId]) {
        send(
          res,
          entry,
          404,
          graphError(
            'Request_ResourceNotFound',
            `Resource '${groupId}' does not exist or one of its queried reference-property objects are not present.`,
          ),
        );
        return;
      }

      let listing: (Listing & { offset: number; page: number }) | undefined;
      const skipToken = url.searchParams.get('$skiptoken');

      if (skipToken) {
        listing = listings.get(skipToken);

        if (!listing) {
          send(
            res,
            entry,
            400,
            graphError('Request_BadRequest', 'The specified page token value has expired or is invalid.'),
          );
          return;
        }
      } else {
        try {
          const filter = url.searchParams.get('$filter');
          const predicate = filter ? parseFilter(filter) : () => true;
          const select = url.searchParams.get('$select');
          const top = url.searchParams.get('$top');
          const count = url.searchParams.get('$count') === 'true';

          if (top !== null && !(/^\d+$/.test(top) && Number(top) >= 1 && Number(top) <= 999)) {
            send(
              res,
              entry,
              400,
              graphError(
                'Request_BadRequest',
                `Invalid page size specified: '${top}'. Must be between 1 and 999 inclusive.`,
              ),
            );
            return;
          }

          if (count && String(req.headers.consistencylevel ?? '').toLowerCase() !== 'eventual') {
            send(
              res,
              entry,
              400,
              graphError('Request_BadRequest', '$count is only supported with the ConsistencyLevel:eventual header.'),
            );
            return;
          }

          const query = new URLSearchParams(url.searchParams);
          query.delete('$skiptoken');

          let matched: Listed[];
          let context = 'users';

          if (groupPath && groupId !== null) {
            const cast = Boolean(groupPath[3]);
            const advanced = cast || ['$filter', '$search', '$orderby'].some((p) => url.searchParams.get(p) !== null);

            if (advanced && (!count || String(req.headers.consistencylevel ?? '').toLowerCase() !== 'eventual')) {
              send(
                res,
                entry,
                400,
                graphError(
                  'Request_UnsupportedQuery',
                  'This query is only supported as an advanced query, with ConsistencyLevel:eventual and $count=true.',
                ),
              );
              return;
            }

            const members = groupMembers(groupId, groupPath[2] === 'transitiveMembers');
            const users = members.filter((m): m is DirectoryUser => !isGroup(m));

            matched = cast || filter ? users.filter(predicate) : members;
            context = cast ? 'users' : 'directoryObjects';
          } else {
            matched = options.users.filter(predicate);
          }

          listing = {
            matched,
            select: select ? select.split(',').map((p) => p.trim()) : null,
            pageSize: Math.min(top ? Number(top) : 100, options.maxPageSize ?? 100),
            count,
            query: query.toString().replace(/%24/g, '$'),
            path: url.pathname,
            context,
            typed: Boolean(groupPath),
            offset: 0,
            page: 0,
          };
        } catch (error) {
          if (error instanceof UnsupportedQuery) {
            send(res, entry, 400, graphError('Request_UnsupportedQuery', `Unsupported Query. ${error.message}`));
            return;
          }

          throw error;
        }
      }

      const current = { ...listing, page: listing.page + 1 };
      entry.page = current.page;

      const nextOffset = current.offset + current.pageSize;
      let nextToken: string | null = null;

      if (nextOffset < current.matched.length) {
        nextToken = randomBytes(18).toString('base64url');
        listings.set(nextToken, { ...current, offset: nextOffset });
      }

      if (options.beforePage) {
        await options.beforePage(current.page);
      }

      const fault = options.pageFaults?.[current.page];

      if (fault) {
        applyFault(res, entry, fault, () => pageBody(current, nextToken));
        return;
      }

      entry.status = 200;
      res.writeHead(200, {
        'content-type':
          'application/json;odata.metadata=minimal;odata.streaming=true;IEEE754Compatible=false;charset=utf-8',
      });
      res.end(pageBody(current, nextToken));
    })();
  });

  // Not Graph: records every request, and whether it carried a bearer token.
  const elsewhere = https.createServer(serverOptions, (req, res) => {
    void (async () => {
      await readBody(req);
      record({
        server: 'elsewhere',
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization ? req.headers.authorization.replace(/ .*/, ' REDACTED') : undefined,
        status: 404,
      });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(graphError('Request_ResourceNotFound', 'Not Graph.')));
    })();
  });

  // A client speaking plain HTTP to the Graph port fails the TLS handshake.
  graph.on('tlsClientError', () => {
    record({ server: 'graph', method: 'PLAINTEXT', url: '' });
  });

  track(login);
  track(graph);
  track(elsewhere);

  const loginOrigin = await listen(login);
  graphOrigin = await listen(graph);
  elsewhereOrigin = await listen(elsewhere);

  return {
    graphBaseUrl: graphOrigin,
    loginBaseUrl: loginOrigin,
    elsewhereBaseUrl: elsewhereOrigin,
    /** The certificate the stub's servers present, for NODE_EXTRA_CA_CERTS. */
    caFile: material.caFile,
    /** Anything that reached the host that is not Graph. */
    elsewhereRequests: () => transcript.filter((t) => t.server === 'elsewhere'),
    /** Plain-HTTP connections attempted against the Graph port. */
    plaintextAttempts: () => transcript.filter((t) => t.server === 'graph' && t.method === 'PLAINTEXT'),
    transcript,
    /** Token requests as the client-credentials flow makes them; stray probes are not counted. */
    tokenRequests: () =>
      transcript.filter(
        (t) => t.server === 'login' && t.method === 'POST' && /^\/[^/]+\/oauth2\/v2\.0\/token$/.test(t.url),
      ),
    /** Every access token the login stub handed out. */
    issuedAccessTokens: () => [...issuedTokens],
    userPageRequests: () =>
      transcript.filter((t) => t.server === 'graph' && t.method === 'GET' && t.url.startsWith('/v1.0/users')),
    /** Requests for a group's members, direct or transitive. */
    groupMemberRequests: () =>
      transcript.filter((t) => t.server === 'graph' && t.method === 'GET' && t.url.startsWith('/v1.0/groups/')),
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      await Promise.all([
        new Promise((resolve) => login.close(resolve)),
        new Promise((resolve) => graph.close(resolve)),
        new Promise((resolve) => elsewhere.close(resolve)),
      ]);
    },
  };
};

export type GraphStub = Awaited<ReturnType<typeof startGraphStub>>;
