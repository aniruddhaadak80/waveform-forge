'use client'

import { useEffect } from 'react'
import { ErrorState } from '@/components/States'

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <section className="panel">
      <div className="panel-head">
        <h1>Something went wrong</h1>
        <p>The page failed to render. The engine and the CLI are unaffected.</p>
      </div>
      <ErrorState title="Render failed" detail={error.message} fix="retry, or run `wf doctor`" />
      <div>
        <button className="button" type="button" onClick={reset}>
          Try again
        </button>
      </div>
    </section>
  )
}
