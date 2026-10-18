import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';

export type AuditLogSenderStandIn = {
  name: string;
  email: string;
};

type AuditLogEntry = {
  type: string;
  userId?: number | null;
  name?: string | null;
  email?: string | null;
  data?: unknown;
};

export type HideSenderInAuditLogsOptions = {
  recipientEmails: string[];
  ownerEmail: string;
  standIn: AuditLogSenderStandIn;
};

/**
 * Entries a recipient records by acting on the document. Their actor is kept when it is one of the
 * document's recipients; every other actor is a team member, an API token or the system.
 */
const RECIPIENT_ACTION_TYPES = new Set<string>([
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_UNINSERTED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_PREFILLED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_OPENED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_VIEWED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_REJECTED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_REQUESTED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_VALIDATED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_FAILED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_CSC_AUTHENTICATED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_CSC_AUTHENTICATION_FAILED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_CSC_SIGN_REQUESTED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_CSC_AUTHORIZED,
  DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_CSC_SIGNED,
]);

/**
 * With "Send on Behalf of Team" off, the audit pages appended to the sealed PDF reach every recipient, so
 * team members acting on the document are shown as the team: every actor except a recipient acting as a
 * recipient, the team member a rejection was made on behalf of, and a delegated owner. A team member who is
 * also a recipient keeps their name only on their recipient actions; an external rejection is a team
 * action whoever records it.
 */
export const hideSenderInAuditLogs = <T extends AuditLogEntry>(
  auditLogs: T[],
  { recipientEmails, ownerEmail, standIn }: HideSenderInAuditLogsOptions,
): T[] => {
  const recipients = new Set(recipientEmails.map((email) => email.toLowerCase()));
  const owner = ownerEmail.toLowerCase();

  return auditLogs.map((auditLog) => {
    const email = auditLog.email?.toLowerCase() ?? '';
    const data = auditLog.data;
    const isExternal = !!data && typeof data === 'object' && 'isExternal' in data && data.isExternal === true;
    const isRecipientAction = RECIPIENT_ACTION_TYPES.has(auditLog.type) && !isExternal && recipients.has(email);
    const hasActor = (auditLog.userId !== null && auditLog.userId !== undefined) || email === owner;

    let result = auditLog;

    if (!isRecipientAction && (hasActor || email !== '')) {
      result = { ...result, name: standIn.name, email: standIn.email };
    }

    if (data && typeof data === 'object') {
      const hasOnBehalfOf = 'onBehalfOfUserEmail' in data || 'onBehalfOfUserName' in data;
      const hasDelegatedOwner = 'delegatedOwnerEmail' in data || 'delegatedOwnerName' in data;

      result = {
        ...result,
        data: {
          ...data,
          ...(hasOnBehalfOf ? { onBehalfOfUserEmail: standIn.email, onBehalfOfUserName: standIn.name } : {}),
          ...(hasDelegatedOwner ? { delegatedOwnerEmail: standIn.email, delegatedOwnerName: standIn.name } : {}),
        },
      };
    }

    return result;
  });
};

export const formatAuditLogOwner = ({ name, email }: AuditLogSenderStandIn) => (email ? `${name} (${email})` : name);
