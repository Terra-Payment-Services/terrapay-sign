import { Outlet } from 'react-router';

import { BrandingLogo } from '~/components/general/branding-logo';

// TOPS puts product pages on grey-100 (colorBgDefault) and forbids decorative
// background patterns, so the upstream pattern is gone and the white card lifts
// off the page by its shadow alone.
export default function Layout() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-muted px-4 py-12 md:p-12 lg:p-24">
      <div>
        {/*
          The signed out pages carried no mark of any kind, so the first thing
          anyone saw of this service was a stock card that could have belonged
          to anybody. The wordmark draws its navy in `currentColor`, so it
          inherits the surrounding text colour and stays legible in either
          theme.
        */}
        <div className="relative mb-6 flex w-full justify-center">
          <BrandingLogo role="img" aria-label="TerraPay" className="h-8 w-auto text-foreground" />
        </div>

        <div className="relative w-full">
          <Outlet />
        </div>
      </div>
    </main>
  );
}
