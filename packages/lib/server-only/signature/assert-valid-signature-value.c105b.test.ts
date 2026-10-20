import { describe, expect, it } from 'vitest';

import { AppError } from '../../errors/app-error';
import { assertValidSignatureValue } from './assert-valid-signature-value';

/** Every Unicode Cc character: U+0000 to U+001F and U+007F to U+009F (65 in all). */
const CONTROL_CHARACTERS = [
  ...Array.from({ length: 0x20 }, (_, code) => code),
  ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
].map((code) => String.fromCharCode(code));

const hex = (character: string) => `U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

describe('C105b assertValidSignatureValue: Cc characters at the start, the middle and the end', () => {
  it('covers all 65 Cc characters', () => {
    expect(CONTROL_CHARACTERS).toHaveLength(65);
    expect(new Set(CONTROL_CHARACTERS).size).toBe(65);
  });

  const positions: Array<[string, (character: string) => string]> = [
    ['start', (character) => `${character}Alice`],
    ['middle', (character) => `Al${character}ice`],
    ['end', (character) => `Alice${character}`],
  ];

  for (const [position, build] of positions) {
    for (const character of CONTROL_CHARACTERS) {
      it(`refuses ${hex(character)} at the ${position} with an AppError`, async () => {
        await expect(assertValidSignatureValue({ value: build(character) })).rejects.toBeInstanceOf(AppError);
      });
    }
  }

  it('accepts ordinary spaces at both ends', async () => {
    await expect(assertValidSignatureValue({ value: '  Alice  ' })).resolves.not.toThrow();
  });
});
