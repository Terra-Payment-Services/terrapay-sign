import type { Field, Signature } from '@prisma/client';
import { FieldType } from '@prisma/client';

import type { TDocumentAuditLog } from '../types/document-audit-logs';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../types/document-audit-logs';

export type CompanySealCertificateEntry = {
  fieldId: number;
  legalEntityName: string;
  sealName: string;
  appliedAt: Date;
  imageAsBase64: string | null;
};

type CompanySealCertificateField = Pick<Field, 'id' | 'type' | 'secondaryId' | 'recipientId'> & {
  signature?: Pick<Signature, 'signatureImageAsBase64'> | null;
};

/**
 * The seals a recipient applied, for the certificate. Names and time come from
 * the latest DOCUMENT_FIELD_INSERTED row of each seal field, the thumbnail from
 * the snapshot in its Signature row. Shared by both certificate renderers.
 */
export const getCompanySealCertificateEntries = (
  recipientId: number,
  fields: CompanySealCertificateField[],
  insertedLogs: TDocumentAuditLog[],
): CompanySealCertificateEntry[] =>
  fields
    .filter((field) => field.recipientId === recipientId && field.type === FieldType.COMPANY_SEAL)
    .flatMap((field) => {
      const log = insertedLogs
        .filter((item) => item.type === DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED)
        .filter((item) => item.data.fieldId === field.secondaryId)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .at(-1);

      if (
        log?.type !== DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED ||
        log.data.field.type !== FieldType.COMPANY_SEAL
      ) {
        return [];
      }

      return [
        {
          fieldId: field.id,
          legalEntityName: log.data.field.data.legalEntityName,
          sealName: log.data.field.data.sealName,
          appliedAt: new Date(log.createdAt),
          imageAsBase64: field.signature?.signatureImageAsBase64 ?? null,
        },
      ];
    });
