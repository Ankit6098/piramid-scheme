'use client';

import type { ComponentProps } from 'react';
import { ThemeProvider as NextThemesProvider } from 'next-themes';

/** Light / dark / system themes via a `.dark` class on <html> (see globals.css tokens). */
export function ThemeProvider(props: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    />
  );
}
