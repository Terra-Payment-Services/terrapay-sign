import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { alphaid } from '@documenso/lib/universal/id';
import { logger } from '@documenso/lib/utils/logger';
import type { TRPCError } from '@trpc/server';
import type { ErrorHandlerOptions } from '@trpc/server/unstable-core-do-not-import';

import type { TrpcContext } from '../server/context';

const requestIdsWithoutContext = new WeakMap<TRPCError, string>();

/**
 * The request id an error is reported under: the context logger's, or, when the context could not be created, one
 * kept per error so the client's masked response and the server's log line still share it (#168).
 */
export const getErrorRequestId = (error: TRPCError, ctx?: Pick<TrpcContext, 'logger'>): string => {
  const contextRequestId = ctx?.logger.bindings().requestId;

  if (typeof contextRequestId === 'string') {
    return contextRequestId;
  }

  const existing = requestIdsWithoutContext.get(error);

  if (existing) {
    return existing;
  }

  const requestId = alphaid();

  requestIdsWithoutContext.set(error, requestId);

  return requestId;
};

// Parameters<NonNullable<Parameters<typeof trpcServer>[0]['onError']>>[0], // :-)
export const handleTrpcRouterError = (
  { error, ctx, path }: Pick<ErrorHandlerOptions<TrpcContext>, 'error' | 'path' | 'ctx'>,
  _source: 'trpc' | 'apiV1' | 'apiV2',
) => {
  const appError = AppError.parseError(error.cause || error);

  const isAppError = error.cause instanceof AppError;

  // Only log AppErrors that are explicitly set to 500 or the error code
  // is in the errorCodesToAlertOn list.
  const isLoggableAppError = isAppError && (appError.statusCode === 500 || errorCodesToAlertOn.includes(appError.code));

  // Only log TRPC errors that are in the `errorCodesToAlertOn` list and is
  // not an AppError.
  const isLoggableTrpcError = !isAppError && errorCodesToAlertOn.includes(error.code);

  const errorLogger = (ctx?.logger || logger.child({ requestId: getErrorRequestId(error) })).child({
    status: 'error',
    appError: AppError.toJSON(appError),
    path,
  });

  // Only fully log the error on certain conditions since some errors are expected.
  if (isLoggableAppError || isLoggableTrpcError) {
    errorLogger.error(error);
  } else {
    errorLogger.info('TRPC_ERROR_HANDLER');
  }
};

const errorCodesToAlertOn = [AppErrorCode.UNKNOWN_ERROR, 'INTERNAL_SERVER_ERROR'];
