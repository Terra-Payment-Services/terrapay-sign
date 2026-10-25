import { sValidator as baseSValidator } from '@hono/standard-validator';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Context, ValidationTargets } from 'hono';

type ValidationResult = {
  success: boolean;
  data: unknown;
  error?: ReadonlyArray<StandardSchemaV1.Issue>;
};

/**
 * The library's sValidator answers a failed validation with the submitted input in `data`, which hands a
 * signup's plaintext password back in the 400 (#202). This one answers with each issue's path and a fixed message,
 * and keeps the library's signature so route types are unchanged.
 */
export const sValidator = ((target: keyof ValidationTargets, schema: StandardSchemaV1) =>
  baseSValidator(target, schema, (result: ValidationResult, c: Context) => {
    if (result.success) {
      return;
    }

    return c.json({ success: false, error: toIssues(result.error ?? []) }, 400);
  })) as unknown as typeof baseSValidator;

// A validator's message can quote the input, possibly after the schema trimmed, re-cased or normalised it, so no
// message is passed through: each issue names its field and nothing else (#202).
const toIssues = (issues: ReadonlyArray<StandardSchemaV1.Issue>) =>
  issues.map((issue) => ({
    path: (issue.path ?? []).map((segment) => (typeof segment === 'object' ? segment.key : segment)),
    message: 'Invalid value',
  }));
