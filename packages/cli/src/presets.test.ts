import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EngineBridge } from '@waveformforge/engine-client'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

interface Preset {
  readonly name: string
  readonly title: string
  readonly frameRate: { readonly num: number; readonly den: number }
  readonly program: unknown
  readonly edl: readonly unknown[]
}

async function loadPresets(): Promise<readonly Preset[]> {
  const entry = join(REPO_ROOT, 'plugins', 'presets', 'index.js')
  const module = (await import(pathToFileURL(entry).href)) as { presets: readonly Preset[] }
  return module.presets
}

/**
 * The preset plugin advertises that every preset has already been certified. This is the test
 * that keeps that claim true: a preset that stops certifying is a broken preset, and shipping
 * it as "reviewed" would be worse than shipping nothing.
 */
describe('edit presets', () => {
  it('exposes at least one preset', async () => {
    expect((await loadPresets()).length).toBeGreaterThan(0)
  })

  it('gives every preset a unique kebab-case name', async () => {
    const presets = await loadPresets()
    const names = presets.map((preset) => preset.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/)
  })

  it('certifies every preset against the real engine', async () => {
    const bridge = new EngineBridge({
      module: 'waveform_forge',
      cwd: join(REPO_ROOT, 'services', 'engine', 'src'),
      timeoutMs: 30_000,
    })

    for (const preset of await loadPresets()) {
      const result = await bridge.call<{ verdict: string; errors: { code: string }[] }>({
        op: 'certify',
        input: { program: preset.program, edl: preset.edl },
      })
      expect({
        preset: preset.name,
        verdict: result.verdict,
        errors: result.errors.map((e) => e.code),
      }).toEqual({ preset: preset.name, verdict: 'certified', errors: [] })
    }
  }, 60_000)
})
