import type { Metadata, Viewport } from 'next'
import Link from 'next/link'
import { ThemeToggle } from '@/components/ThemeToggle'
import { PRODUCT } from '@/lib/product'
import './globals.css'

export const metadata: Metadata = {
  title: PRODUCT.name,
  description:
    'Declare an edit as a list of cuts; get a frame-exact token timeline proven lossless before you render.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

/**
 * Applied before paint so a dark-mode reader never sees a white flash. Inlined deliberately:
 * it must run synchronously before first paint, which a bundled component cannot.
 */
const THEME_BOOT = `(function(){try{var s=localStorage.getItem('wf-theme');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;var t=s==='light'||s==='dark'?s:(m?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        {/*
          The font is loaded at runtime rather than through next/font so the production build
          stays deterministic offline. If the request is blocked the stack in tokens.css falls
          back to the system UI font, which is a deliberate degradation, not a broken page.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;600&display=swap"
        />
      </head>
      <body>
        <nav className="site-nav" aria-label="Main">
          <Link href="/">Overview</Link>
          <Link href="/forge">Certify</Link>
          <Link href="/surfaces">Surfaces</Link>
          <Link href="/health">Health</Link>
          <ThemeToggle />
        </nav>

        <main>{children}</main>
      </body>
    </html>
  )
}
