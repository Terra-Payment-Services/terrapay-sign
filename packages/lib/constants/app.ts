import { env } from '@documenso/lib/utils/env';
import { AppError, AppErrorCode } from '../errors/app-error';
import { SignatureLevel, type TSignatureLevel } from '../types/signature-level';

export const APP_DOCUMENT_UPLOAD_SIZE_LIMIT = Number(env('NEXT_PUBLIC_DOCUMENT_SIZE_UPLOAD_LIMIT')) || 50;

export const NEXT_PUBLIC_WEBAPP_URL = () => env('NEXT_PUBLIC_WEBAPP_URL') ?? 'http://localhost:3000';

/**
 * The sub-path the app is served under (no trailing slash), e.g. "/ESign".
 * Returns an empty string when served at root.
 *
 * Prefers the explicit NEXT_PUBLIC_BASE_PATH (which is the same value baked
 * into the Vite/React Router build). Falls back to the pathname of
 * NEXT_PUBLIC_WEBAPP_URL so the function still works in dev when the env
 * variable is unset.
 *
 * Avoid using this to build URLs, use {@link formatPath} instead. Reserve this
 * for cases where the raw prefix itself is needed, such as path comparisons.
 */
export const getBasePath = (): string => {
  const explicit = env('NEXT_PUBLIC_BASE_PATH');

  if (explicit) {
    return explicit.replace(/\/$/, '');
  }

  try {
    return new URL(NEXT_PUBLIC_WEBAPP_URL()).pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
};

/**
 * Prefix a root-relative path with the app's base path.
 *
 * `formatPath('/api/trpc')` -> `/ESign/api/trpc` under sub-path hosting,
 * `/api/trpc` otherwise.
 */
export const formatPath = (path: string): string => {
  return `${getBasePath()}${path}`;
};

export const NEXT_PUBLIC_SIGNING_CONTACT_INFO = () =>
  env('NEXT_PUBLIC_SIGNING_CONTACT_INFO') ?? NEXT_PUBLIC_WEBAPP_URL();

/**
 * The reason recorded inside the signature dictionary. Readers show this in the
 * signature panel, so it should name the organisation operating the instance
 * rather than the software.
 */
export const NEXT_PUBLIC_SIGNING_REASON = () => env('NEXT_PUBLIC_SIGNING_REASON') ?? 'Signed via TerraPay Sign';

export const NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER = () =>
  env('NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER') === 'true';

export const NEXT_PRIVATE_INTERNAL_WEBAPP_URL = () =>
  env('NEXT_PRIVATE_INTERNAL_WEBAPP_URL') ?? NEXT_PUBLIC_WEBAPP_URL();

/**
 * Whether this instance is Documenso Cloud (managed SaaS).
 *
 * Used so we can show a different UI for Documenso Cloud and self-hosted instances since
 * there are things like billing, upsells, documenso links, etc that don't make sense for self-hosted instances.
 */
export const IS_DOCUMENSO_CLOUD = () => env('NEXT_PUBLIC_IS_DOCUMENSO_CLOUD') === 'true';

export const API_V2_BETA_URL = '/api/v2-beta';
export const API_V2_URL = '/api/v2';

export const SUPPORT_EMAIL = env('NEXT_PUBLIC_SUPPORT_EMAIL') ?? 'it.support@terrapay.com';

export const USE_INTERNAL_URL_BROWSERLESS = () => env('NEXT_PUBLIC_USE_INTERNAL_URL_BROWSERLESS') === 'true';

/**
 * Returns whether AI features are configured for this instance.
 *
 * Permanently false on this deployment. Upstream Documenso rasterised every page
 * of an envelope to JPEG and posted it, together with each recipient's name and
 * email address, to Google's Vertex endpoint at aiplatform.googleapis.com. That
 * sends commercial contract content and signatory identities to a third party,
 * which this instance must never do, so the detection routes, the Vertex client
 * and the AI SDK dependency have all been removed from the tree.
 *
 * This returns a literal rather than reading configuration on purpose: there is
 * no environment variable that can switch the behaviour back on, and the code it
 * used to reach no longer exists.
 */
export const IS_AI_FEATURES_CONFIGURED = (): boolean => false;

/**
 * Temporary flag to toggle between Playwright-based and Konva-based PDF generation
 * for audit logs during sealing.
 *
 * @deprecated This is a temporary flag and will be removed once Konva-based generation is stable.
 */
export const NEXT_PRIVATE_USE_PLAYWRIGHT_PDF = () => env('NEXT_PRIVATE_USE_PLAYWRIGHT_PDF') === 'true';

export const NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY = () => env('NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY');

export const NEXT_PRIVATE_SIGNING_TRANSPORT = () => env('NEXT_PRIVATE_SIGNING_TRANSPORT') || 'local';

/**
 * Configuration for the `remote-csc` signing transport, an independent
 * implementation of Cloud Signature Consortium (CSC) API v2.0 remote signing.
 *
 * These are deliberately named `..._REMOTE_CSC_...` rather than `..._CSC_...`
 * because the latter prefix is already taken by the enterprise CSC transport
 * and the two are configured separately.
 */
export const NEXT_PRIVATE_SIGNING_REMOTE_CSC_BASE_URL = () => env('NEXT_PRIVATE_SIGNING_REMOTE_CSC_BASE_URL');

export const NEXT_PRIVATE_SIGNING_REMOTE_CSC_CLIENT_ID = () => env('NEXT_PRIVATE_SIGNING_REMOTE_CSC_CLIENT_ID');

export const NEXT_PRIVATE_SIGNING_REMOTE_CSC_CLIENT_SECRET = () => env('NEXT_PRIVATE_SIGNING_REMOTE_CSC_CLIENT_SECRET');

export const NEXT_PRIVATE_SIGNING_REMOTE_CSC_CREDENTIAL_ID = () => env('NEXT_PRIVATE_SIGNING_REMOTE_CSC_CREDENTIAL_ID');

export const NEXT_PRIVATE_SIGNING_REMOTE_CSC_PIN = () => env('NEXT_PRIVATE_SIGNING_REMOTE_CSC_PIN');

/**
 * SHA-256 fingerprint of the leaf certificate the `remote-csc` credential must
 * present, as hex with optional colons.
 *
 * Optional, and strongly recommended. The transport verifies every signature
 * against the certificate the provider returned, so without a pin that check
 * says the provider's response was self-consistent and nothing more.
 */
export const NEXT_PRIVATE_SIGNING_REMOTE_CSC_CERTIFICATE_SHA256 = () =>
  env('NEXT_PRIVATE_SIGNING_REMOTE_CSC_CERTIFICATE_SHA256');

/**
 * Whether this Documenso instance is running in CSC (Cloud Signature Consortium) mode.
 *
 * CSC mode routes signing through a third-party Trust Service Provider for
 * Advanced and Qualified Electronic Signatures (AES/QES). It is instance-wide
 * and mutually exclusive with the other signing transports.
 */
export const IS_INSTANCE_CSC_MODE = (): boolean => {
  if (typeof window === 'undefined') {
    return env('NEXT_PRIVATE_SIGNING_TRANSPORT') === 'csc';
  }

  return env('NEXT_PUBLIC_SIGNING_TRANSPORT_IS_CSC') === 'true';
};

/**
 * The default signature level applied to envelopes created on a CSC-mode
 * instance when the caller doesn't specify one (or asks for `SES` and the
 * resolver is in loose-coerce mode).
 *
 * Set via `NEXT_PRIVATE_SIGNING_CSC_SIGNATURE_LEVEL`; accepts `AES` or `QES`
 * only; defaults to `AES` when unset. An explicit `AES`/`QES` request on
 * envelope create still passes through unchanged — this constant only affects
 * the coerced default.
 *
 * Throws on an invalid value rather than silently falling back. A typo here
 * (e.g. `qes`) would otherwise silently downgrade qualified-tier instances
 * to advanced-tier, which has legal consequences.
 *
 * Only consulted on CSC-mode instances. Non-CSC instances always default to
 * `SES` regardless of this var.
 */
export const CSC_INSTANCE_SIGNATURE_LEVEL = (): TSignatureLevel => {
  // Cast through `string | undefined` because shells can deliver
  // `NEXT_PRIVATE_SIGNING_CSC_SIGNATURE_LEVEL=` as an empty string at runtime
  // — the typed env signature narrows to `'AES' | 'QES' | undefined` only.
  const value = env('NEXT_PRIVATE_SIGNING_CSC_SIGNATURE_LEVEL');

  if (!value) {
    return SignatureLevel.AES;
  }

  if (value !== SignatureLevel.AES && value !== SignatureLevel.QES) {
    throw new AppError(AppErrorCode.NOT_SETUP, {
      message: `NEXT_PRIVATE_SIGNING_CSC_SIGNATURE_LEVEL must be '${SignatureLevel.AES}' or '${SignatureLevel.QES}', got '${value}'.`,
    });
  }

  return value;
};

/**
 * Microsoft Entra ID (Azure AD) directory reconciliation.
 *
 * These configure the scheduled job that disables Documenso accounts belonging
 * to people who have left the directory. See
 * `packages/lib/jobs/definitions/internal/reconcile-directory-access.ts`.
 *
 * The job is inert unless the tenant id, client id and client secret are all
 * set. The access group id is optional.
 */
export const NEXT_PRIVATE_ENTRA_TENANT_ID = () => env('NEXT_PRIVATE_ENTRA_TENANT_ID');

export const NEXT_PRIVATE_ENTRA_CLIENT_ID = () => env('NEXT_PRIVATE_ENTRA_CLIENT_ID');

export const NEXT_PRIVATE_ENTRA_CLIENT_SECRET = () => env('NEXT_PRIVATE_ENTRA_CLIENT_SECRET');

/**
 * The object id of the Entra group whose transitive membership confers access
 * to this instance.
 *
 * Optional. When it is unset, every enabled member (non-guest) user in the
 * tenant confers access, which needs only `User.Read.All`. Setting it narrows
 * access to the group and also needs `GroupMember.Read.All`.
 */
export const NEXT_PRIVATE_ENTRA_ACCESS_GROUP_ID = () => env('NEXT_PRIVATE_ENTRA_ACCESS_GROUP_ID');

/**
 * Whether the reconciliation job only reports what it would do.
 *
 * Dry run is the default and stays on until an operator sets the variable to
 * the exact string `false`. Anything else, including an unset variable, a typo
 * or an empty string, leaves the job read-only. A job that disables staff
 * accounts should need an explicit decision before it starts doing so.
 */
export const ENTRA_RECONCILE_DRY_RUN = () => env('NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN') !== 'false';

/**
 * Minimum directory membership the job will act on, counting the group's
 * members or, without a group, the tenant's member users.
 *
 * Default 10. A misconfigured group id, a revoked application permission or a
 * partially failed directory read all present as a small membership, and acting
 * on one would disable most of the instance. Ten is low enough not to block a
 * genuinely small deployment and high enough to catch the empty and near-empty
 * answers that misconfiguration produces. Set it near your real headcount for a
 * tighter guard.
 */
export const ENTRA_RECONCILE_MINIMUM_MEMBERS = () => {
  // Read the raw value first: a shell-supplied `FOO=` arrives as an empty
  // string, which `Number` turns into 0 and would silently switch the guard
  // off. An unusable value falls back to the default rather than to zero.
  const raw = env('NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS');

  if (!raw) {
    return 10;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
};

/**
 * Largest proportion of the accounts considered in a run that the job is
 * willing to disable, as a fraction between 0 and 1.
 *
 * Default 0.1. Ordinary attrition moves a fraction of a percent of staff in the
 * interval between runs, so ten percent in one run is already two orders of
 * magnitude above normal and reads as a directory or configuration fault rather
 * than an offboarding. Breaching it aborts the whole run rather than disabling
 * the first few.
 */
export const ENTRA_RECONCILE_MAX_DISABLE_RATIO = () => {
  const parsed = Number(env('NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO'));

  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.1;
};

/**
 * SharePoint contract archive.
 *
 * These configure the job that files every completed document into a SharePoint
 * document library, so that the retention, eDiscovery and sensitivity labelling
 * already applied to that library apply to executed contracts too. See
 * `packages/lib/jobs/definitions/internal/archive-envelope.ts`.
 *
 * The archive is inert unless the tenant, client id, client secret, site id and
 * drive id all resolve. Nothing about signing or sealing depends on it.
 */

/**
 * Tenant holding the app registration used to reach SharePoint.
 *
 * Falls back to the Entra directory tenant, because a self-hosted instance
 * normally has one tenant and setting the same value twice invites drift.
 */
export const NEXT_PRIVATE_SHAREPOINT_TENANT_ID = () =>
  env('NEXT_PRIVATE_SHAREPOINT_TENANT_ID') || NEXT_PRIVATE_ENTRA_TENANT_ID();

/**
 * Application (client) id used to reach SharePoint.
 *
 * Falls back to the Entra directory client id, which shares one app
 * registration between the two features. Sharing means that single registration
 * holds `GroupMember.Read.All`, `User.Read.All` and `Sites.Selected` together,
 * so one leaked secret reads the directory and writes the contract library.
 * Separate registrations are the better posture and are what these variables
 * exist for; the fallback is a convenience for a small deployment that has
 * decided otherwise.
 */
export const NEXT_PRIVATE_SHAREPOINT_CLIENT_ID = () =>
  env('NEXT_PRIVATE_SHAREPOINT_CLIENT_ID') || NEXT_PRIVATE_ENTRA_CLIENT_ID();

/**
 * Client secret for the SharePoint app registration. Never logged.
 *
 * Falls back to the Entra directory secret only when the client id also falls
 * back, so a deployment that names its own client id can never accidentally
 * authenticate it with the directory job's secret.
 */
export const NEXT_PRIVATE_SHAREPOINT_CLIENT_SECRET = () => {
  const secret = env('NEXT_PRIVATE_SHAREPOINT_CLIENT_SECRET');

  if (secret) {
    return secret;
  }

  return env('NEXT_PRIVATE_SHAREPOINT_CLIENT_ID') ? undefined : NEXT_PRIVATE_ENTRA_CLIENT_SECRET();
};

/**
 * Graph site id of the target site, in the `hostname,siteCollectionId,siteId`
 * form returned by `GET /sites/{hostname}:/sites/{path}`.
 */
export const NEXT_PRIVATE_SHAREPOINT_SITE_ID = () => env('NEXT_PRIVATE_SHAREPOINT_SITE_ID');

/**
 * Drive id of the document library within that site, from
 * `GET /sites/{siteId}/drives`.
 */
export const NEXT_PRIVATE_SHAREPOINT_DRIVE_ID = () => env('NEXT_PRIVATE_SHAREPOINT_DRIVE_ID');

/**
 * Folder path template, relative to the drive root, supporting the tokens
 * `{yyyy}`, `{MM}` and `{dd}` taken from the completion date in UTC.
 *
 * Defaults to a year and month tree, which keeps a library browsable at the
 * volume a contract archive accumulates and lines up with how retention is
 * usually reasoned about.
 */
export const SHAREPOINT_ARCHIVE_FOLDER_TEMPLATE = () =>
  env('NEXT_PRIVATE_SHAREPOINT_FOLDER_TEMPLATE') || 'Contracts/{yyyy}/{MM}';

/**
 * Optional floor on how far back the sweep will look for unfiled documents,
 * as an ISO 8601 date.
 *
 * Unset means no floor, so enabling the archive on an existing instance
 * backfills the whole history a batch at a time. Set it to the go-live date to
 * file only what completes from then on.
 */
export const SHAREPOINT_ARCHIVE_FLOOR = (): Date | undefined => {
  const raw = env('NEXT_PRIVATE_SHAREPOINT_ARCHIVE_FROM');

  if (!raw) {
    return undefined;
  }

  const parsed = new Date(raw);

  // An unparseable date must not become an accidental "file nothing", so a bad
  // value falls back to no floor.
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
};

/**
 * Destination for the "Contact Sales" buttons on the enterprise upsell panels.
 *
 * Upstream pointed these at https://documen.so/enterprise-cta. Clicking one told
 * Documenso that this instance exists and that somebody here was looking at
 * enterprise features, so the vendor URL has been removed and the buttons now
 * stay on our own origin.
 *
 * These panels advertise Documenso Cloud plans that a self-hosted instance is
 * not part of, so the right long-term fix is to remove the upsell components
 * rather than to repoint them. Pending that decision, this needs a real
 * TerraPay destination.
 */
export const DOCUMENSO_CLOUD_ENTERPRISE_CTA_URL = '/';
