import { getBasePath, NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';

/**
 * The origin of the web app, ignoring any sub-path NEXT_PUBLIC_WEBAPP_URL carries.
 */
const getWebAppOrigin = () => {
  try {
    return new URL(NEXT_PUBLIC_WEBAPP_URL()).origin;
  } catch {
    return NEXT_PUBLIC_WEBAPP_URL();
  }
};

export const isValidReturnTo = (returnTo?: string) => {
  if (!returnTo) {
    return false;
  }

  try {
    // Decode if it's URL encoded
    const decodedReturnTo = decodeURIComponent(returnTo);
    const returnToUrl = new URL(decodedReturnTo, NEXT_PUBLIC_WEBAPP_URL());

    // Compare against the origin, not the raw env value: when the app is served
    // under a sub-path NEXT_PUBLIC_WEBAPP_URL is e.g. "https://host/ESign", which
    // never equals a URL's origin ("https://host").
    if (returnToUrl.origin !== getWebAppOrigin()) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
};

export const normalizeReturnTo = (returnTo?: string) => {
  if (!returnTo) {
    return undefined;
  }

  try {
    // Decode if it's URL encoded
    const decodedReturnTo = decodeURIComponent(returnTo);
    const returnToUrl = new URL(decodedReturnTo, NEXT_PUBLIC_WEBAPP_URL());

    const basePath = getBasePath();

    // "/.//evil.com" resolves to the pathname "//evil.com", which a browser reads as a
    // protocol-relative URL, so collapse any leading run of slashes to one.
    let pathname = returnToUrl.pathname.replace(/^[/\\]+/, '/');

    // A root-relative returnTo ("/inbox") resolves to a pathname without the
    // sub-path, so re-apply it when it is missing.
    if (basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      pathname = `${basePath}${pathname}`;
    }

    const normalized = `${pathname}${returnToUrl.search}${returnToUrl.hash}`;

    // Check the string the caller will redirect to, not only the URL it came from.
    if (new URL(normalized, NEXT_PUBLIC_WEBAPP_URL()).origin !== getWebAppOrigin()) {
      return undefined;
    }

    return normalized;
  } catch {
    return undefined;
  }
};
