import type { TCssVarsSchema } from '../../types/css-vars';
import { ZStoredCssVarsSchema } from '../../types/css-vars';
import { dropUnreadableBrandingTokens } from '../../utils/branding-contrast';
import { getTeamSettings } from '../team/get-team-settings';
import { renderStoredBrandingCss } from './branding-css-cache';

export type RecipientBrandingPayload = {
  allowCustomBranding: boolean;
  hidePoweredBy: boolean;
  colors: TCssVarsSchema | null;
  css: string | null;
};

/**
 * Resolve the branding payload for a recipient-facing route, given the team
 * the envelope/document belongs to. Reads inherited team-or-org branding settings
 * and returns a payload safe to send to the client.
 *
 * Returns a minimal disabled payload if the team has branding switched off.
 */
export const loadRecipientBrandingByTeamId = async ({
  teamId,
}: {
  teamId: number;
}): Promise<RecipientBrandingPayload> => {
  const settings = await getTeamSettings({ teamId });

  // There is no billing plan to restrict branding, so custom branding is
  // allowed and the "Powered by" badge is always hidden.
  let allowCustomBranding = true;
  const hidePoweredBy = true;

  if (!settings.brandingEnabled) {
    allowCustomBranding = false;
  }

  if (!allowCustomBranding) {
    return {
      allowCustomBranding: false,
      hidePoweredBy,
      colors: null,
      css: null,
    };
  }

  // brandingColors is stored as JSON; parse defensively. Drop unknown keys via Zod.
  const parsedColors = settings.brandingColors ? ZStoredCssVarsSchema.safeParse(settings.brandingColors) : null;

  // Rows saved before the contrast check may hold unreadable pairs; leave those out.
  const colors = dropUnreadableBrandingTokens(parsedColors?.success ? parsedColors.data : null);

  // Sanitise again on the way out: CSS saved before the sanitiser tightened is still in the
  // database, and this keeps every stored row to today's rules. The result is cached.
  const css = settings.brandingCss ? renderStoredBrandingCss(settings.brandingCss, colors) : '';

  return {
    allowCustomBranding: true,
    hidePoweredBy,
    colors,
    css: css.length > 0 ? css : null,
  };
};
