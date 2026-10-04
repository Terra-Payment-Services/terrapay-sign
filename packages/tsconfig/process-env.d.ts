declare namespace NodeJS {
  export interface ProcessEnv {
    PORT?: string;
    NEXT_PUBLIC_WEBAPP_URL?: string;

    NEXT_PRIVATE_GOOGLE_CLIENT_ID?: string;
    NEXT_PRIVATE_GOOGLE_CLIENT_SECRET?: string;

    NEXT_PRIVATE_OIDC_WELL_KNOWN?: string;
    NEXT_PRIVATE_OIDC_CLIENT_ID?: string;
    NEXT_PRIVATE_OIDC_CLIENT_SECRET?: string;
    NEXT_PRIVATE_OIDC_PROVIDER_LABEL?: string;
    NEXT_PRIVATE_OIDC_SKIP_VERIFY?: string;
    /**
     * Lets OpenID discovery reach an authority on a local or private address,
     * for a developer running an identity provider on their own machine. Needs
     * NODE_ENV to be something other than production and the app to be served
     * over plain http, so a real deployment cannot turn it on.
     */
    NEXT_PRIVATE_OIDC_ALLOW_LOCAL_AUTHORITY?: string;

    /**
     * How many proxies in front of the app append to X-Forwarded-For. The
     * client address is taken this many entries from the right. Defaults to 1.
     */
    NEXT_PRIVATE_TRUSTED_PROXY_HOPS?: string;

    NEXT_PRIVATE_DATABASE_URL: string;
    NEXT_PRIVATE_ENCRYPTION_KEY: string;
    NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY: string;

    NEXT_PRIVATE_LOGGER_FILE_PATH?: string;

    NEXT_PRIVATE_STRIPE_API_KEY: string;
    NEXT_PRIVATE_STRIPE_WEBHOOK_SECRET: string;

    NEXT_PUBLIC_UPLOAD_TRANSPORT?: 'database' | 's3' | 'azure-blob';
    NEXT_PRIVATE_UPLOAD_ENDPOINT?: string;
    NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE?: string;
    NEXT_PRIVATE_UPLOAD_REGION?: string;
    NEXT_PRIVATE_UPLOAD_BUCKET?: string;
    NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID?: string;
    NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY?: string;
    NEXT_PRIVATE_UPLOAD_DISTRIBUTION_DOMAIN?: string;
    NEXT_PRIVATE_UPLOAD_DISTRIBUTION_KEY_ID?: string;
    NEXT_PRIVATE_UPLOAD_DISTRIBUTION_KEY_CONTENTS?: string;
    NEXT_PRIVATE_UPLOAD_AZURE_ACCOUNT_NAME?: string;
    NEXT_PRIVATE_UPLOAD_AZURE_ACCOUNT_KEY?: string;
    NEXT_PRIVATE_UPLOAD_AZURE_CONTAINER?: string;
    NEXT_PRIVATE_UPLOAD_AZURE_ENDPOINT?: string;

    NEXT_PRIVATE_SIGNING_TRANSPORT?: 'local' | 'http' | 'gcloud-hsm' | 'csc' | 'remote-csc';
    /**
     * Derived from `NEXT_PRIVATE_SIGNING_TRANSPORT` in `createPublicEnv()`; do
     * not set manually. Lets the client detect CSC mode for authoring UI gating.
     */
    NEXT_PUBLIC_SIGNING_TRANSPORT_IS_CSC?: 'true' | 'false';
    NEXT_PRIVATE_SIGNING_PASSPHRASE?: string;
    NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH?: string;
    NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS?: string;
    NEXT_PRIVATE_SIGNING_LOCAL_FILE_ENCODING?: string;
    NEXT_PRIVATE_SIGNING_GCLOUD_HSM_KEY_PATH?: string;
    NEXT_PRIVATE_SIGNING_GCLOUD_HSM_PUBLIC_CRT_FILE_PATH?: string;
    NEXT_PRIVATE_SIGNING_GCLOUD_HSM_PUBLIC_CRT_FILE_CONTENTS?: string;
    NEXT_PRIVATE_SIGNING_GCLOUD_APPLICATION_CREDENTIALS_CONTENTS?: string;
    NEXT_PRIVATE_SIGNING_GCLOUD_HSM_CERT_CHAIN_FILE_PATH?: string;
    NEXT_PRIVATE_SIGNING_GCLOUD_HSM_CERT_CHAIN_CONTENTS?: string;
    NEXT_PRIVATE_SIGNING_GCLOUD_HSM_SECRET_MANAGER_CERT_PATH?: string;
    NEXT_PRIVATE_SIGNING_CSC_PROVIDER_BASE_URL?: string;
    NEXT_PRIVATE_SIGNING_CSC_OAUTH_CLIENT_ID?: string;
    NEXT_PRIVATE_SIGNING_CSC_OAUTH_CLIENT_SECRET?: string;
    NEXT_PRIVATE_SIGNING_CSC_SIGNATURE_LEVEL?: 'AES' | 'QES';
    NEXT_PRIVATE_SIGNING_REMOTE_CSC_BASE_URL?: string;
    NEXT_PRIVATE_SIGNING_REMOTE_CSC_CLIENT_ID?: string;
    NEXT_PRIVATE_SIGNING_REMOTE_CSC_CLIENT_SECRET?: string;
    NEXT_PRIVATE_SIGNING_REMOTE_CSC_CREDENTIAL_ID?: string;
    NEXT_PRIVATE_SIGNING_REMOTE_CSC_PIN?: string;
    NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY?: string;
    NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY_KEY_SHA256?: string;
    /**
     * How to treat a certificate whose revocation status cannot be
     * established. Strict, the default, fails the signing. Permissive warns
     * and signs anyway. Neither allows signing with a revoked certificate.
     */
    NEXT_PRIVATE_SIGNING_REVOCATION_MODE?: 'strict' | 'permissive';
    NEXT_PUBLIC_SIGNING_CONTACT_INFO?: string;
    NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER?: string;

    NEXT_PRIVATE_SMTP_TRANSPORT?: 'mailchannels' | 'resend' | 'smtp-auth' | 'smtp-api' | 'graph';

    NEXT_PRIVATE_RESEND_API_KEY?: string;

    NEXT_PRIVATE_MAILCHANNELS_API_KEY?: string;
    NEXT_PRIVATE_MAILCHANNELS_DKIM_DOMAIN?: string;
    NEXT_PRIVATE_MAILCHANNELS_DKIM_SELECTOR?: string;
    NEXT_PRIVATE_MAILCHANNELS_DKIM_PRIVATE_KEY?: string;
    NEXT_PRIVATE_MAILCHANNELS_ENDPOINT?: string;

    NEXT_PRIVATE_SMTP_HOST?: string;
    NEXT_PRIVATE_SMTP_PORT?: string;
    NEXT_PRIVATE_SMTP_USERNAME?: string;
    NEXT_PRIVATE_SMTP_PASSWORD?: string;

    NEXT_PRIVATE_SMTP_APIKEY_USER?: string;
    NEXT_PRIVATE_SMTP_APIKEY?: string;

    NEXT_PRIVATE_SMTP_SECURE?: string;
    NEXT_PRIVATE_SMTP_UNSAFE_IGNORE_TLS?: string;

    NEXT_PRIVATE_SMTP_FROM_NAME?: string;
    NEXT_PRIVATE_SMTP_FROM_ADDRESS?: string;

    NEXT_PUBLIC_DISABLE_SIGNUP?: string;
    NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP?: string;
    NEXT_PUBLIC_DISABLE_GOOGLE_SIGNUP?: string;
    NEXT_PUBLIC_DISABLE_MICROSOFT_SIGNUP?: string;
    NEXT_PUBLIC_DISABLE_OIDC_SIGNUP?: string;
    NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS?: string;

    NEXT_PUBLIC_DISABLE_SIGNIN?: string;
    NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN?: string;
    NEXT_PUBLIC_DISABLE_GOOGLE_SIGNIN?: string;
    NEXT_PUBLIC_DISABLE_MICROSOFT_SIGNIN?: string;
    NEXT_PUBLIC_DISABLE_OIDC_SIGNIN?: string;
    NEXT_PUBLIC_DISABLE_OIDC_AUTO_REDIRECT?: string;
    NEXT_PUBLIC_DISABLE_PASSKEY?: string;

    NEXT_PRIVATE_BROWSERLESS_URL?: string;

    NEXT_PRIVATE_JOBS_PROVIDER?: 'inngest' | 'local' | 'bullmq';

    NEXT_PUBLIC_USE_INTERNAL_URL_BROWSERLESS?: string;

    /**
     * Redis / BullMQ environment variables
     */
    NEXT_PRIVATE_REDIS_URL?: string;
    NEXT_PRIVATE_REDIS_PREFIX?: string;
    NEXT_PRIVATE_REDIS_CLUSTER?: string;
    NEXT_PRIVATE_BULLMQ_CONCURRENCY?: string;

    /**
     * Inngest environment variables
     */
    INNGEST_EVENT_KEY?: string;
    INNGEST_SIGNING_KEY?: string;
    NEXT_PRIVATE_INNGEST_APP_ID?: string;
    NEXT_PRIVATE_INNGEST_EVENT_KEY?: string;

    POSTGRES_URL?: string;
    DATABASE_URL?: string;
    POSTGRES_PRISMA_URL?: string;
    POSTGRES_URL_NON_POOLING?: string;

    /**
     * Cloudflare Turnstile environment variables
     */
    NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string;
    NEXT_PRIVATE_TURNSTILE_SECRET_KEY?: string;

    /**
     * Microsoft Entra ID (Azure AD) directory reconciliation environment variables.
     *
     * Consumed by the `internal.reconcile-directory-access` cron job, which
     * disables Documenso accounts for people who have left the directory.
     */
    NEXT_PRIVATE_ENTRA_TENANT_ID?: string;
    NEXT_PRIVATE_ENTRA_CLIENT_ID?: string;
    NEXT_PRIVATE_ENTRA_CLIENT_SECRET?: string;
    /**
     * Optional. Narrows access to this group's transitive membership. Unset,
     * every enabled member (non-guest) user in the tenant confers access.
     */
    NEXT_PRIVATE_ENTRA_ACCESS_GROUP_ID?: string;
    /** Anything other than the exact string "false" leaves the job in dry run. */
    NEXT_PRIVATE_ENTRA_RECONCILE_DRY_RUN?: string;
    NEXT_PRIVATE_ENTRA_RECONCILE_MINIMUM_MEMBERS?: string;
    NEXT_PRIVATE_ENTRA_RECONCILE_MAX_DISABLE_RATIO?: string;

    /**
     * SharePoint contract archive environment variables.
     *
     * Consumed by the `internal.archive-envelope` job and its sweep, which file
     * a copy of every completed document into a SharePoint document library.
     * The tenant, client id and client secret fall back to the Entra values
     * above when unset.
     */
    NEXT_PRIVATE_SHAREPOINT_TENANT_ID?: string;
    NEXT_PRIVATE_SHAREPOINT_CLIENT_ID?: string;
    NEXT_PRIVATE_SHAREPOINT_CLIENT_SECRET?: string;
    /** Graph site id, in the "hostname,siteCollectionId,siteId" form. */
    NEXT_PRIVATE_SHAREPOINT_SITE_ID?: string;
    /** Drive id of the document library within that site. */
    NEXT_PRIVATE_SHAREPOINT_DRIVE_ID?: string;
    /** Folder path template relative to the drive root, supporting {yyyy}, {MM} and {dd}. */
    NEXT_PRIVATE_SHAREPOINT_FOLDER_TEMPLATE?: string;
    /** ISO date before which the sweep will not look for unfiled documents. */
    NEXT_PRIVATE_SHAREPOINT_ARCHIVE_FROM?: string;

    /**
     * Google Vertex AI environment variables
     */
    GOOGLE_VERTEX_PROJECT_ID?: string;
    GOOGLE_VERTEX_LOCATION?: string;
    GOOGLE_VERTEX_API_KEY?: string;
  }
}
