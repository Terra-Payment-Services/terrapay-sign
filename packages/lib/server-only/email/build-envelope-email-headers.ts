export type BuildEnvelopeEmailHeadersOptions = {
  userId: number;
  envelopeId: string;
  teamId: number;
  /** The team's effective "Send on Behalf of Team" setting; when off, the sending user stays hidden (#137). */
  includeSenderDetails: boolean;
};

/**
 * Builds opaque sender-attribution headers stamped onto outgoing user-triggered
 * envelope emails. These appear in AWS SES bounce/complaint notifications (when
 * "include original headers" is enabled) so an abusive send can be traced back
 * to the originating Documenso user via the admin panel.
 *
 * Only opaque IDs are included so recipients cannot see the sender's email
 * address or name in the delivered message source. The sender's user id is
 * left out when sender details are hidden; the envelope id still traces it.
 */
export const buildEnvelopeEmailHeaders = ({
  userId,
  envelopeId,
  teamId,
  includeSenderDetails,
}: BuildEnvelopeEmailHeadersOptions): Record<string, string> => {
  return {
    ...(includeSenderDetails ? { 'X-Documenso-Sender-User-Id': String(userId) } : {}),
    'X-Documenso-Envelope-Id': envelopeId,
    'X-Documenso-Team-Id': String(teamId),
  };
};
