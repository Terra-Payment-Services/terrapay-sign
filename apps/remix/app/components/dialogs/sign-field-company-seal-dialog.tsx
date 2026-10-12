import { AppError } from '@documenso/lib/errors/app-error';
import { trpc } from '@documenso/trpc/react';
import { Alert, AlertDescription } from '@documenso/ui/primitives/alert';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { Trans } from '@lingui/react/macro';
import { Loader } from 'lucide-react';
import { createCallable } from 'react-call';

export type SignFieldCompanySealDialogProps = {
  token: string;
  fieldId: number;
};

/**
 * The confirmation step before a seal is applied. The image comes from the
 * server only when the recipient may apply the seal; the answer is true when
 * the recipient chose to apply it.
 */
export const SignFieldCompanySealDialog = createCallable<SignFieldCompanySealDialogProps, boolean>(
  ({ call, token, fieldId }) => {
    const { data, error, isLoading } = trpc.envelope.companySeal.getForField.useQuery(
      { token, fieldId },
      { retry: false, gcTime: 0 },
    );

    return (
      <Dialog open={true} onOpenChange={(value) => (!value ? call.end(false) : null)}>
        <DialogContent data-testid="company-seal-confirm">
          <DialogHeader>
            <DialogTitle>
              <Trans>Apply company seal</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>Check the seal below. Once applied, it becomes part of the document.</Trans>
            </DialogDescription>
          </DialogHeader>

          {isLoading && <Loader className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{AppError.parseError(error).message}</AlertDescription>
            </Alert>
          )}

          {data && (
            <div className="flex flex-col items-center gap-2">
              <img src={data.imageDataUrl} alt={data.name} className="h-40 w-40 object-contain" />
              <p className="font-medium text-sm">{data.legalEntityName}</p>
              <p className="text-muted-foreground text-xs">{data.name}</p>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => call.end(false)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="button" disabled={!data} onClick={() => call.end(true)}>
              <Trans>Apply seal</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
);
