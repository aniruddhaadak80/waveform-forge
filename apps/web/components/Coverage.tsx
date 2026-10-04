import type { Coverage } from '@/lib/timeline'
import { formatPercent } from '@/lib/timeline'

/**
 * Frame accounting per source.
 *
 * The bar is the whole point: used, reused and dropped must add up to the source duration, and
 * the row says so out loud rather than asking you to trust it. Overlap is drawn as its own
 * segment, because "reused" is the segment an editor most often does not know is there.
 */
export function Coverage({ coverage }: { coverage: Coverage }) {
  return (
    <div className="coverage">
      {coverage.sources.map((source) => {
        const total = source.duration_frames
        const used = (source.used_once_frames / total) * 100
        const reused = (source.reused_frames / total) * 100
        const dropped = (source.dropped_frames / total) * 100

        return (
          <section
            className="coverage-row"
            key={source.source_id}
            aria-label={`Coverage for ${source.source_id}`}
          >
            <header className="coverage-head">
              <h3 className="coverage-id">{source.source_id}</h3>
              <span className="coverage-total">{total.toLocaleString('en-US')} frames</span>
              <span className="coverage-verdict" data-conserved={String(source.conserved)}>
                {source.conserved ? 'conserved' : 'not conserved'}
              </span>
            </header>

            <div
              className="coverage-bar"
              role="img"
              aria-label={`${source.source_id}: ${formatPercent(source.used_once_frames, total)} used once, ${formatPercent(source.reused_frames, total)} reused, ${formatPercent(source.dropped_frames, total)} dropped`}
            >
              <span className="coverage-seg" data-kind="used" style={{ inlineSize: `${used}%` }} />
              <span className="coverage-seg" data-kind="reused" style={{ inlineSize: `${reused}%` }} />
              <span className="coverage-seg" data-kind="dropped" style={{ inlineSize: `${dropped}%` }} />
            </div>

            <dl className="coverage-figures">
              <Figure label="used once" value={source.used_once_frames} total={total} />
              <Figure label="reused" value={source.reused_frames} total={total} />
              <Figure label="dropped" value={source.dropped_frames} total={total} />
            </dl>

            {source.reuse_sites.length > 0 ? (
              <p className="coverage-note">
                {source.reuse_sites.length} reuse {source.reuse_sites.length === 1 ? 'site' : 'sites'} —{' '}
                {source.reuse_sites
                  .map((site) => `frames ${site.start}–${site.end} read ${site.use_count}×`)
                  .join(', ')}
                . Reported, not blocked: reusing a range is a legitimate flashback.
              </p>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}

function Figure({ label, value, total }: { label: string; value: number; total: number }) {
  return (
    <div className="coverage-figure">
      <dt>{label}</dt>
      <dd>
        {value.toLocaleString('en-US')}
        <span>{formatPercent(value, total)}</span>
      </dd>
    </div>
  )
}
