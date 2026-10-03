import { isIP } from 'node:net';

import { describe, expect, it } from 'vitest';

import { ipFamily, isPubliclyRoutableAddress } from './ip-address';

/**
 * `ipFamily` exists because `isIP` cannot be imported into a module the browser
 * bundles. The thing worth testing is therefore not what we think the answers
 * should be, but whether the two functions ever disagree, so almost everything
 * below is differential: generate a string, ask both, compare.
 *
 * A disagreement is a security finding rather than a test failure to paper
 * over. Every caller that hears "not an address" treats the string as a name.
 * `assertUrlIsPubliclyFetchable` hands it to the resolver, and `isPrivateUrl`
 * answers false and lets the webhook form accept it. So a string Node calls an
 * address and we call a name walks past the range check that is the whole point
 * of this module.
 */

/** The awkward ones, written out so a regression names itself. */
const HAND_PICKED = [
  // Notations Node refuses. Each of these reaches loopback if something else
  // in the chain is more generous than Node about parsing them.
  '0x7f.1',
  '0x7f.0.0.1',
  '2130706433',
  '017700000001',
  '0177.0.0.1',
  '127.1',
  '127.0.1',
  // Leading zeros, which disqualify an octet.
  '01.2.3.4',
  '1.02.3.4',
  '00.0.0.0',
  '1.2.3.04',
  // Shapes near a dotted quad.
  '1.2.3.4',
  '1.2.3.4.5',
  '1.2.3',
  '1..2.3',
  '1.2.3.',
  '.1.2.3',
  '255.255.255.255',
  '256.1.1.1',
  '1.2.3.256',
  '1.2.3.-1',
  '1.2.3.+4',
  '1.2.3.4/24',
  '0.0.0.0',
  // Whitespace, which nothing trims for us.
  '',
  ' ',
  '  ',
  ' 1.2.3.4',
  '1.2.3.4 ',
  '\t1.2.3.4',
  '1.2.3.4\n',
  ' ::1',
  '::1 ',
  // Names.
  'localhost',
  'example.com',
  'not-an-address',
  'metadata.google.internal',
  // IPv6, including the bracketed form the URL parser strips before we see it.
  '::',
  ':',
  ':::',
  '::1',
  '[::1]',
  '[::ffff:127.0.0.1]',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::FFFF:127.0.0.1',
  '::FFFF:7F00:1',
  '::ffff:1.2.3.4.5',
  '::ffff:01.2.3.4',
  '::1.2.3.4',
  '1.2.3.4::',
  '0:0:0:0:0:ffff:127.0.0.1',
  '1:2:3:4:5:6:7:8',
  '1:2:3:4:5:6:7',
  '1:2:3:4:5:6:7:8:9',
  '1:2:3:4:5:6:7::',
  '1:2:3:4:5:6:7:8::',
  '::1:2:3:4:5:6:7',
  '::1:2:3:4:5:6:7:8',
  '1::2::3',
  '1:2:3:4:5:6:1.2.3.4',
  '1:2:3:4:5:6:7:1.2.3.4',
  '1:2:3:4:5::1.2.3.4',
  '1:2:3:4:5:6::1.2.3.4',
  '::a:b:c:d:e:1.2.3.4',
  '::a:b:c:d:e:f:1.2.3.4',
  '12345::',
  'gggg::1',
  '0001:0002:0003:0004:0005:0006:0007:0008',
  'FE80::1',
  'fe80::1%eth0',
  'fe80::1%',
  'fe80::1%%',
  'fe80::1%25eth0',
  'a::b%1',
  'a::b%.',
  '::%eth0',
  '1.0.0.1%eth0',
  ':1:2:3:4:5:6:7:8',
  '1:2:3:4:5:6:7:8:',
  '1:',
  ':1',
  '::a',
  'a::',
  '2606:4700:4700::1111',
];

/**
 * A deterministic generator, so a failure is reproducible from the seed alone.
 * Math.random would make a divergence vanish on the rerun that investigates it.
 */
const makeRandom = (seed: number) => {
  let state = seed;

  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;

    return state / 0x7fffffff;
  };
};

