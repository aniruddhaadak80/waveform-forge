import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ToolRegistry,
  ValidationError,
  UpstreamError,
  type Tool,
  type ToolContext,
} from '@waveformforge/core'
import { buildRegistry } from '@waveformforge/plugins'
import { loadCatalog } from '@waveformforge/skills'

export const ENGINE_MODULE = 'waveform_forge'

/**
 * Locate `services/engine/src`, which is what `python -m waveform_forge` needs on its path.
 *
 * Walking up matters: the CLI is run from the repository root, from `packages/cli` under turbo,
 * and from a global install, and the engine must be found in all three. `PRODUCT_ENGINE_CWD`
 * overrides the search for installations that keep the two apart.
 */
export function resolveEngineRoot(start = process.cwd()): string | undefined {
  const override = process.env.PRODUCT_ENGINE_CWD
  if (override !== undefined && override !== '' && existsSync(override)) return override

  const relative = join('services', 'engine', 'src')
  let current = resolve(start)
  for (;;) {
    const candidate = join(current, relative)
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Builds the one registry every surface shares.
 *
 * These five tools are real and working out of the box — they are what makes the MCP server
 * useful on a fresh install instead of exposing an empty tool list. They are also the
 * intended shape for your own tools: a name a model can type, an inputSchema it can fill,
 * declared permissions, and a handler that returns JSON-serialisable data.
 *
 * Every name matches ^[a-z][a-z0-9_]*$ so it is directly exposable over MCP.
 */
export function buildToolRegistry(cwd = process.cwd()): ToolRegistry {
  const registry = new ToolRegistry()

  registry.register(
    {
      name: 'list_skills',
      description:
        'List the skill catalog with each skill name, version and description. Use this to discover what the agent can do before guessing a command.',
      inputSchema: {
        type: 'object',
        properties: {
          includeBodies: { type: 'boolean', description: 'Include each skill body.' },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          issues: { type: 'array', items: { type: 'string' } },
          skills: { type: 'array', items: { type: 'object' } },
        },
        required: ['count', 'issues', 'skills'],
      },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async (input: { includeBodies?: boolean }) => {
        const { skills, issues } = loadCatalog(join(cwd, 'skills'))
        return {
          count: skills.length,
          issues: [...issues],
          skills: skills.map((skill) => ({
            name: skill.name,
            version: skill.version,
            description: skill.description,
            ...(input.includeBodies === true ? { body: skill.body } : {}),
          })),
        }
      },
    } satisfies Tool<{ includeBodies?: boolean }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'list_plugins',
      description:
        'List the resolved plugin registry, including plugins that were shadowed, disabled or rejected and why. Use this to explain why an expected capability is missing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object' },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async () => {
        const result = buildRegistry(join(cwd, 'plugins'))
        return {
          active: result.active.map((p) => ({
            name: p.manifest.name,
            version: p.manifest.version,
            capabilities: p.manifest.capabilities,
            shadowed: p.shadowed,
          })),
          disabled: result.disabled.map((p) => p.manifest.name),
          rejected: result.rejected.map((p) => ({ path: p.path, issues: p.issues })),
        }
      },
    } satisfies Tool<Record<string, never>, unknown>,
    { source: 'core' },
  )

  const runEngine = async (op: string, input: unknown): Promise<unknown> => {
    const { EngineBridge } = await import('@waveformforge/engine-client')
    const engineRoot = resolveEngineRoot(cwd)
    if (engineRoot === undefined) {
      throw new UpstreamError('cannot locate services/engine/src', {
        searchedFrom: cwd,
        fix: 'set PRODUCT_ENGINE_CWD to the engine package root',
      })
    }
    const bridge = new EngineBridge({ module: ENGINE_MODULE, cwd: engineRoot })
    return await bridge.call({ op, input })
  }

  const engineSchema = (properties: Record<string, unknown>, required: string[]) =>
    ({
      type: 'object',
      properties: { records: { type: 'array', items: { type: 'object' } }, ...properties },
      required: ['records', ...required],
      additionalProperties: false,
    }) as const

  const validateRecords = (input: unknown): unknown[] => {
    const records = (input as { records?: unknown }).records
    if (!Array.isArray(records)) {
      throw new ValidationError('"records" must be an array', { field: 'records' })
    }
    return records
  }

  registry.register(
    {
      name: 'engine_summarize',
      description:
        'Aggregate a set of records by kind and report the total and the newest/oldest timestamps. Deterministic: same records always give the same answer.',
      inputSchema: engineSchema({}, []),
      outputSchema: { type: 'object' },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        validateRecords(input)
        return await runEngine('summarize', input)
      },
    } satisfies Tool<{ records: unknown[] }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'engine_diff',
      description:
        'Compute a minimal structural diff between two record sets, reporting added, removed, changed and unchanged identifiers. Use this instead of comparing JSON by eye.',
      inputSchema: {
        type: 'object',
        properties: {
          before: { type: 'array', items: { type: 'object' } },
          after: { type: 'array', items: { type: 'object' } },
        },
        required: ['before', 'after'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        if (!Array.isArray((input as { before?: unknown }).before)) {
          throw new ValidationError('"before" must be an array', { field: 'before' })
        }
        if (!Array.isArray((input as { after?: unknown }).after)) {
          throw new ValidationError('"after" must be an array', { field: 'after' })
        }
        return await runEngine('diff', input)
      },
    } satisfies Tool<{ before: unknown[]; after: unknown[] }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'engine_normalize',
      description:
        'Flatten records into a stable, sorted, comparable shape. Use this before diffing or storing so ordering never changes the result.',
      inputSchema: engineSchema({}, []),
      outputSchema: { type: 'object' },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        validateRecords(input)
        return await runEngine('normalize', input)
      },
    } satisfies Tool<{ records: unknown[] }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'list_presets',
      description:
        'List the reviewed edit presets — house cut patterns that have already been certified once. Returns each preset with the program and edit declaration it expects. Feed a preset straight into edl_certify to re-prove it. Prefer a preset over inventing a common assembly from scratch: a preset is a pattern somebody already checked.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Return only this preset. Omit for all of them.',
          },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          source: { type: 'string', description: 'Which plugin supplied the presets.' },
          presets: { type: 'array', items: { type: 'object' } },
        },
        required: ['count', 'source', 'presets'],
      },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async (input: { name?: string }) => {
        // The plugin is loaded as a module, so its capability is real behaviour rather than a
        // manifest claim. A plugin that cannot be imported is reported, not silently skipped.
        const entry = join(cwd, 'plugins', 'presets', 'index.js')
        let module: { presets?: unknown }
        try {
          module = (await import(pathToFileURL(entry).href)) as { presets?: unknown }
        } catch (cause) {
          throw new UpstreamError(`preset plugin failed to load: ${String(cause)}`, { entry })
        }
        const all = Array.isArray(module.presets) ? (module.presets as Record<string, unknown>[]) : []
        const wanted = typeof input.name === 'string' ? input.name : undefined
        const presets = wanted === undefined ? all : all.filter((p) => p['name'] === wanted)
        return { count: presets.length, source: 'presets', presets }
      },
    } satisfies Tool<{ name?: string }, unknown>,
    { source: 'plugin:presets' },
  )

  // The product's own tools, in the same registry and reachable from every surface.
  registerTimelineTools(registry, cwd)

  return registry
}

