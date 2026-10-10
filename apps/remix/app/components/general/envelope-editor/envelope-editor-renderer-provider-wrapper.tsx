import { useCurrentEnvelopeEditor } from '@documenso/lib/client-only/providers/envelope-editor-provider';
import { EnvelopeRenderProvider } from '@documenso/lib/client-only/providers/envelope-render-provider';

export const EnvelopeEditorRenderProviderWrapper = ({
  children,
  token,
}: {
  children: React.ReactNode;
  token?: string;
}) => {
  const { envelope } = useCurrentEnvelopeEditor();

  return (
    <EnvelopeRenderProvider
      version="current"
      envelope={envelope}
      envelopeItems={envelope.envelopeItems}
      fields={envelope.fields}
      recipients={envelope.recipients}
      token={token}
    >
      {children}
    </EnvelopeRenderProvider>
  );
};
