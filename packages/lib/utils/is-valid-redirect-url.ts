const ALLOWED_PROTOCOLS = ['http', 'https'];

export const isValidRedirectUrl = (value: string) => {
  // The URL parser strips tabs and newlines, but a redirect header cannot carry them.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    return false;
  }

  try {
    const url = new URL(value);

    if (!ALLOWED_PROTOCOLS.includes(url.protocol.slice(0, -1).toLowerCase())) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
};
