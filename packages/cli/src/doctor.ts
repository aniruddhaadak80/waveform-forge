import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadCatalog } from '@waveformforge/skills'
import { buildRegistry as buildPluginRegistry } from '@waveformforge/plugins'

export type Status = 'ok' | 'warn' | 'fail'

export interface Check {
  readonly name: string
  readonly status: Status
  readonly detail: string
  readonly fix?: string
}

export interface DoctorReport {
  readonly ok: boolean
  readonly checks: readonly Check[]
}

const pkg = { name: 'waveform-forge', version: '0.1.0' }

/**
 * The flagship command. An agent that mutates its own configuration must be able to
 * diagnose itself, and every failing row carries a fix hint rather than only a status.
 */
export async function doctor(cwd = process.cwd()): Promise<DoctorReport> {
  const checks: Check[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push(
    nodeMajor >= 22
      ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
      : {
          name: 'node',
          status: 'fail',
          detail: `v${process.versions.node} is below the required v22.12.0`,
          fix: 'install Node 22.12 or newer (see .nvmrc)',
        },
  )

  checks.push({
    name: 'package',
    status: 'ok',
    detail: `${pkg.name}@${pkg.version}`,
  })

  const skills = loadCatalog(join(cwd, 'skills'))
  checks.push(
    skills.issues.length === 0
      ? { name: 'skills', status: 'ok', detail: `${skills.skills.length} skills, 0 invalid` }
      : {
          name: 'skills',
          status: 'fail',
          detail: `${skills.skills.length} valid, ${skills.issues.length} invalid`,
          fix: skills.issues[0] ?? 'see npm run check:skill-version',
        },
  )

  const plugins = buildPluginRegistry(join(cwd, 'plugins'))
  checks.push(
    plugins.rejected.length === 0
      ? {
          name: 'plugins',
          status: 'ok',
          detail: `${plugins.active.length} active, ${plugins.disabled.length} disabled`,
        }
      : {
          name: 'plugins',
          status: 'warn',
          detail: `${plugins.rejected.length} rejected`,
          fix: plugins.rejected[0]?.issues[0] ?? 'inspect plugins/*/plugin.json',
        },
  )

  const configPath = join(cwd, 'product.config.json')
  checks.push(
    existsSync(configPath)
      ? { name: 'config', status: 'ok', detail: 'product.config.json found' }
      : {
          name: 'config',
          status: 'warn',
          detail: 'no product.config.json — using defaults',
          fix: 'run with defaults, or create product.config.json',
        },
  )

  checks.push(await probeEngine(cwd))

  return { ok: checks.every((c) => c.status !== 'fail'), checks }
}

/**
 * Probe the deterministic engine with a real call rather than a file-existence check.
 *
 * A present-but-broken engine is the failure that matters: the tree looks right and every
 * certification silently fails at the boundary. So an engine directory that exists but does not
 * answer is a `fail`, while a tree that simply has no engine directory yet is only a `warn`.
 */
async function probeEngine(cwd: string): Promise<Check> {
  const { resolveEngineRoot } = await import('./bootstrap.js')
  const engineRoot = resolveEngineRoot(cwd)
  if (engineRoot === undefined) {
    return {
      name: 'engine',
      status: 'warn',
      detail: `no engine found at or above ${cwd}`,
      fix: 'run from the repository root, or set PRODUCT_ENGINE_CWD to services/engine/src',
    }
  }
  try {
    const { EngineBridge } = await import('@waveformforge/engine-client')
    const bridge = new EngineBridge({ module: 'waveform_forge', cwd: engineRoot, timeoutMs: 15_000 })
    const probe = await bridge.call<{ total: number }>({ op: 'summarize', input: { records: [] } })
    return {
      name: 'engine',
      status: 'ok',
      detail: `python engine answered in-process (total=${probe.total})`,
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    // The engine was found but would not answer: the tree looks right and every certification
    // would fail at the boundary. That is a `fail`, not a `warn`.
    return {
      name: 'engine',
      status: 'fail',
      detail: `engine at ${engineRoot} did not answer: ${detail}`,
      fix: 'run `npm run pytest` to see the engine failure directly',
    }
  }
}

export function renderReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length), 5)
  const icon = (status: Status): string => (status === 'ok' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL')
  const lines = report.checks.map((c) => {
    const head = `  [${icon(c.status)}] ${c.name.padEnd(width)}  ${c.detail}`
    return c.fix === undefined ? head : `${head}\n         fix: ${c.fix}`
  })
  return [
    `${pkg.name} doctor`,
    ...lines,
    '',
    report.ok ? 'all required checks passed' : 'one or more checks failed',
  ].join('\n')
}
