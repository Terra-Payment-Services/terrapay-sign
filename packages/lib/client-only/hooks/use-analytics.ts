/**
 * Browser analytics, permanently inert on this deployment.
 *
 * Upstream Documenso wired these four functions to posthog-js, which sent
 * pageviews, automatically captured exceptions with stack traces, and two
 * explicit events carrying the user's plaintext email address, to PostHog's
 * EU cloud by way of the same-origin `/ingest` reverse proxy. Session
 * recording was also switchable on remotely from the PostHog project console
 * without any change here.
 *
 * TerraPay self-hosts this instance so that contract content, signatory
 * identities and usage patterns stay inside our own infrastructure, so the
 * whole path is gone: posthog-js is no longer a dependency, the `/ingest`
 * proxy route has been deleted, and these are unconditional no-ops.
 *
 * The functions are kept rather than removed because roughly fifty call sites
 * across the signing and editor flows call `captureException` in their error
 * handlers. Keeping the shape means those handlers stay intact and there is
 * exactly one place to look to confirm nothing is transmitted. There is no
 * environment variable that can switch any of this back on.
 */
export function useAnalytics() {
  const capture = (_event: string, _properties?: Record<string, unknown>) => {
    return;
  };

  const captureException = (_error: unknown, _properties?: Record<string, unknown>) => {
    return;
  };

  const startSessionRecording = (_eventFlag?: string) => {
    return;
  };

  const stopSessionRecording = () => {
    return;
  };

  return {
    capture,
    captureException,
    startSessionRecording,
    stopSessionRecording,
  };
}
