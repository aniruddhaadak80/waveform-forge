import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The product's identity and surface manifest, in one typed place. Both the web UI and the
 * health endpoint read from here so a value is never stated twice.
 */
export interface Surface {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly status: 'shipped' | 'planned'
}

export const PRODUCT = {
  name: 'waveform-forge',
  slug: 'waveform-forge',
  version: '0.1.0',
  tagline:
    'Declare an edit as a list of cuts; get a frame-exact token timeline proven lossless before you render.',
} as const

export const SURFACES: readonly Surface[] = [
  {
    id: 'cli',
    title: 'CLI',
    summary:
      'wf doctor probes every subsystem, wf tools is the capability list, and wf mcp call certifies an edit from a file. Every capability works without a browser.',
    status: 'shipped',
  },
  {
    id: 'web',
    title: 'Web app',
    summary:
      'This app. Server-rendered, renders a real certified timeline on first paint, and certifies an edit through the same engine the CLI uses.',
    status: 'shipped',
  },
  {
    id: 'mcp',
    title: 'MCP server',
    summary:
      'Speaks MCP over stdio and exposes every registered tool, so the product is a tool provider for other agents rather than only an app.',
    status: 'shipped',
  },
  {
    id: 'engine',
    title: 'Deterministic engine',
    summary:
      'Pure Python: tokenizes a declaration, proves the round trip lossless, sweeps every source frame. No clock, no randomness, no network.',
    status: 'shipped',
  },
  {
    id: 'skills',
    title: 'Skills catalog',
    summary:
      'Four skills loaded from disk with YAML frontmatter validation and a version gate, teaching an agent to certify an edit and read violations.',
    status: 'shipped',
  },
  {
    id: 'plugins',
    title: 'Plugin registry',
    summary:
      'Reviewed edit presets ship as a real plugin, and every preset is certified against the engine by a test.',
    status: 'shipped',
  },
  {
    id: 'memory',
    title: 'Memory',
    summary: 'SQLite with WAL, numbered idempotent migrations, and full-text search over stored records.',
    status: 'shipped',
  },
  {
    id: 'channels',
    title: 'Channels',
    summary: 'One channel interface with shared retry, backoff and an outbound queue in the base class.',
    status: 'shipped',
  },
  {
    id: 'desktop',
    title: 'Desktop shell',
    summary:
      'Electron loads the web app rather than reimplementing it, with a native menu and single-instance locking.',
    status: 'shipped',
  },
]

/**
 * Deliberately absent. Stating an omission is a design decision; leaving it unsaid reads as an
 * oversight.
 */
export const OMITTED: readonly { readonly id: string; readonly why: string }[] = [
  {
    id: 'providers',
    why: 'No LLM provider surface. The entire claim is that the load-bearing arithmetic is deterministic code, so an adapter that could put a model in that path would undermine the product rather than extend it.',
  },
  {
    id: 'tui',
    why: 'No terminal UI. The primary interface is graphical and this product is a Vercel-hosted app; a TUI would be a strictly worse copy of the web app.',
  },
]

function packageVersion(): string {
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function resolveVersion(): string {
  return packageVersion()
}
