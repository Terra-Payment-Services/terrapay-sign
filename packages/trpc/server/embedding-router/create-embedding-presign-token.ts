import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { createEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/create-embedding-presign-token';

import { procedure } from '../trpc';
import {
  createEmbeddingPresignTokenMeta,
  ZCreateEmbeddingPresignTokenRequestSchema,
  ZCreateEmbeddingPresignTokenResponseSchema,
} from './create-embedding-presign-token.types';

/**
 * Route to create embedding presign tokens.
 */
export const createEmbeddingPresignTokenRoute = procedure
  .meta(createEmbeddingPresignTokenMeta)
  .input(ZCreateEmbeddingPresignTokenRequestSchema)
  .output(ZCreateEmbeddingPresignTokenResponseSchema)
  .mutation(async ({ input, ctx: { req } }) => {
    try {
      const authorizationHeader = req.headers.get('authorization');
      const [apiToken] = (authorizationHeader || '').split('Bearer ').filter((s) => s.length > 0);

      if (!apiToken) {
        throw new AppError(AppErrorCode.UNAUTHORIZED, {
          message: 'No API token provided',
        });
      }

      const { expiresIn, scope } = input;

      const presignToken = await createEmbeddingPresignToken({
        apiToken,
        expiresIn,
        scope,
      });

      return { ...presignToken };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message: 'Failed to create embedding presign token',
      });
    }
  });
