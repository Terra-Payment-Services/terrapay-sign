// Put into a separate file due to Playwright not compiling due to the macro in the templates.ts file.
export const DIRECT_TEMPLATE_RECIPIENT_EMAIL = 'direct.link@placeholder.invalid';

/**
 * The address upstream Documenso wrote for the direct-link recipient. Templates
 * created before the change still carry it, so it is matched and never written.
 */
export const LEGACY_DIRECT_TEMPLATE_RECIPIENT_EMAIL = 'direct.link@documenso.com';

export const DIRECT_TEMPLATE_RECIPIENT_EMAILS = [
  DIRECT_TEMPLATE_RECIPIENT_EMAIL,
  LEGACY_DIRECT_TEMPLATE_RECIPIENT_EMAIL,
];

export const DIRECT_TEMPLATE_RECIPIENT_NAME = 'Direct link recipient';

export const isDirectTemplateRecipientEmail = (email: string) => {
  return DIRECT_TEMPLATE_RECIPIENT_EMAILS.includes(email.toLowerCase());
};
