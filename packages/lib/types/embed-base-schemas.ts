import { ZSupportedLanguageCodeSchema } from '@documenso/lib/constants/locales';
import { z } from 'zod';

import { ZStoredCssVarsSchema } from './css-vars';

export const ZBaseEmbedDataSchema = z.object({
  darkModeDisabled: z.boolean().optional().default(false),
  css: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  cssVars: ZStoredCssVarsSchema.optional().default({}),
  language: ZSupportedLanguageCodeSchema.optional(),
});
