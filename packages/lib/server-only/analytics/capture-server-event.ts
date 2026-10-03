/**
 * Server-side product analytics, permanently inert on this deployment.
 *
 * Upstream Documenso posted these events directly to `https://eu.i.posthog.com`
 * (a hardcoded host, not configurable), carrying the numeric user, organisation
 * and team identifiers plus, at several call sites, the envelope and recipient
 * identifiers. Those identifiers join straight back to a named signatory and a
 * named contract in our own database, so the events were pseudonymous rather
 * than anonymous.
 *
 * This instance must not disclose usage patterns to a third party, so the
 * PostHog client has been removed along with the `posthog-node` dependency.
 * The function is retained as a no-op so the eleven call sites in the tRPC
 * routers and embed loaders keep compiling and keep reading honestly. No
 * environment variable can switch it back on.
 */
type CaptureServerEventOptions = {
  event: string;
  userId?: number;
  organisationId?: string;
  teamId?: number;
  properties?: Record<string, unknown>;
};

export const captureServerEvent = (_options: CaptureServerEventOptions) => {
  return;
};
