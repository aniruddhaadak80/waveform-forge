import Link from 'next/link'
import { Coverage } from '@/components/Coverage'
import { TokenLadder } from '@/components/TokenLadder'
import { CERTIFIED } from '@/lib/timeline'
import { PRODUCT } from '@/lib/product'

export const metadata = {
  title: `${PRODUCT.name} — frame-exact edit certification`,
  description:
    'Declare an edit as a list of cuts; get a frame-exact token timeline proven lossless before you render.',
}

/**
 * The flagship route. Everything below is server-rendered from the fixture in `lib/`, which the
 * real Python engine produced — so the first paint already carries product data, not a shell.
 */
export default function HomePage() {
  const { certification, timeline } = CERTIFIED
  const total = timeline.total_out_frames

  return (
    <>
      <section className="hero">
        <span className="eyebrow">v{PRODUCT.version}</span>
        <h1>{PRODUCT.name}</h1>
        <p className="lede">
          Declare an edit as a list of cuts. Get a frame-exact token timeline, proven lossless, before you
          spend forty minutes rendering it.
        </p>
        <div className="hero-actions">
          <Link className="button" href="/forge">
            Certify an edit
          </Link>
          <Link className="button" data-variant="quiet" href="/surfaces">
            What ships
          </Link>
        </div>
      </section>

      <section className="verdict-strip" aria-label="Certification result">
        <span className="verdict-pill" data-verdict={certification.verdict}>
          {certification.verdict}
        </span>
        <dl className="verdict-facts">
          <Fact label="lossless round trip" value={certification.roundtrip.lossless ? 'yes' : 'no'} />
          <Fact label="coverage conserved" value={certification.coverage.all_conserved ? 'yes' : 'no'} />
          <Fact label="errors" value={certification.errors.length} />
          <Fact label="warnings" value={certification.warnings.length} />
        </dl>
      </section>

      <section className="panel" aria-labelledby="ladder-heading">
        <div className="panel-head">
          <h2 id="ladder-heading">The token ladder</h2>
          <p>
            A real certification of a three-source assembly: five declared cuts, compiled into five edit
            tokens laid end to end. Every rule sits at a true frame offset, and every token prints its own
            arithmetic.
          </p>
        </div>
        <TokenLadder data={CERTIFIED} total={total} />
      </section>

      <section className="panel" aria-labelledby="coverage-heading">
        <div className="panel-head">
          <h2 id="coverage-heading">Frame accounting</h2>
          <p>
            Every source frame is either used once, reused, or explicitly dropped — and the three add up to
            the source duration. The {certification.coverage.total_reused_frames}-frame reuse here is
            deliberate, and reported rather than blocked.
          </p>
        </div>
        <Coverage coverage={certification.coverage} />
      </section>

      <section className="panel" aria-labelledby="why-heading">
        <div className="panel-head">
          <h2 id="why-heading">Why this is code and not a model</h2>
        </div>
        <div className="prose">
          <p>
            Checking that five tokens totalling 1,965 frames add up correctly is easy for a model to write and
            easy for a model to get wrong on a timeline of two hundred tokens, where one lost frame is a
            desync nobody notices until playback.
          </p>
          <p>
            So the load-bearing arithmetic never touches a model. A pure Python engine tokenizes the
            declaration, proves the round trip is lossless, and sweeps the source axis for overlaps — with no
            clock, no randomness, and no network. A model proposes the edit; only code is allowed to sign it
            off.
          </p>
        </div>
      </section>
    </>
  )
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
