import { SOURCE_CODE_URL } from '@documenso/lib/constants/app';
import { Trans } from '@lingui/react/macro';

/**
 * The offer of source that AGPL section 13 asks of a modified version used
 * over a network. It sits on every page, signing pages included, because
 * outside signers use the program as much as staff do.
 */
export const SourceCodeFooter = () => {
  return (
    <footer className="py-4 text-center text-muted-foreground text-xs">
      <Trans>
        TerraPay Sign is a modified version of Documenso, licensed under the AGPL.{' '}
        <a className="underline hover:text-foreground" href={SOURCE_CODE_URL} target="_blank" rel="noreferrer">
          Source code
        </a>
      </Trans>
    </footer>
  );
};
