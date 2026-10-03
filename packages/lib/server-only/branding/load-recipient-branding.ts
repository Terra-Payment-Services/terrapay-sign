import type { TCssVarsSchema } from '../../types/css-vars';
import { ZCssVarsSchema } from '../../types/css-vars';
import { getTeamSettings } from '../team/get-team-settings';

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
  const parsedColors = settings.brandingColors ? ZCssVarsSchema.safeParse(settings.brandingColors) : null;

  return {
    allowCustomBranding: true,
    hidePoweredBy,
    colors: parsedColors?.success ? parsedColors.data : null,
    css: settings.brandingCss && settings.brandingCss.length > 0 ? settings.brandingCss : null,
  };
};
