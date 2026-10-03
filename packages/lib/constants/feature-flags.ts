/**
 * Feature flags.
 *
 * Upstream resolved flags through posthog-js, which POSTed to PostHog's
 * `/flags` endpoint on every page load carrying the visitor's distinct id,
 * person properties and current URL. That integration has been removed for
 * this deployment, so no flags are fetched from anywhere and nothing is
 * transmitted. The former `extractPostHogConfig` helper and the
 * `NEXT_PUBLIC_POSTHOG_KEY` variable it read are gone; setting that variable
 * now has no effect anywhere in the tree.
 */
export const FEATURE_FLAG_GLOBAL_SESSION_RECORDING = 'global_session_recording';
