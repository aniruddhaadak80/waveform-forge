import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const REPO_ROOT = new URL('../../../', import.meta.url)
const GOLDEN = new URL('services/engine/tests/golden/timeline_v1.json', REPO_ROOT)
const FIXTURE = new URL('../lib/timeline-fixture.json', import.meta.url)

/**
 * The web app deploys as a self-contained Next.js project, so it cannot read the engine's
 * golden file at runtime. It therefore ships a copy — and this test is the thing that stops the
 * copy from lying. If the engine's arithmetic changes, this fails rather than the deployed page
 * quietly showing stale numbers.
 */
test('the web fixture matches the engine golden for every product-facing field', () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))

  assert.deepEqual(
    {
      certification: fixture.certification,
      timeline: fixture.timeline,
      roundtrip: fixture.roundtrip,
      coverage: fixture.coverage,
    },
    {
      certification: golden.certification,
      timeline: golden.timeline,
      roundtrip: golden.roundtrip,
      coverage: golden.coverage,
    },
  )
})

test('the fixture records where it came from', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  assert.equal(fixture.source, 'services/engine/tests/golden/timeline_v1.json')
})