const generateCorpus = (): string[] => {
  const random = makeRandom(20260916);
  const pick = <T>(values: T[]): T => values[Math.floor(random() * values.length)];
  const corpus = new Set<string>(HAND_PICKED);

  // Junk built from the characters that matter, which is where a parser that
  // splits on the wrong thing falls over.
  const pieces = ['0', '1', '9', 'a', 'f', 'g', 'F', ':', '::', '.', '%', 'x', '-', 'ffff', '12345', '255', '256'];

  for (let i = 0; i < 600; i++) {
    let value = '';

    for (let part = 0; part < 1 + Math.floor(random() * 8); part++) {
      value += pick(pieces);
    }

    corpus.add(value);
  }

  // Dotted quads around the boundaries, including leading zeros.
  for (let i = 0; i < 300; i++) {
    const octet = () => pick([String(Math.floor(random() * 300)), `0${Math.floor(random() * 99)}`, '0', '255']);

    corpus.add([octet(), octet(), octet(), octet()].join('.'));
  }

  // IPv6 shapes: varying group counts, an occasional empty group standing in
  // for a compression that may or may not be legal, a dotted tail, a zone.
  for (let i = 0; i < 600; i++) {
    const groups: string[] = [];

    for (let group = 0; group < 1 + Math.floor(random() * 9); group++) {
      groups.push(pick(['0', '1', 'ffff', 'FFFF', 'abcd', '12345', '', '0000', 'f']));
    }

    if (random() < 0.5) {
      groups.splice(Math.floor(random() * groups.length), 0, '');
    }

    let value = groups.join(':');

    if (random() < 0.25) {
      value += `:${[0, 1, 2, 3].map(() => String(Math.floor(random() * 300))).join('.')}`;
    }

    if (random() < 0.15) {
      value += `%${pick(['eth0', '1', '', '%', 'a.b'])}`;
    }

    corpus.add(value);
  }

  return [...corpus];
};

const CORPUS = generateCorpus();

describe('ipFamily', () => {
  it('agrees with node:net isIP across the whole corpus', () => {
    const divergences = CORPUS.filter((value) => ipFamily(value) !== isIP(value)).map(
      (value) => `${JSON.stringify(value)}: ipFamily ${ipFamily(value)}, isIP ${isIP(value)}`,
    );

    expect(divergences).toEqual([]);
  });

  it('covers enough ground to mean something', () => {
    expect(CORPUS.length).toBeGreaterThan(800);
    expect(CORPUS.filter((value) => isIP(value) === 4).length).toBeGreaterThan(20);
    expect(CORPUS.filter((value) => isIP(value) === 6).length).toBeGreaterThan(20);
    expect(CORPUS.filter((value) => isIP(value) === 0).length).toBeGreaterThan(100);
  });

  it.each([
    ['1.2.3.4', 4],
    ['255.255.255.255', 4],
    ['::1', 6],
    ['::ffff:127.0.0.1', 6],
    ['fe80::1%eth0', 6],
    ['2130706433', 0],
    ['0x7f.1', 0],
    ['01.2.3.4', 0],
    ['[::1]', 0],
    ['', 0],
  ])('reads %s as family %i', (value, family) => {
    expect(ipFamily(value)).toBe(family);
  });
});

describe('NAT64, where an IPv4 destination arrives wearing an IPv6 costume', () => {
  // The gap this closes. Undecoded, the first of these read as publicly
  // routable and every IPv4 range check was bypassed by writing the target
  // a different way.
  it.each([
    ['a private address behind the well known prefix', '64:ff9b::10.0.0.1'],
    ['the same in hex', '64:ff9b::a00:1'],
    ['loopback behind it', '64:ff9b::127.0.0.1'],
    ['link local behind it', '64:ff9b::169.254.169.254'],
    ['carrier grade NAT behind it', '64:ff9b::100.64.0.1'],
  ])('refuses %s', (_name, address) => {
    expect(isPubliclyRoutableAddress(address)).toBe(false);
  });

  it('allows a public address behind the well known prefix, which is what it is for', () => {
    expect(isPubliclyRoutableAddress('64:ff9b::8.8.8.8')).toBe(true);
  });

  it.each([
    ['the RFC 8215 local use prefix', '64:ff9b:1::1'],
    ['a /64 embedding this does not decode', '64:ff9b:0:1::1'],
  ])('refuses %s rather than guessing at its layout', (_name, address) => {
    expect(isPubliclyRoutableAddress(address)).toBe(false);
  });
});

describe('isPubliclyRoutableAddress', () => {
  it.each([
    ['loopback', '127.0.0.1'],
    ['loopback, the rest of the /8', '127.255.255.255'],
    ['private 10/8', '10.1.2.3'],
    ['private 172.16/12', '172.31.255.255'],
    ['private 192.168/16', '192.168.1.1'],
    ['link local, the metadata service', '169.254.169.254'],
    ['carrier grade NAT', '100.64.0.1'],
    ['unspecified', '0.0.0.0'],
    ['multicast', '224.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unspecified', '::'],
    ['IPv6 link local', 'fe80::1'],
    ['unique local', 'fd00::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['a mapped private address, dotted', '::ffff:10.0.0.1'],
    ['a mapped private address, hex', '::ffff:a00:1'],
  ])('refuses %s at %s', (_name, address) => {
    expect(isPubliclyRoutableAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '198.51.101.10', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (address) => {
    expect(isPubliclyRoutableAddress(address)).toBe(true);
  });

  it('refuses everything the corpus says is not an address', () => {
    const wronglyAllowed = CORPUS.filter((value) => isIP(value) === 0 && isPubliclyRoutableAddress(value));

    expect(wronglyAllowed).toEqual([]);
  });
});
