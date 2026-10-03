import type { DocumentVisibility, TeamMemberRole } from '@prisma/client';
import { EnvelopeType, TemplateType } from '@prisma/client';

import { canAccessTeamDocument } from './teams';

/**
 * The envelope facts the file access rule depends on.
 *
 * Read straight off the envelope row rather than passed by a caller, so that a
 * route cannot hand over a visibility that belongs to a different envelope.
 */
export type EnvelopeFileAccessEnvelope = {
  /** The user the envelope belongs to. */
  ownerUserId: number;
  /** The email address of that user, compared against the team inbox. */
  ownerEmail: string;
  type: EnvelopeType;
  templateType: TemplateType;
  visibility: DocumentVisibility;
};

/**
 * What the requesting user holds against the envelope's team and organisation.
 */
export type EnvelopeFileAccessMembership = {
  userId: number;
  /** Highest role held on the envelope's own team, or null when not a member of it. */
  teamRole: TeamMemberRole | null;
  /** The envelope team's shared inbox address, or null when it has none. */
  teamEmail: string | null;
  /**
   * Every team role held anywhere in the envelope team's organisation.
   *
   * Only consulted for organisation templates, which are readable across the
   * organisation rather than from one team.
   */
  organisationTeamRoles: TeamMemberRole[];
};

/**
 * Decide whether a user may read an envelope's stored bytes.
 *
 * This mirrors `getEnvelopeWhereInput`, the rule that decides whether the same
 * user may open the envelope at all. Membership of the envelope's team is the
 * precondition; beyond that a member reads the envelope when they own it, when
 * their role reaches its visibility, or when it was sent by the team inbox.
 * An organisation template is separate, since it is meant to be readable from
 * any team in the organisation whose role reaches its visibility.
 *
 * The file has to follow the document. A member below the visibility threshold
 * who cannot open a contract must not be able to fetch its PDF either.
 *
 * @param envelope - facts read from the envelope row
 * @param membership - what the requesting user holds on that team and organisation
 * @returns true when the bytes may be served
 */
export const canAccessEnvelopeFile = ({
  envelope,
  membership,
}: {
  envelope: EnvelopeFileAccessEnvelope;
  membership: EnvelopeFileAccessMembership;
}): boolean => {
  if (membership.teamRole !== null) {
    if (envelope.ownerUserId === membership.userId) {
      return true;
    }

    if (canAccessTeamDocument(membership.teamRole, envelope.visibility)) {
      return true;
    }

    if (membership.teamEmail !== null && membership.teamEmail === envelope.ownerEmail) {
      return true;
    }
  }

  if (envelope.type === EnvelopeType.TEMPLATE && envelope.templateType === TemplateType.ORGANISATION) {
    return membership.organisationTeamRoles.some((role) => canAccessTeamDocument(role, envelope.visibility));
  }

  return false;
};
