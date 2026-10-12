import { useCurrentOrganisation } from '@documenso/lib/client-only/providers/organisation';
import { AppError } from '@documenso/lib/errors/app-error';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@documenso/ui/primitives/form/form';
import { Input } from '@documenso/ui/primitives/input';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { zodResolver } from '@hookform/resolvers/zod';
import { useLingui } from '@lingui/react';
import { Trans, useLingui as useLinguiMacro } from '@lingui/react/macro';
import { Loader } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { SettingsHeader } from '~/components/general/settings-header';

const ZCompanySealFormSchema = z.object({
  name: z.string().trim().min(1).max(100),
  legalEntityName: z.string().trim().min(1).max(200),
  image: z.instanceof(File, { message: 'Choose a PNG, JPEG or WebP image' }),
});

type TCompanySealFormSchema = z.infer<typeof ZCompanySealFormSchema>;

/**
 * Company seals of an organisation. Managers and admins create seals here and
 * see every seal; the settings layout refuses everyone else. Seals cannot be
 * changed or removed, so the list offers no actions.
 */
export default function OrganisationSettingsSealsPage() {
  const organisation = useCurrentOrganisation();

  const { i18n } = useLingui();
  const { t } = useLinguiMacro();
  const { toast } = useToast();

  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.organisation.companySeal.find.useQuery({ organisationId: organisation.id });
  const { mutateAsync: createCompanySeal } = trpc.organisation.companySeal.create.useMutation();
  const { mutateAsync: processCompanySealImage } = trpc.organisation.companySeal.process.useMutation();

  // The preview of the processed PNG, bound to the file it was made from. Saving
  // uploads that same file and the server processes it again, so the minimum
  // size applies to the image the user chose and the preview is what is stored.
  const [processed, setProcessed] = useState<{ source: File; url: string } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const form = useForm<TCompanySealFormSchema>({
    resolver: zodResolver(ZCompanySealFormSchema),
    defaultValues: { name: '', legalEntityName: '' },
  });

  const image = form.watch('image');

  useEffect(() => {
    setProcessed(null);

    if (!(image instanceof File)) {
      return;
    }

    let isCancelled = false;
    let url: string | null = null;

    const formData = new FormData();

    formData.append('payload', JSON.stringify({ organisationId: organisation.id }));
    formData.append('image', image);

    setIsProcessing(true);

    processCompanySealImage(formData)
      .then(({ imageDataUrl }) => {
        if (isCancelled) {
          return;
        }

        url = URL.createObjectURL(dataUrlToPngFile(imageDataUrl));
        setProcessed({ source: image, url });
      })
      .catch((err) => {
        if (!isCancelled) {
          form.setError('image', { message: AppError.parseError(err).message });
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsProcessing(false);
        }
      });

    return () => {
      isCancelled = true;

      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [image]);

  const onFormSubmit = async ({ name, legalEntityName }: TCompanySealFormSchema) => {
    if (!processed || processed.source !== form.getValues('image')) {
      return;
    }

    try {
      const formData = new FormData();

      formData.append('payload', JSON.stringify({ organisationId: organisation.id, name, legalEntityName }));
      formData.append('image', processed.source);

      await createCompanySeal(formData);
      await utils.organisation.companySeal.find.invalidate();

      form.reset({ name: '', legalEntityName: '' });

      toast({ title: t`Seal created`, description: t`The seal can now be placed on documents.` });
    } catch (err) {
      const error = AppError.parseError(err);

      toast({
        title: t`The seal was not created`,
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  return (
    <div>
      <SettingsHeader
        title={t`Company seals`}
        subtitle={t`Seals that members of your organisation can apply to documents. A seal cannot be changed or removed once saved, so check the image before saving.`}
      />

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onFormSubmit)}>
          <fieldset className="flex flex-col gap-4" disabled={form.formState.isSubmitting}>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    <Trans>Name</Trans>
                  </FormLabel>
                  <FormControl>
                    <Input className="bg-background" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="legalEntityName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    <Trans>Legal entity</Trans>
                  </FormLabel>
                  <FormControl>
                    <Input className="bg-background" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="image"
              render={({ field: { onChange, value: _value, ...field } }) => (
                <FormItem>
                  <FormLabel>
                    <Trans>Image</Trans>
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="bg-background"
                      {...field}
                      onChange={(event) => onChange(event.target.files?.[0])}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {processed && (
              <img
                data-testid="company-seal-preview"
                src={processed.url}
                alt={t`Seal preview`}
                className="h-40 w-40 rounded-md border object-contain"
              />
            )}

            <div>
              <Button type="submit" loading={form.formState.isSubmitting || isProcessing} disabled={!processed}>
                <Trans>Save seal</Trans>
              </Button>
            </div>
          </fieldset>
        </form>
      </Form>

      <section className="mt-10 flex flex-col gap-4">
        {isLoading && <Loader className="h-6 w-6 animate-spin text-muted-foreground" />}

        {data?.data.length === 0 && (
          <p className="text-muted-foreground text-sm">
            <Trans>No seals yet.</Trans>
          </p>
        )}

        {data?.data.map((seal) => (
          <div key={seal.id} data-testid="company-seal-row" className="flex items-center gap-4 rounded-lg border p-4">
            <img src={seal.imageDataUrl} alt={seal.name} className="h-16 w-16 object-contain" />
            <div className="flex flex-col text-sm">
              <span className="font-medium">{seal.name}</span>
              <span>{seal.legalEntityName}</span>
              <span className="text-muted-foreground">
                <Trans>
                  Created by {seal.createdByName || seal.createdByEmail} on {i18n.date(seal.createdAt)}
                </Trans>
              </span>
              <span className="text-muted-foreground text-xs">
                <Trans>Seal ID: {seal.id}</Trans>
              </span>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

const dataUrlToPngFile = (dataUrl: string) => {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return new File([bytes], 'company-seal.png', { type: 'image/png' });
};