/**
 * The product's own tools.
 *
 * These are the reason the product exists, so they are written for a model reading them:
 * each one says what it does, when to reach for it, and what comes back. They are thin by
 * design — every frame calculation happens in the Python engine, and this layer only validates
 * the boundary and shapes the error.
 */
export function registerTimelineTools(registry: ToolRegistry, cwd: string): ToolRegistry {
  /** Either a wrapper object or a bare compiled timeline — see `timelineArg`. */
  type TimelineInput = { timeline?: unknown }

  /** Every engine call goes through here, so one function owns "where is the engine". */
  const runEngine = async (op: string, input: unknown): Promise<unknown> => {
    const { EngineBridge } = await import('@waveformforge/engine-client')
    const engineRoot = resolveEngineRoot(cwd)
    if (engineRoot === undefined) {
      throw new UpstreamError('cannot locate services/engine/src', {
        searchedFrom: cwd,
        fix: 'set PRODUCT_ENGINE_CWD to the engine package root',
      })
    }
    const bridge = new EngineBridge({ module: ENGINE_MODULE, cwd: engineRoot })
    return await bridge.call({ op, input })
  }

  const SOURCE_SCHEMA = {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Unique source identifier referenced by the edit.' },
      duration_frames: {
        type: 'integer',
        minimum: 1,
        description: 'Total frames available in this source program.',
      },
      label: { type: 'string', description: 'Human label, e.g. "Street interview".' },
    },
    required: ['id', 'duration_frames'],
    additionalProperties: false,
  } as const

  const ENTRY_SCHEMA = {
    type: 'object',
    properties: {
      source_id: { type: 'string', description: 'Which source to read from.' },
      src_start_frame: { type: 'integer', minimum: 0, description: 'First source frame to read.' },
      frame_count: { type: 'integer', minimum: 1, description: 'How many frames to read.' },
      transition: {
        type: 'string',
        enum: ['cut', 'dissolve', 'dip_to_black', 'dip_from_black', 'wipe'],
        description: 'How this token joins the one before it. Defaults to "cut".',
      },
      token_id: {
        type: 'string',
        description: 'Optional stable id. Omit it and one is derived from the position.',
      },
    },
    required: ['source_id', 'src_start_frame', 'frame_count'],
    additionalProperties: false,
  } as const

  const PROGRAM_SCHEMA = {
    frame_rate: {
      type: 'object',
      description: 'Exact rational frame rate. Use 30000/1001 for 29.97fps, never a float.',
      properties: {
        num: { type: 'integer', minimum: 1 },
        den: { type: 'integer', minimum: 1 },
      },
      required: ['num', 'den'],
      additionalProperties: false,
    },
    sources: { type: 'array', items: SOURCE_SCHEMA, minItems: 1 },
  } as const

  const EDL_INPUT_SCHEMA = {
    type: 'object',
    properties: {
      program: {
        ...PROGRAM_SCHEMA,
        required: ['frame_rate', 'sources'],
        description: 'The source programs this edit may draw from.',
      },
      edl: {
        type: 'array',
        items: ENTRY_SCHEMA,
        description: 'The declared cuts, in output order.',
      },
    },
    required: ['program', 'edl'],
    additionalProperties: false,
  } as const

  const CERTIFY_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['certified', 'rejected'],
        description: 'Whether the edit is safe to render.',
      },
      summary: { type: 'object', description: 'Token counts, exact duration, timecode.' },
      roundtrip: {
        type: 'object',
        description: 'Whether the declaration can be rebuilt from the tokens alone.',
      },
      coverage: {
        type: 'object',
        description: 'Per-source frame accounting: used, reused, dropped.',
      },
      errors: { type: 'array', items: { type: 'object' }, description: 'Blocking problems.' },
      warnings: { type: 'array', items: { type: 'object' }, description: 'Review, not blocking.' },
      tokens: { type: 'array', items: { type: 'object' }, description: 'The edit tokens.' },
    },
    required: ['verdict', 'summary', 'roundtrip', 'coverage', 'errors', 'warnings', 'tokens'],
  } as const

  /** Shape checks at the boundary, so a bad call never reaches the engine as a confusing error. */
  const requireTimelineInput = (input: unknown): void => {
    const payload = input as { program?: unknown; edl?: unknown } | null
    if (payload === null || typeof payload !== 'object') {
      throw new ValidationError('input must be an object with "program" and "edl"', {
        field: 'input',
      })
    }
    const program = payload.program as { sources?: unknown } | undefined
    if (program === undefined || program === null || typeof program !== 'object') {
      throw new ValidationError('"program" must be an object', { field: 'program' })
    }
    if (!Array.isArray(program.sources)) {
      throw new ValidationError('"program.sources" must be an array', { field: 'program.sources' })
    }
    if (!Array.isArray(payload.edl)) {
      throw new ValidationError('"edl" must be an array', { field: 'edl' })
    }
  }

  /**
   * Accepts either `{ timeline: {...} }` or a bare timeline object.
   *
   * The wrapper is friendlier when a timeline is one field of a larger request; the bare form
   * is what lets `wf mcp call timeline_compile @edit.json > t.json` chain straight into the next
   * tool without a shell that can reshape JSON. Both are real shapes, so both are accepted.
   */
  const timelineArg = (input: unknown): unknown => {
    const payload = input as Record<string, unknown> | null
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ValidationError('input must be an object', { field: 'input' })
    }
    if (payload['timeline'] !== undefined) {
      const wrapped = payload['timeline']
      if (wrapped === null || typeof wrapped !== 'object' || Array.isArray(wrapped)) {
        throw new ValidationError('"timeline" must be a compiled timeline object', {
          field: 'timeline',
        })
      }
      return wrapped
    }
    if (Array.isArray(payload['tokens'])) return payload
    throw new ValidationError(
      'expected a compiled timeline: pass {"timeline": <timeline>} or a bare timeline object with a "tokens" array',
      { field: 'timeline' },
    )
  }

  registry.register(
    {
      name: 'edl_certify',
      description:
        'Certify an edit before rendering it. Compiles the declared cuts into edit tokens, proves the timeline can be rebuilt from those tokens alone, audits every source frame for overlap, and returns a single verdict of "certified" or "rejected" with the reasons. Use this as the final gate before any encode. A model cannot check frame arithmetic over hundreds of tokens reliably — this tool exists because that arithmetic must be code.',
      inputSchema: EDL_INPUT_SCHEMA,
      outputSchema: CERTIFY_OUTPUT_SCHEMA,
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        requireTimelineInput(input)
        return await runEngine('certify', input)
      },
    } satisfies Tool<{ program: unknown; edl: unknown[] }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'timeline_compile',
      description:
        'Compile declared cuts into edit tokens with exact integer frame arithmetic. Returns each token with its output span and source span, the total output length, and any entries that could not be tokenized. Use this when you need the token stream itself, for example to render a timeline view.',
      inputSchema: EDL_INPUT_SCHEMA,
      outputSchema: {
        type: 'object',
        properties: {
          tokens: { type: 'array', items: { type: 'object' } },
          total_out_frames: { type: 'integer' },
          emitted_entries: { type: 'integer' },
          dropped_entries: { type: 'integer' },
          violations: { type: 'array', items: { type: 'object' } },
        },
        required: ['tokens', 'total_out_frames', 'emitted_entries', 'dropped_entries', 'violations'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        requireTimelineInput(input)
        return await runEngine('compile_timeline', input)
      },
    } satisfies Tool<{ program: unknown; edl: unknown[] }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'edl_validate',
      description:
        'Pre-flight a declared edit without compiling it. Reports every problem in one pass — unknown sources, reads past the end of a source, non-positive lengths, duplicate token ids, unknown transitions — so a broken edit can be fixed in a single round trip. Cheaper than timeline_compile when you only need to know whether the declaration is sound.',
      inputSchema: EDL_INPUT_SCHEMA,
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: 'True when no entry has an error.' },
          declared_entries: { type: 'integer' },
          violations: { type: 'array', items: { type: 'object' } },
          errors: { type: 'array', items: { type: 'object' } },
          warnings: { type: 'array', items: { type: 'object' } },
        },
        required: ['ok', 'declared_entries', 'violations', 'errors', 'warnings'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        requireTimelineInput(input)
        return await runEngine('validate_declaration', input)
      },
    } satisfies Tool<{ program: unknown; edl: unknown[] }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'timeline_verify',
      description:
        'Prove that a compiled timeline is lossless: rebuild the declaration from the edit tokens alone and compare it against the original intent. Use this when auditing a timeline you did not compile yourself, or to confirm a stored timeline is still faithful.',
      inputSchema: {
        type: 'object',
        properties: {
          timeline: {
            type: 'object',
            description: 'A timeline object as returned by timeline_compile.',
          },
        },
        required: ['timeline'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          lossless: { type: 'boolean' },
          declared_entries: { type: 'integer' },
          reconstructed_entries: { type: 'integer' },
          differences: { type: 'array', items: { type: 'object' } },
        },
        required: ['lossless', 'declared_entries', 'reconstructed_entries', 'differences'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        return await runEngine('verify_roundtrip', { timeline: timelineArg(input) })
      },
    } satisfies Tool<TimelineInput, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'coverage_audit',
      description:
        'Account for every frame of every source: which frames are used once, which are read by more than one token, and exactly which ranges are dropped. Overlapping reads are reported as reuse sites rather than errors, because reusing a range is a legitimate flashback — but an unnoticed one is how a cut disappears.',
      inputSchema: {
        type: 'object',
        properties: {
          timeline: { type: 'object', description: 'A timeline object as returned by timeline_compile.' },
        },
        required: ['timeline'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          sources: { type: 'array', items: { type: 'object' } },
          total_dropped_frames: { type: 'integer' },
          total_reused_frames: { type: 'integer' },
          all_conserved: { type: 'boolean' },
        },
        required: ['sources', 'total_dropped_frames', 'total_reused_frames', 'all_conserved'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        return await runEngine('audit_coverage', { timeline: timelineArg(input) })
      },
    } satisfies Tool<TimelineInput, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'timeline_summary',
      description:
        'Summarize a compiled timeline for display: token count, total frames, exact duration as a rational, non-drop-frame timecode, distinct sources and the transition histogram. Use this to describe a timeline in prose without recomputing its length by hand.',
      inputSchema: {
        type: 'object',
        properties: {
          timeline: { type: 'object', description: 'A timeline object as returned by timeline_compile.' },
        },
        required: ['timeline'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        return await runEngine('timeline_summary', { timeline: timelineArg(input) })
      },
    } satisfies Tool<TimelineInput, unknown>,
    { source: 'core' },
  )

  return registry
}

/** A minimal, dependency-free logger for the tool context. */
export function createContext(requestId = 'cli'): ToolContext {
  return {
    requestId,
    now: () => Date.now(),
    log: (level, message, fields) => {
      process.stderr.write(`${JSON.stringify({ level, message, requestId, ...fields })}\n`)
    },
    dataDir: process.env.PRODUCT_DATA_DIR ?? '.data',
  }
}
