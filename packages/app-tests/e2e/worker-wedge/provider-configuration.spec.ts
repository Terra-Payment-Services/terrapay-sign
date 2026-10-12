/**
 * behaviour 8: the three settings take a positive whole number of
 * seconds, and anything else makes the provider throw at construction with an
 * error naming the variable, in every environment. Written from
 * its specification alone.
 *
 * | Test                                                   | Behaviour | Failure modes |
 * | ------------------------------------------------------ | --------- | ------------- |
 * | each invalid value of each setting throws, naming it    | 8         | F8            |
 * | valid values and the defaults construct (control)       | 8         | F8            |
 * | a value above 86400, or in exponent form, throws         | 8, A6     | F8            |
 * | 86400, the largest allowed value, constructs (control)   | 8, A6     | F8            |
 *
 * Construction needs no reachable Redis, so these run against an address
 * nothing listens on and stop the child as soon as construction returns.
 */
import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { CHECK_VAR, DRAIN_VAR, STALL_VAR, spawnProvider } from './support/provider-process';

const SETTINGS = [STALL_VAR, CHECK_VAR, DRAIN_VAR];

/** Zero, negative, fractional, blank, whitespace, non-numeric and a unit suffix. */
const INVALID = ['0', '-5', '1.5', '', ' ', 'abc', '10s'];

const construct = async (env: Record<string, string | undefined>) => {
  const provider = spawnProvider({
    prefix: `{w47-config-${randomUUID()}}`,
    env: {
      NODE_ENV: 'production',
      NEXT_PRIVATE_JOBS_PROVIDER: 'bullmq',
      NEXT_PRIVATE_REDIS_URL: 'redis://127.0.0.1:1',
      W47_CONSTRUCT_ONLY: 'true',
      ...env,
    },
  });
  const exit = await provider.exitWithin(60_000);

  await provider.kill();

  const error = provider.events().find((e) => e.event === 'construct-error');

  return {
    code: exit?.code ?? null,
    constructed: provider.events().some((e) => e.event === 'constructed'),
    message: typeof error?.detail.message === 'string' ? error.detail.message : null,
    output: `${provider.stdout()}\n${provider.stderr()}`,
  };
};

for (const variable of SETTINGS) {
  // F8: an invalid value is refused at construction, and the error names the variable.
  test(`an_invalid_${variable}_makes_construction_throw_naming_the_variable`, async () => {
    test.setTimeout(240_000);

    const results = await Promise.all(
      INVALID.map(async (value) => ({ value, result: await construct({ [variable]: value }) })),
    );

    for (const { value, result } of results) {
      expect(result.constructed, `${variable}=${JSON.stringify(value)} constructed instead of throwing`).toBe(false);
      expect(result.code, `${variable}=${JSON.stringify(value)}: exit code\n${result.output}`).toBe(3);
      expect(result.message ?? '', `${variable}=${JSON.stringify(value)}: the error names the variable`).toContain(
        variable,
      );
    }
  });
}

// F8 (control): the validation must not refuse what the spec allows.
test('valid_whole_seconds_and_the_defaults_construct', async () => {
  test.setTimeout(120_000);

  const explicit = await construct({ [STALL_VAR]: '60', [CHECK_VAR]: '15', [DRAIN_VAR]: '30' });

  expect(explicit.message, explicit.output).toBeNull();
  expect(explicit.constructed).toBe(true);
  expect(explicit.code).toBe(0);

  const defaults = await construct({});

  expect(defaults.message, defaults.output).toBeNull();
  expect(defaults.constructed).toBe(true);
  expect(defaults.code).toBe(0);
});

/**
 * Amendment v3, A6: each setting is a whole number from 1 to 86400 seconds.
 * Node clamps a timer above about 24.8 days to 1 ms, so a large value would
 * turn a daily check into a busy loop. `1e3` is a thousand to Number(), but it
 * is not written as a whole number, so a parser that accepts it is too loose.
 */
const TOO_LARGE_OR_NOT_WHOLE = ['86401', '99999999999', '1e3'];

for (const variable of SETTINGS) {
  // F8, A6: above the bound, or a whole number only in exponent form.
  test(`a_${variable}_above_86400_or_in_exponent_form_makes_construction_throw_naming_the_variable`, async () => {
    test.setTimeout(180_000);

    const results = await Promise.all(
      TOO_LARGE_OR_NOT_WHOLE.map(async (value) => ({ value, result: await construct({ [variable]: value }) })),
    );

    for (const { value, result } of results) {
      expect(result.constructed, `${variable}=${JSON.stringify(value)} constructed instead of throwing`).toBe(false);
      expect(result.code, `${variable}=${JSON.stringify(value)}: exit code\n${result.output}`).toBe(3);
      expect(result.message ?? '', `${variable}=${JSON.stringify(value)}: the error names the variable`).toContain(
        variable,
      );
    }
  });
}

// F8, A6 (control): the bound itself is allowed, for every setting at once.
test('86400_seconds_the_largest_allowed_value_constructs', async () => {
  test.setTimeout(120_000);

  const largest = await construct({ [STALL_VAR]: '86400', [CHECK_VAR]: '86400', [DRAIN_VAR]: '86400' });

  expect(largest.message, largest.output).toBeNull();
  expect(largest.constructed).toBe(true);
  expect(largest.code).toBe(0);
});
