import { describe, expect, it } from 'vitest';

import { ZCssVarsSchema } from './css-vars';

/**
 * Round 23 (C122): `radius` is accepted only as `0`, a `px` length from 0 to 16, or a `rem` length
 * from 0 to 1, so the largest derived radius, `calc(1rem + 4px)`, stays inside every dialog's padding.
 */
describe('round 23: the radius token at save', () => {
  for (const radius of ['100%', '2em', '12pt', '100', '17px', '1.5rem']) {
    it(`refuses { radius: '${radius}' }, naming radius`, () => {
      const result = ZCssVarsSchema.safeParse({ radius });

      expect(result.success).toBe(false);
      expect(result.error?.issues.some((issue) => issue.path.includes('radius'))).toBe(true);
    });
  }

  for (const radius of ['0', '0.5rem', '16px', '1rem', '0px', '0rem']) {
    it(`accepts { radius: '${radius}' }`, () => {
      expect(ZCssVarsSchema.safeParse({ radius }).success).toBe(true);
    });
  }
});
