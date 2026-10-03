/**
 * Server-side captcha verification, permanently inert on this deployment.
 *
 * Upstream supported Cloudflare Turnstile. When `NEXT_PRIVATE_TURNSTILE_SECRET_KEY`
 * was set, this posted the challenge token and the visitor's IP address to
 * `https://challenges.cloudflare.com/turnstile/v0/siteverify`, and the matching
 * browser widget loaded Cloudflare's `api.js`, which sees the visitor's IP,
 * user agent, TLS fingerprint and behavioural signals.
 *
 * This instance must not disclose anything about who is using it, so the
 * Turnstile widget has been removed from the sign in, sign up and claim account
 * forms and this verifier no longer calls out. The two functions had to be
 * disabled together: leaving the server side live while removing the widget
 * would have rejected every sign in the moment someone set the secret key.
 *
 * Both `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `NEXT_PRIVATE_TURNSTILE_SECRET_KEY`
 * are now inert. If bot protection on the authentication forms is ever wanted,
 * it needs a deliberate code change and a provider we host ourselves, not an
 * environment variable.
 */
export const verifyCaptchaToken = (_options: { token?: string | null; ipAddress?: string | null }): Promise<void> =>
  Promise.resolve();
