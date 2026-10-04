import type { Metadata } from 'next'
import { OMITTED, SURFACES } from '@/lib/product'

export const metadata: Metadata = { title: 'Surfaces' }

const TONE = { shipped: 'ok', planned: 'warn' } as const

export default function SurfacesPage() {
  return (
    <>
      <section className="hero">
        <span className="eyebrow">Capability</span>
        <h1>Surfaces</h1>
        <p className="lede">
          Every capability in this product is a Tool in one registry, reachable identically from each surface
          below. There is no second code path.
        </p>
      </section>

      {SURFACES.length === 0 ? (
        <p className="state" data-kind="empty">
          No surfaces registered.
        </p>
      ) : (
        <div className="grid">
          {SURFACES.map((surface) => (
            <article className="card" key={surface.id}>
              <span className="badge" data-tone={TONE[surface.status]}>
                {surface.status}
              </span>
              <h2>{surface.title}</h2>
              <p>{surface.summary}</p>
              <code>{surface.id}</code>
            </article>
          ))}
        </div>
      )}

      <section className="panel" aria-labelledby="omitted-heading">
        <div className="panel-head">
          <h2 id="omitted-heading">Deliberately omitted</h2>
          <p>Stating an omission is a decision. Leaving it unsaid reads as an oversight.</p>
        </div>
        <div className="grid">
          {OMITTED.map((item) => (
            <article className="card" key={item.id}>
              <span className="badge" data-tone="planned">
                omitted
              </span>
              <h3>{item.id}</h3>
              <p>{item.why}</p>
            </article>
          ))}
        </div>
      </section>
    </>
  )
}
