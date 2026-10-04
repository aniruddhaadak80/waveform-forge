'use client'

import { useEffect, useState } from 'react'

/**
 * Dark and light come from the same token file — this only flips which set of overrides is
 * active. The applied theme is read from the DOM (set before paint by the boot script) rather
 * than from React state, so the button never disagrees with what is on screen.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme')
    setTheme(current === 'dark' ? 'dark' : 'light')
    setReady(true)
  }, [])

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem('wf-theme', next)
    } catch {
      /* private mode: the choice simply does not persist */
    }
    setTheme(next)
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      disabled={!ready}
    >
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  )
}
