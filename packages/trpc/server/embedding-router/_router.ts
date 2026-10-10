import { router } from '../trpc';
import { getMultiSignDocumentRoute } from './get-multi-sign-document';

export const embeddingPresignRouter = router({
  // applyMultiSignSignature: applyMultiSignSignatureRoute,
  getMultiSignDocument: getMultiSignDocumentRoute,
});
