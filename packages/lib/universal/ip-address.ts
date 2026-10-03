/**
 * Deciding what an address string is, and whether we are willing to reach it.
 *
 * This is the one list of unroutable ranges. The revocation fetcher, OpenID
 * discovery and the webhook URL check all ask it, so there is a single place to
 * keep right rather than a copy per caller that drifts.
 *
 * It lives in `universal` because one of those callers runs in the browser. The
 * webhook form's zod schema imports `isPrivateUrl`, which imports this, and the
 * schema is shared between the tRPC router and the form. A module here may not
 * touch a node builtin: Vite externalises `node:net` and `node:dns` for the
 * browser and rollup then refuses to build the app at all.
 *
 * That constraint is what `ipFamily` exists for. It answers the question
 * `isIP` from `node:net` answers, and `ip-address.test.ts` holds it to that by
 * comparing the two over a generated corpus rather than over a handful of cases
 * somebody thought of. The agreement matters more than it looks: a caller that
 * hears "not an address" treats the string as a name to resolve later, and
 * `isPrivateUrl` answers false for it, so a parser that were stricter than
 * Node's would wave through the very host it was put there to refuse.
 */

/** One IPv4 octet as Node reads it: decimal, at most 255, no leading zeros. */
const IPV4_OCTET = /^(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])$/;

/** One IPv6 group: one to four hex digits, either case. */
const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;

/** A zone identifier, the `%eth0` on a link local address. */
const IPV6_ZONE = /^[0-9a-zA-Z.:-]+$/;

const isIpv4 = (value: string): boolean => {
  const octets = value.split('.');

  return octets.length === 4 && octets.every((octet) => IPV4_OCTET.test(octet));
};

/**
 * IPv6 as Node accepts it: eight groups, or fewer with one `::` standing in for
 * the rest, and an optional dotted IPv4 tail worth two groups at the very end.
 */
const isIpv6 = (value: string): boolean => {
  let address = value;

  const zoneAt = value.indexOf('%');

  if (zoneAt !== -1) {
    if (!IPV6_ZONE.test(value.slice(zoneAt + 1))) {
      return false;
    }

    address = value.slice(0, zoneAt);
  }

  const halves = address.split('::');

  // Two run-together colons may appear once. `1::2::3` names nothing.
  if (halves.length > 2) {
    return false;
  }

  const compressed = halves.length === 2;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = compressed && halves[1] !== '' ? halves[1].split(':') : [];
  const segments = [...head, ...tail];

  if (segments.length === 0) {
    // Either `::`, which is the unspecified address, or the empty string.
    return compressed;
  }

  const last = segments[segments.length - 1];
  const hasIpv4Tail = last.includes('.');

  if (hasIpv4Tail) {
    // A dotted tail only counts where it ends the address. `1.2.3.4::` puts it
    // at the front, which is not a spelling of anything.
    if (compressed && tail.length === 0) {
      return false;
    }

    if (!isIpv4(last)) {
      return false;
    }
  }

  const groups = hasIpv4Tail ? segments.slice(0, -1) : segments;

  if (!groups.every((group) => IPV6_GROUP.test(group))) {
    return false;
  }

  const groupCount = groups.length + (hasIpv4Tail ? 2 : 0);

  // `::` has to stand in for at least one group, so a compressed address is
  // short by one or more. An uncompressed one is exactly eight groups long.
  return compressed ? groupCount <= 7 : groupCount === 8;
};

/**
 * Which family this string is a literal address in, or 0 for a name.
 *
 * The same answers as `isIP` from `node:net`, without importing it. Node reads
 * IPv4 as dotted quad alone, so `2130706433` and `0x7f.1` are names rather than
 * addresses, and a leading zero as in `01.2.3.4` disqualifies an octet.
 *
 * @param value - A hostname or an address, with no brackets and no port.
 */
export const ipFamily = (value: string): 0 | 4 | 6 => {
  if (isIpv4(value)) {
    return 4;
  }

  return isIpv6(value) ? 6 : 0;
};

const ipv4ToNumber = (address: string): number => {
  const parts = address.split('.').map((part) => Number(part));

  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
};

const inIpv4Range = (address: string, network: string, prefix: number): boolean => {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;

  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(network) & mask);
};

/** RFC 1918, RFC 6598, RFC 3927 and friends: everything not on the open net. */
const BLOCKED_IPV4_RANGES: [string, number][] = [
  ['0.0.0.0', 8], // this host, and the unspecified address
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link local, including cloud metadata at 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes the broadcast address
];

