/**
 * What the admin panel says about the running build.
 *
 * The pipeline stamps the release tag, commit and build time into the image as
 * APP_VERSION, GIT_SHA and BUILD_TIMESTAMP. A build made any other way, such as
 * a local `npm run dev`, has none of them and reports itself as `dev`.
 *
 * @param stamp - the three values as the process environment holds them
 * @param upstreamVersion - the Documenso version this fork is based on
 * @returns the release to show large, and a detail line of commit, build time
 *   and upstream base
 */
export const describeBuild = (
  stamp: { appVersion?: string; gitSha?: string; buildTimestamp?: string },
  upstreamVersion: string,
): { release: string; detail: string } => {
  const release = stamp.appVersion?.trim() || 'dev';

  const detail = [
    stamp.gitSha?.trim().slice(0, 9),
    stamp.buildTimestamp
      ?.trim()
      .replace(/:\d\dZ$/, 'Z')
      .replace('T', ' '),
    `Documenso ${upstreamVersion}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return { release, detail };
};
