import { dynamicActivate } from '@documenso/lib/utils/i18n';
import { i18n } from '@lingui/core';
import { detect, fromHtmlTag } from '@lingui/detect-locale';
import { I18nProvider } from '@lingui/react';
import { StrictMode, startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

import './utils/polyfills/promise-with-resolvers';

/**
 * Surfaces hydration recoveries (React 19 discards the server HTML and
 * re-renders on the client instead of dying).
 *
 * Upstream also shipped this to PostHog, along with pageviews and automatic
 * exception capture. On this deployment the browser must not talk to any
 * analytics vendor, so the report stays in the console and posthog-js is no
 * longer loaded or bundled at all. See `use-analytics.ts` for the rest.
 */
function onRecoverableError(error: unknown, errorInfo: { componentStack?: string }) {
  console.error('[hydration] recovered from error', error, errorInfo.componentStack);
}

async function main() {
  const locale = detect(fromHtmlTag('lang')) || 'en';

  await dynamicActivate(locale);

  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <I18nProvider i18n={i18n}>
          <HydratedRouter />
        </I18nProvider>
      </StrictMode>,
      { onRecoverableError },
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