/**
 * Turn a dotted IPv4 tail into the two hex groups it stands for.
 *
 * `64:ff9b::8.8.8.8` is eight groups, not seven, and reading it as seven made
 * the group count check reject it as malformed. That was survivable while the
 * only dotted tail anyone decoded was `::ffff:`, which had its own regex above,
 * and stopped being survivable once the NAT64 prefix needed reading too.
 *
 * @param segments - The groups as split, the last possibly dotted.
 * @returns The same list with any dotted tail expanded in place.
 */
const expandIpv4Tail = (segments: string[]): string[] => {
  const last = segments[segments.length - 1];

  if (last === undefined || !last.includes('.')) {
    return segments;
  }

  const octets = last.split('.').map((octet) => Number.parseInt(octet, 10));

  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return segments;
  }

  return [
    ...segments.slice(0, -1),
    ((octets[0] << 8) | octets[1]).toString(16),
    ((octets[2] << 8) | octets[3]).toString(16),
  ];
};

const expandIpv6 = (address: string): string[] => {
  const [head, tail] = address.split('::');
  const headGroups = head ? expandIpv4Tail(head.split(':')) : [];
  const tailGroups = tail ? expandIpv4Tail(tail.split(':')) : [];

  if (address.includes('::')) {
    const fill = new Array(8 - headGroups.length - tailGroups.length).fill('0');

    return [...headGroups, ...fill, ...tailGroups];
  }

  return expandIpv4Tail(address.split(':'));
};

const isBlockedIpv6 = (address: string): boolean => {
  const normalised = address.toLowerCase().split('%')[0];

  // An IPv4 mapped address is an IPv4 address wearing a hat. Judge the v4 part.
  //
  // Matching only the dotted spelling was not enough. Node's URL canonicalises
  // `http://[::ffff:127.0.0.1]/` to hostname `::ffff:7f00:1`, which this regex
  // does not match, so loopback and the instance metadata service both came
  // back publicly routable. The hex form is handled below, from the groups.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);

  if (mapped) {
    return isBlockedIpv4(mapped[1]);
  }

  const groups = expandIpv6(normalised).map((group) => Number.parseInt(group || '0', 16));

  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return true;
  }

  // ::ffff:a.b.c.d written as hex, and ::a.b.c.d, the deprecated compatible
  // form. Both carry a v4 address in the last two groups, and both reach the
  // v4 destination, so both are judged as that v4 address.
  const isFirstFiveZero = groups.slice(0, 5).every((group) => group === 0);

  if (isFirstFiveZero && (groups[5] === 0xffff || groups[5] === 0)) {
    const embedded = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;

    // ::0 and ::1 are handled by the checks below rather than as 0.0.0.x.
    if (groups[5] === 0xffff || groups[6] !== 0) {
      return isBlockedIpv4(embedded);
    }
  }

  // NAT64. RFC 6052 reserves 64:ff9b::/96 for translating IPv4 into IPv6, and
  // RFC 8215 adds 64:ff9b:1::/48 for local use, so an address here is a
  // request to an IPv4 destination wearing an IPv6 costume. Undecoded, the
  // well known prefix carrying an RFC 1918 address read as publicly routable
  // and every range check above was bypassed by writing the target a different
  // way.
  //
  // The /96 form puts the address in the last two groups, exactly like the
  // mapped case above, so it is decoded and judged as that address. RFC 6052
  // also allows /32, /40, /48, /56 and /64 embeddings, whose layouts skip a
  // reserved octet and are not decoded here. Anything else inside 64:ff9b::/32
  // is therefore refused rather than guessed at: a translation prefix we
  // cannot read is not somewhere to send a request.
  const isNat64Prefix = groups[0] === 0x0064 && groups[1] === 0xff9b;

  if (isNat64Prefix) {
    const isWellKnown96 = groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0;

    if (isWellKnown96) {
      return isBlockedIpv4(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`);
    }

    return true;
  }

  const isAllZero = groups.every((group) => group === 0);
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;

  return (
    isAllZero ||
    isLoopback ||
    (groups[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (groups[0] & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (groups[0] & 0xff00) === 0xff00 // ff00::/8 multicast
  );
};

const isBlockedIpv4 = (address: string): boolean =>
  BLOCKED_IPV4_RANGES.some(([network, prefix]) => inIpv4Range(address, network, prefix));

/**
 * Is this literal address one we are willing to open a connection to?
 *
 * Exported for the tests, which assert the range table rather than trusting it.
 *
 * @param address - An IPv4 or IPv6 literal. A hostname returns false, because
 *   a name is not an address and answering either way about one would be a lie.
 */
export const isPubliclyRoutableAddress = (address: string): boolean => {
  const family = ipFamily(address);

  if (family === 4) {
    return !isBlockedIpv4(address);
  }

  if (family === 6) {
    return !isBlockedIpv6(address);
  }

  return false;
};
