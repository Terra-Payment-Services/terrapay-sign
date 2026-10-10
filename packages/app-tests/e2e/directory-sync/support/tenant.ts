/**
 * The stub tenant and app registration. Kept free of `@documenso/*` imports so
 * that a spec can use them without connecting Prisma before
 * `worker-database` has chosen the database.
 */
export const TENANT_ID = '6f1c8a52-3b4d-4e7a-9c21-5d8e0f3a7b19';
export const OTHER_TENANT_ID = 'b2e9d4c7-1a3f-4b6e-8d5c-9f0a2e7c4b81';
export const SYNC_CLIENT_ID = '3d7e1f90-5c2a-4b8d-a6e3-0f9b4c1d2e75';
export const SYNC_CLIENT_SECRET = 'stub-client-secret-not-a-real-one';
export const SIGN_IN_CLIENT_ID = SYNC_CLIENT_ID;
