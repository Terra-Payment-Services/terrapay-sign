import type { TCssVarsSchema } from '@documenso/lib/types/css-vars';
import { useEffect } from 'react';

import { toNativeCssVarsString } from '~/utils/css-vars';

import { guardBranding } from './recipient-branding-guard';

export type RecipientBrandingPayload = {
  allowCustomBranding: boolean;
  colors?: TCssVarsSchema | null;
  css?: string | null;
};

export type RecipientBrandingProps = {
  branding: RecipientBrandingPayload | null | undefined;
  cspNonce: string | undefined;
};

/**
 * Renders the branding `<style nonce>` blocks for a recipient route, scoped to the
 * `documenso-branded` class `root.tsx` puts on `<body>`.
 *
 * The CSS variables (from `branding.colors`) sit in `.documenso-branded { ... }`. The user's
 * custom CSS (from `branding.css`) is nested in the class repeated three times, so the user
 * doesn't need to scope their own selectors and every rule outranks the app's state classes:
 *
 *   .documenso-branded.documenso-branded.documenso-branded {
 *     .my-class { color: red; }
 *   }
 *
 * Equivalent to `.documenso-branded.documenso-branded.documenso-branded .my-class` after
 * expansion, at least (0,3,1) for a type selector, above the app's `hover:` classes (0,2,0) and
 * `group-hover:` forms (0,3,0), so colours a tenant sets hold in every state (round 14).
 *
 * The user's CSS is sanitised at write time (`sanitizeBrandingCss`) and stored
 * in the DB as-is — no per-render parsing.
 *
 * Why both SSR `<style>` and a `useEffect` injection?
 *
 * The rendered `<style>` covers the initial server render so the first paint
 * already has the branding applied — without it, the page would flash the
 * default theme before hydration.
 *
 * The `useEffect` covers in-app client-side navigations. When the user
 * navigates between recipient routes via the router, the server render
 * doesn't run again, so React reconciles the existing DOM. If the loader
 * data changes (e.g. a different recipient with different branding), the
 * SSR'd `<style>` from the previous page may persist or be reused, leading
 * to stale or inconsistent branding. Appending a fresh `<style>` to
 * `document.head` and removing it on cleanup guarantees the active branding
 * matches the current route on both initial load and subsequent navigations.
 */
export const RecipientBranding = ({ branding, cspNonce }: RecipientBrandingProps) => {
  const varsString = toNativeCssVarsString(branding?.colors ?? {});

  const userCss = branding?.css ?? '';

  const hasVars = varsString.trim().length > 0;
  const hasUserCss = userCss.trim().length > 0;

  // Tokens and the tenant stylesheet are separate elements, so the contrast guard can disable the
  // stylesheet first and the tokens only if the page still fails (round 22). The guard finds
  // the token elements by `data-branding-tokens`.
  const varsCss = `.documenso-branded { ${varsString} }`;
  const userStyleCss = `.documenso-branded.documenso-branded.documenso-branded { ${userCss} }`;

  useEffect(() => {
    if (!branding?.allowCustomBranding || !hasVars) {
      return;
    }

    const style = document.createElement('style');
    style.setAttribute('nonce', cspNonce ?? '');
    style.setAttribute('data-branding-tokens', '');
    style.textContent = varsCss;

    document.head.appendChild(style);

    return () => {
      document.head.removeChild(style);
    };
  }, [branding, cspNonce, varsCss, hasVars]);

  useEffect(() => {
    if (!branding?.allowCustomBranding || (!hasUserCss && !hasVars)) {
      return;
    }

    // Appended unapplied; the guard applies it and measures in the same task, so an unreadable
    // stylesheet is never painted. With tokens and no stylesheet the guard watches the tokens alone.
    let style: HTMLStyleElement | null = null;

    if (hasUserCss) {
      style = document.createElement('style');
      style.setAttribute('nonce', cspNonce ?? '');
      style.setAttribute('media', 'not all');
      style.textContent = userStyleCss;

      document.head.appendChild(style);
    }

    const stop = guardBranding(style);

    return () => {
      stop();
      style?.remove();
    };
  }, [branding, cspNonce, userStyleCss, hasUserCss, hasVars]);

  if (!branding?.allowCustomBranding) {
    return null;
  }

  // Without JavaScript the guard cannot run, so the stylesheet is served only inside <noscript>
  // and the save-time check is the one layer. A stylesheet that could close the element is left out.
  const noscriptHtml =
    hasUserCss && !/<\//.test(userStyleCss) ? `<style nonce="${cspNonce ?? ''}">${userStyleCss}</style>` : '';

  return (
    <>
      {hasVars && (
        <style nonce={cspNonce} data-branding-tokens="">
          {varsCss}
        </style>
      )}
      {noscriptHtml && <noscript dangerouslySetInnerHTML={{ __html: noscriptHtml }} />}
    </>
  );
};
