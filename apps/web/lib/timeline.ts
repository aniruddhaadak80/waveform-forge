import fixture from './timeline-fixture.json'

/**
 * The typed view of a certified timeline, mirrored from the Python engine's contract in
 * `services/engine/src/waveform_forge/model.py`.
 *
 * These types are duplicated on purpose and in one direction only: the engine is the source of
 * truth and this file is a mirror. `tests/fixture.test.mjs` asserts the shipped fixture still
 * matches the engine's golden output, so the mirror cannot drift unnoticed.
 */

export interface EditToken {
  readonly token_id: string
  readonly index: number
  readonly out_start_frame: number
  readonly out_end_frame: number
  readonly frame_count: number
  readonly source_id: string
  readonly src_start_frame: number
  readonly src_end_frame: number
  readonly transition: string
}

export interface Violation {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly entry_index?: number
  readonly token_id?: string
  readonly field?: string
}

export interface Timeline {
  readonly frame_rate: { readonly num: number; readonly den: number }
  readonly sources: readonly {
    readonly id: string
    readonly duration_frames: number
    readonly label?: string
  }[]
  readonly tokens: readonly EditToken[]
  readonly total_out_frames: number
  readonly emitted_entries: number
  readonly dropped_entries: number
  readonly violations: readonly Violation[]
}

export interface Coverage {
  readonly sources: readonly {
    readonly source_id: string
    readonly duration_frames: number
    readonly used_once_frames: number
    readonly reused_frames: number
    readonly dropped_frames: number
    readonly covered_frames: number
    readonly conserved: boolean
    readonly dropped_ranges: readonly { readonly start: number; readonly end: number }[]
    readonly reuse_sites: readonly {
      readonly start: number
      readonly end: number
      readonly use_count: number
    }[]
  }[]
  readonly total_dropped_frames: number
  readonly total_reused_frames: number
  readonly all_conserved: boolean
}

export interface CertifiedTimeline {
  /** The declaration this fixture was compiled from — what the form pre-loads. */
  readonly input: {
    readonly program: {
      readonly frame_rate: { readonly num: number; readonly den: number }
      readonly sources: readonly {
        readonly id: string
        readonly duration_frames: number
        readonly label?: string
      }[]
    }
    readonly edl: readonly {
      readonly source_id: string
      readonly src_start_frame: number
      readonly frame_count: number
      readonly transition?: string
      readonly token_id?: string
    }[]
  }
  readonly certification: {
    readonly verdict: 'certified' | 'rejected'
    readonly summary: {
      readonly token_count: number
      readonly total_out_frames: number
      readonly total_out_timecode: string
      readonly total_out_seconds: { readonly num: number; readonly den: number }
      readonly distinct_sources: number
      readonly transition_histogram: Readonly<Record<string, number>>
      readonly longest_token_frames: number
      readonly error_count: number
      readonly warning_count: number
    }
    readonly roundtrip: {
      readonly lossless: boolean
      readonly declared_entries: number
      readonly reconstructed_entries: number
      readonly differences: readonly { readonly kind: string; readonly detail: string }[]
    }
    readonly coverage: Coverage
    readonly violations: readonly Violation[]
    readonly errors: readonly Violation[]
    readonly warnings: readonly Violation[]
    readonly tokens: readonly EditToken[]
  }
  readonly timeline: Timeline
}

/**
 * Load the shipped fixture, enforcing the product's own claim before anything renders.
 *
 * A JSON import is only as trustworthy as the file behind it. Rather than a blind `as unknown
 * as` cast that would let a corrupt fixture render confidently, this checks the two invariants
 * the product exists to guarantee: the tokens sum to the declared output length, and the verdict
 * is a real verdict. If either fails the page throws instead of displaying a number it cannot
 * stand behind.
 */
function assertCertified(value: unknown): CertifiedTimeline {
  const data = value as Partial<CertifiedTimeline>
  const timeline = data.timeline
  const certification = data.certification

  if (timeline === undefined || certification === undefined) {
    throw new Error('timeline fixture is missing "timeline" or "certification"')
  }
  if (certification.verdict !== 'certified' && certification.verdict !== 'rejected') {
    throw new Error(`timeline fixture has an unknown verdict: ${String(certification.verdict)}`)
  }
  const summed = timeline.tokens.reduce((total, token) => total + token.frame_count, 0)
  if (summed !== timeline.total_out_frames) {
    throw new Error(
      `timeline fixture does not conserve frames: tokens sum to ${summed} but total_out_frames is ${timeline.total_out_frames}`,
    )
  }
  return value as CertifiedTimeline
}

/**
 * The certified timeline this deployment renders.
 *
 * Produced by running the real engine over a three-source assembly — not a mock and not a
 * hand-written example. `certified` with five tokens and 1965 output frames is the product's
 * real answer to a real declaration.
 */
export const CERTIFIED = assertCertified(fixture)

/** Fraction of the output timeline a token occupies, for the ladder. */
export function tokenShare(token: EditToken, total: number): number {
  return total === 0 ? 0 : token.frame_count / total
}

/** Nominal integer frames-per-second, for timecode maths in the UI. */
export function nominalFps(rate: { num: number; den: number }): number {
  return Math.round(rate.num / rate.den)
}

export function formatSeconds(rate: { num: number; den: number }, frames: number): string {
  const fps = nominalFps(rate)
  if (fps <= 0) return '—'
  const totalSeconds = frames / fps
  return `${totalSeconds.toFixed(2)}s`
}

export function formatPercent(part: number, whole: number): string {
  if (whole === 0) return '0.0%'
  return `${((part / whole) * 100).toFixed(1)}%`
}
