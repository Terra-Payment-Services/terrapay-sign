import {
  NEXT_PRIVATE_SHAREPOINT_CLIENT_ID,
  NEXT_PRIVATE_SHAREPOINT_CLIENT_SECRET,
  NEXT_PRIVATE_SHAREPOINT_DRIVE_ID,
  NEXT_PRIVATE_SHAREPOINT_SITE_ID,
  NEXT_PRIVATE_SHAREPOINT_TENANT_ID,
  SHAREPOINT_ARCHIVE_FOLDER_TEMPLATE,
} from '../../constants/app';
import type { MicrosoftGraphCredentials } from '../microsoft-graph/graph-auth';
import type { SharePointTarget } from '../microsoft-graph/sharepoint-upload';

/**
 * Configuration for the SharePoint contract archive.
 *
 * Kept out of the job handlers so that "configured" has exactly one definition,
 * shared by the per-envelope job and the sweep, and so that the no-op path can
 * be tested without standing up a database client.
 */

export type SharePointArchiveConfig = {
  credentials: MicrosoftGraphCredentials;
  target: SharePointTarget;
  folderPathTemplate: string;
};

/**
 * Logged once per run when the archive is switched off, naming every variable
 * an operator has to set. An unconfigured archive is a clean no-op, not a
 * warning and not a failure.
 */
export const SHAREPOINT_ARCHIVE_UNCONFIGURED_MESSAGE =
  '[sharepoint-archive] Skipping run: the SharePoint contract archive is not configured. Set ' +
  'NEXT_PRIVATE_SHAREPOINT_TENANT_ID, NEXT_PRIVATE_SHAREPOINT_CLIENT_ID, ' +
  'NEXT_PRIVATE_SHAREPOINT_CLIENT_SECRET, NEXT_PRIVATE_SHAREPOINT_SITE_ID and ' +
  'NEXT_PRIVATE_SHAREPOINT_DRIVE_ID to enable it.';

/**
 * Read the archive configuration, or null when the feature is not set up.
 *
 * All five values are required together. A partial configuration is treated as
 * no configuration rather than as an error, because the one thing this feature
 * must never do is interfere with signing.
 */
export const getSharePointArchiveConfig = (): SharePointArchiveConfig | null => {
  const tenantId = NEXT_PRIVATE_SHAREPOINT_TENANT_ID();
  const clientId = NEXT_PRIVATE_SHAREPOINT_CLIENT_ID();
  const clientSecret = NEXT_PRIVATE_SHAREPOINT_CLIENT_SECRET();
  const siteId = NEXT_PRIVATE_SHAREPOINT_SITE_ID();
  const driveId = NEXT_PRIVATE_SHAREPOINT_DRIVE_ID();

  if (!tenantId || !clientId || !clientSecret || !siteId || !driveId) {
    return null;
  }

  return {
    credentials: { tenantId, clientId, clientSecret },
    target: { siteId, driveId },
    folderPathTemplate: SHAREPOINT_ARCHIVE_FOLDER_TEMPLATE(),
  };
};
