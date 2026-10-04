'use client'

import { useState } from 'react'
import { ErrorState } from '@/components/States'
import { CERTIFIED } from '@/lib/timeline'

interface Violation {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly entry_index?: number
}

interface CertifyResult {
  readonly verdict: 'certified' | 'rejected'
  readonly summary: {
    readonly token_count: number
    readonly total_out_frames: number
    readonly total_out_timecode: string
    readonly error_count: number
    readonly warning_count: number
  }
  readonly roundtrip: { readonly lossless: boolean }
  readonly coverage: { readonly all_conserved: boolean; readonly total_reused_frames: number }
  readonly errors: readonly Violation[]
  readonly warnings: readonly Violation[]
}

type Phase = 'idle' | 'submitting' | 'done' | 'error'

const PREFILL = JSON.stringify(CERTIFIED.input, null, 2)

/**
 * The interactive half of the product. It posts the declaration to `/api/certify`, which shells
 * the real Python engine — so the verdict on screen is the engine's, not a client-side guess.
 *
 * When the engine is not reachable (a read-only or Python-less deployment) this shows the error
 * state with a fix rather than pretending the edit is fine. That distinction is the whole point
 * of the product, so it must not be smoothed over in the UI.
 */
export function Forge() {
  const [source, setSource] = useState(PREFILL)
  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState<CertifyResult | null>(null)
  const [failure, setFailure] = useState<{ detail: string; fix: string } | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setPhase('submitting')
    setFailure(null)
    try {
      const response = await fetch('/api/certify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: source,
      })
      const body = (await response.json()) as
        (CertifyResult & { ok: true }) | { ok: false; detail: string; fix: string }

      if (!response.ok || !body.ok) {
        const broken = body as { ok: false; detail: string; fix: string }
        setFailure({ detail: broken.detail, fix: broken.fix })
        setPhase('error')
        return
      }
      setResult(body as CertifyResult)
      setPhase('done')
    } catch (cause) {
      setFailure({
        detail: cause instanceof Error ? cause.message : String(cause),
        fix: 'check the network and try again',
      })
      setPhase('error')
    }
  }

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h1>Certify an edit</h1>
          <p>
            Paste a declaration — a <code>program</code> and an ordered <code>edl</code> of cuts. The
            deterministic engine compiles it, proves the round trip is lossless, audits every source frame,
            and returns one verdict.
          </p>
        </div>

        <form className="form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="declaration">Declaration</label>
            <span className="field-hint">
              Frames are integers. Use <code>{'{"num": 30000, "den": 1001}'}</code> for 29.97fps — never a
              float. Pre-loaded with the assembly from the overview page.
            </span>
            <textarea
              id="declaration"
              name="declaration"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              spellCheck={false}
              rows={20}
            />
          </div>
          <div>
            <button className="button" type="submit" disabled={phase === 'submitting'}>
              {phase === 'submitting' ? 'Certifying…' : 'Certify'}
            </button>
          </div>
        </form>
      </section>

      {phase === 'submitting' ? (
        <section className="panel" aria-live="polite">
          <p className="state-title">Running the engine…</p>
        </section>
      ) : null}

      {phase === 'error' && failure ? (
        <ErrorState title="Certification could not run" detail={failure.detail} fix={failure.fix} />
      ) : null}

      {phase === 'done' && result ? <Verdict result={result} /> : null}
    </>
  )
}

function Verdict({ result }: { result: CertifyResult }) {
  const certified = result.verdict === 'certified'
  return (
    <section className="panel" aria-labelledby="verdict-heading">
      <div className="verdict-strip">
        <span className="verdict-pill" data-verdict={result.verdict}>
          {result.verdict}
        </span>
        <dl className="verdict-facts">
          <div className="fact">
            <dt>frames out</dt>
            <dd>{result.summary.total_out_frames.toLocaleString('en-US')}</dd>
          </div>
          <div className="fact">
            <dt>timecode</dt>
            <dd>{result.summary.total_out_timecode}</dd>
          </div>
          <div className="fact">
            <dt>tokens</dt>
            <dd>{result.summary.token_count}</dd>
          </div>
          <div className="fact">
            <dt>lossless</dt>
            <dd>{result.roundtrip.lossless ? 'yes' : 'no'}</dd>
          </div>
          <div className="fact">
            <dt>conserved</dt>
            <dd>{result.coverage.all_conserved ? 'yes' : 'no'}</dd>
          </div>
        </dl>
      </div>

      <div id="verdict-heading" className="panel-head">
        <h2>
          {certified ? 'Nothing blocking' : 'Rejected'} · {result.errors.length} error
          {result.errors.length === 1 ? '' : 's'}, {result.warnings.length} warning
          {result.warnings.length === 1 ? '' : 's'}
        </h2>
        {result.coverage.total_reused_frames > 0 ? (
          <p>
            {result.coverage.total_reused_frames} source frames are read by more than one token. Reported, not
            blocked — a reused range is usually a deliberate flashback.
          </p>
        ) : null}
      </div>

      {result.errors.length + result.warnings.length > 0 ? (
        <table className="table">
          <caption className="field-hint">Every violation, in one pass</caption>
          <thead>
            <tr>
              <th scope="col">severity</th>
              <th scope="col">code</th>
              <th scope="col">entry</th>
              <th scope="col">detail</th>
            </tr>
          </thead>
          <tbody>
            {[...result.errors, ...result.warnings].map((violation, index) => (
              <tr key={`${violation.code}-${index}`}>
                <td data-kind="text">{violation.severity}</td>
                <td>{violation.code}</td>
                <td>{violation.entry_index ?? '—'}</td>
                <td data-kind="text">{violation.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  )
}
