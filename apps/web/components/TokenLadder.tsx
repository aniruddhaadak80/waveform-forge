import type { CertifiedTimeline, EditToken } from '@/lib/timeline'
import { formatPercent, formatSeconds, tokenShare } from '@/lib/timeline'

/**
 * THE SIGNATURE ELEMENT: the ruled token ladder.
 *
 * A single column where every token occupies exactly its share of the output timeline, and
 * every token edge is a hairline at its true frame offset. A screenshot of this is
 * recognisable: the ladder rules are the product, not decoration around it. Each token carries
 * its own in/out frame numbers, so the claim "the arithmetic closes" is checkable by eye
 * against the numbers printed on the ladder.
 */
export function TokenLadder({ data, total }: { data: CertifiedTimeline; total: number }) {
  const { timeline, certification } = data
  const rate = timeline.frame_rate

  return (
    <div className="ladder">
      <div className="ladder-head">
        <span className="ladder-total">
          <span className="ladder-total-value">{total.toLocaleString('en-US')}</span>
          <span className="ladder-total-unit">frames out</span>
        </span>
        <span className="ladder-timecode">{certification.summary.total_out_timecode}</span>
      </div>

      <ol className="ladder-track" aria-label="Edit tokens in output order">
        {timeline.tokens.map((token) => (
          <LadderRow key={token.token_id} token={token} total={total} />
        ))}
      </ol>

      <p className="ladder-foot">
        Rate {rate.num}/{rate.den} ({formatSeconds(rate, total)} wall clock) ·{' '}
        {certification.summary.token_count} tokens across {certification.summary.distinct_sources} sources ·
        longest token {certification.summary.longest_token_frames} frames
      </p>
    </div>
  )
}

function LadderRow({ token, total }: { token: EditToken; total: number }) {
  const share = tokenShare(token, total)
  return (
    <li className="ladder-row">
      <span className="ladder-label">
        <span className="ladder-id">{token.token_id}</span>
        <span className="ladder-transition" data-transition={token.transition}>
          {token.transition}
        </span>
      </span>

      <span className="ladder-bar">
        <span
          className="ladder-fill"
          data-transition={token.transition}
          style={{ inlineSize: `${Math.max(share * 100, 0.6)}%` }}
        />
        <span className="ladder-edge" style={{ insetInlineStart: '0%' }} aria-hidden="true" />
        <span className="ladder-edge" style={{ insetInlineStart: '100%' }} aria-hidden="true" />
      </span>

      <span className="ladder-frames">
        <span className="ladder-count">{token.frame_count.toLocaleString('en-US')}</span>
        <span className="ladder-span">
          out {token.out_start_frame}–{token.out_end_frame} · src {token.source_id} {token.src_start_frame}–
          {token.src_end_frame}
        </span>
      </span>

      <span className="ladder-share">{formatPercent(token.frame_count, total)}</span>
    </li>
  )
}
