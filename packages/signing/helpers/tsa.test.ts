import { describe, expect, it } from 'vitest';

import { parsePinnedKeys } from './tsa';

const KEY = 'a4db8668c6796ebf476ddc5ace453a9260dbd4dbb09f51ecec9a839003824795';

describe('parsePinnedKeys', () => {
  it('pins nothing when the setting is absent or empty', () => {
    expect(parsePinnedKeys(undefined)).toEqual([]);
    expect(parsePinnedKeys(' ')).toEqual([]);
  });

  it('reads a comma-separated list in the forms openssl prints', () => {
    const colons = KEY.toUpperCase().match(/../g)?.join(':');

    expect(parsePinnedKeys(`${colons}, 59DF317BFA9F4F0AB7CA514D7772296AA2C765B87664D08B96E57399E364729C`)).toEqual([
      KEY,
      '59df317bfa9f4f0ab7ca514d7772296aa2c765b87664d08b96e57399e364729c',
    ]);
  });

  it('refuses an entry that is not a SHA-256 hash, rather than pinning nothing', () => {
    expect(() => parsePinnedKeys(`${KEY},${KEY.slice(0, 40)}`)).toThrow(/must list SHA-256 hashes/);
  });
});
