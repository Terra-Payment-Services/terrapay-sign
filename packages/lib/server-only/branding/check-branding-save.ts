import { AppError, AppErrorCode } from '../../errors/app-error';
import type { TCssVarsSchema } from '../../types/css-vars';
import { ZStoredCssVarsSchema } from '../../types/css-vars';
import {
  dropUnreadableBrandingTokens,
  EMAIL_RENDERING,
  findBrandingTokenProblems,
  WEB_RENDERING,
} from '../../utils/branding-contrast';
import { checkBrandingCssContrast } from '../../utils/branding-css-contrast';
import { type SanitizeBrandingCssWarning, sanitizeBrandingCss } from '../../utils/sanitize-branding-css';

export type CheckBrandingSaveOptions = {
  /** Sanitised CSS from the request; null for no stylesheet; undefined when not in the request. */
  css: string | null | undefined;
  /** Normalised tokens from the request; undefined when not in the request. */
  colors: TCssVarsSchema | null | undefined;
  /** What the row holds now. */
  storedCss: string | null;
  storedColors: unknown;
  /** For a team, the organisation's values, which a null team field inherits. */
  inheritedCss?: string | null;
  inheritedColors?: unknown;
};

const parseColors = (value: unknown): TCssVarsSchema | null => {
  const parsed = value ? ZStoredCssVarsSchema.safeParse(value) : null;

  return parsed?.success ? parsed.data : null;
};

const refuse = (details: string[]) => {
  throw new AppError(AppErrorCode.INVALID_BODY, {
    message: `Branding colours would be unreadable, contrast below 3:1: ${details.join('; ')}.`,
  });
};

/**
 * Checks the branding stylesheet and colour tokens as they will be stored together.
 * Unreadable token pairs refuse the save. A stylesheet in the request is checked against the
 * tokens it will render with and loses its unreadable pairs, with warnings. A save of tokens alone
 * is refused if the stored stylesheet would become unreadable with them. A team field left null
 * takes the organisation's value, as `extractDerivedTeamSettings` does when the page renders.
 *
 * @returns the stylesheet to store (undefined leaves it unchanged) and its contrast warnings
 * @throws AppError INVALID_BODY naming each unreadable pair
 */
export const checkBrandingSave = ({
  css,
  colors,
  storedCss,
  storedColors,
  inheritedCss = null,
  inheritedColors = null,
}: CheckBrandingSaveOptions): { css: string | null | undefined; warnings: SanitizeBrandingCssWarning[] } => {
  if (colors) {
    const details = [
      ...findBrandingTokenProblems(colors, WEB_RENDERING),
      ...findBrandingTokenProblems(colors, EMAIL_RENDERING),
    ].map((problem) => problem.detail);

    if (details.length > 0) {
      refuse([...new Set(details)]);
    }
  }

  const ownColors = colors !== undefined ? colors : parseColors(storedColors);
  const effectiveColors = colors || dropUnreadableBrandingTokens(ownColors ?? parseColors(inheritedColors));

  // The stylesheet that will render when the request does not set one: the row's, else inherited.
  const effectiveStoredCss = css === null ? inheritedCss : (storedCss ?? inheritedCss);

  if (typeof css === 'string') {
    const result = checkBrandingCssContrast(css, effectiveColors);

    if (result.refused) {
      throw new AppError(AppErrorCode.INVALID_BODY, { message: `Branding stylesheet not saved: ${result.refused}.` });
    }

    return { css: result.css, warnings: result.warnings };
  }

  if (colors !== undefined && effectiveStoredCss) {
    const result = checkBrandingCssContrast(sanitizeBrandingCss(effectiveStoredCss).css, effectiveColors);

    if (result.refused) {
      throw new AppError(AppErrorCode.INVALID_BODY, { message: `Branding not saved: ${result.refused}.` });
    }

    if (result.warnings.length > 0) {
      refuse(result.warnings.map((warning) => `the stored stylesheet's ${warning.detail}`));
    }
  }

  return { css, warnings: [] };
};
