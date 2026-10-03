// Kept free of the lingui macro so Playwright specs can import it.

/**
 * Placeholder recipients are written as `recipient.N@<domain>`. New rows use the
 * RFC 2606 `.invalid` domain, which can never resolve, so a placeholder that
 * slips through to a send cannot reach a real mailbox.
 */
export const PLACEHOLDER_RECIPIENT_EMAIL_DOMAIN = 'placeholder.invalid';

/**
 * The domain upstream Documenso wrote. Existing rows still carry it, so it is
 * matched on read and never written.
 */
export const LEGACY_PLACEHOLDER_RECIPIENT_EMAIL_DOMAIN = 'documenso.com';

export const TEMPLATE_RECIPIENT_EMAIL_PLACEHOLDER_REGEX = /recipient\.\d+@(?:documenso\.com|placeholder\.invalid)/i;

export const formatPlaceholderRecipientEmail = (index: number) => {
  return `recipient.${index}@${PLACEHOLDER_RECIPIENT_EMAIL_DOMAIN}`;
};

export const isTemplateRecipientEmailPlaceholder = (email: string) => {
  return TEMPLATE_RECIPIENT_EMAIL_PLACEHOLDER_REGEX.test(email);
};

/**
 * Whether `email` is the placeholder for recipient `index`, in either the
 * current or the legacy form.
 */
export const isPlaceholderRecipientEmailForIndex = (email: string, index: number) => {
  const normalised = email.toLowerCase();

  return (
    normalised === formatPlaceholderRecipientEmail(index) ||
    normalised === `recipient.${index}@${LEGACY_PLACEHOLDER_RECIPIENT_EMAIL_DOMAIN}`
  );
};
