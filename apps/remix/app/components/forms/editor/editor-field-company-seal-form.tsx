import type { TCompanySealFieldMeta } from '@documenso/lib/types/field-meta';
import type { TCompanySealListItem } from '@documenso/trpc/server/organisation-router/find-company-seals.types';
import { Alert, AlertDescription } from '@documenso/ui/primitives/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

type EditorFieldCompanySealFormProps = {
  value: TCompanySealFieldMeta | undefined;
  seals: TCompanySealListItem[];
  isRecipientNonMember: boolean;
  onValueChange: (value: TCompanySealFieldMeta) => void;
};

/**
 * Chooses which of the organisation's seals a COMPANY_SEAL field carries. The
 * label sent here is for display only; the server replaces it on every write.
 */
export const EditorFieldCompanySealForm = ({
  value,
  seals,
  isRecipientNonMember,
  onValueChange,
}: EditorFieldCompanySealFormProps) => {
  const { i18n } = useLingui();

  const onSealChange = (sealId: string) => {
    const seal = seals.find((item) => item.id === sealId);

    if (!seal) {
      return;
    }

    onValueChange({
      ...value,
      type: 'company_seal',
      sealId: seal.id,
      sealLabel: `${seal.name} (${seal.legalEntityName})`,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <Select value={value?.sealId} onValueChange={onSealChange}>
        <SelectTrigger data-testid="company-seal-select" className="h-auto min-h-10 bg-background">
          <SelectValue placeholder={<Trans>Choose a seal</Trans>} />
        </SelectTrigger>
        <SelectContent>
          {seals.map((seal) => (
            <SelectItem key={seal.id} value={seal.id}>
              <span className="flex items-center gap-2 text-left">
                <img src={seal.imageDataUrl} alt={seal.name} className="h-8 w-8 shrink-0 object-contain" />
                <span className="flex flex-col">
                  <span>{seal.name}</span>
                  <span className="text-muted-foreground text-xs">{seal.legalEntityName}</span>
                  <span className="text-muted-foreground text-xs">
                    <Trans>
                      {seal.createdByName || seal.createdByEmail}, {i18n.date(seal.createdAt)}
                    </Trans>
                  </span>
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isRecipientNonMember && (
        <Alert variant="warning">
          <AlertDescription>
            <Trans>
              This recipient is not a member of the organisation, so they cannot apply the seal and the document cannot
              be sent.
            </Trans>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
};
