import { mapDocumentIdToSecondaryId, mapTemplateIdToSecondaryId } from '../../utils/envelope';

type ScopedEnvelope = {
  id: string;
  secondaryId: string;
};

/**
 * Whether a presign token's scope admits this envelope. A token without a scope is team-wide by
 * design. A scoped one names a single envelope, as `envelopeId:envelope_123` from a V2 embed or as
 * `documentId:1` or `templateId:2` from a V1 embed, and admits that envelope alone.
 */
export const presignScopeCoversEnvelope = (scope: string | undefined, envelope: ScopedEnvelope): boolean => {
  if (scope === undefined) {
    return true;
  }

  const [kind, id] = scope.split(':');

  if (kind === 'envelopeId') {
    return id === envelope.id;
  }

  if (!/^[1-9]\d*$/.test(id ?? '')) {
    return false;
  }

  if (kind === 'documentId') {
    return envelope.secondaryId === mapDocumentIdToSecondaryId(Number(id));
  }

  if (kind === 'templateId') {
    return envelope.secondaryId === mapTemplateIdToSecondaryId(Number(id));
  }

  return false;
};
