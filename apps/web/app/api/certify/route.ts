import { NextResponse } from 'next/server'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Certification over HTTP.
 *
 * This route shells the same Python engine the CLI uses — there is no second implementation of
 * the frame arithmetic in TypeScript, which is exactly why the verdict is trustworthy.
 *
 * When the engine cannot be run (a deployment without Python, or a read-only filesystem) the
 * route returns 503 with a fix instead of a fabricated verdict. A certification endpoint that
 * guesses is worse than one that is unavailable.
 */
const ENGINE_PACKAGE = 'waveform_forge'

interface EngineCertify {
  readonly verdict: 'certified' | 'rejected'
  readonly summary: {
    readonly token_count: number
    readonly total_out_frames: number
    readonly total_out_timecode: string
    readonly error_count: number
    readonly warning_count: number
  }
  readonly roundtrip: { readonly lossless: boolean }
  readonly coverage: { readonly all_conserved: boolean; readonly total_reused_frames: number }
  readonly errors: readonly unknown[]
  readonly warnings: readonly unknown[]
}

function engineRoots(): string[] {
  const roots = [
    join(process.cwd(), 'services', 'engine', 'src'),
    join(process.cwd(), '..', '..', 'services', 'engine', 'src'),
  ]
  const configured = process.env.PRODUCT_ENGINE_CWD
  if (configured) roots.unshift(configured)
  return roots
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return NextResponse.json(
      { ok: false, detail: 'request body is not a JSON object', fix: 'post {"program": …, "edl": […]}' },
      { status: 400 },
    )
  }

  const cwd = engineRoots().find((root) => existsSync(root))
  if (cwd === undefined) {
    return NextResponse.json(
      {
        ok: false,
        detail: 'the Python engine is not present in this deployment',
        fix: 'run the app from the repository root, or set PRODUCT_ENGINE_CWD to services/engine/src',
      },
      { status: 503 },
    )
  }

  const { spawn } = await import('node:child_process')
  const payload = JSON.stringify({ op: 'certify', input: body })

  /**
   * Spawn the engine once.
   *
   * A `spawn` failure and a `close` both resolve this promise, and on Windows `close` can win the
   * race — which would discard the real error and report a bare "exit null". So the cause is
   * recorded separately and preferred over the exit code whenever there is one.
   */
  const runEngine = async (): Promise<{
    code: number | null
    stdout: string
    stderr: string
    cause: string | null
  }> =>
    await new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let cause: string | null = null
      let settled = false

      const child = spawn(process.env.PRODUCT_PYTHON ?? 'python', ['-m', ENGINE_PACKAGE], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, stdout, stderr, cause })
      }

      const timer = setTimeout(() => {
        child.kill()
        finish(null)
      }, 20_000)

      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      child.on('error', (error) => {
        cause = `${(error as NodeJS.ErrnoException).code ?? 'SPAWN_FAILED'}: ${error.message}`
        finish(null)
      })
      child.on('close', (code) => finish(code))

      child.stdin.end(payload)
    })

  // One retry: the first spawn after a cold start can fail transiently on Windows, and a flaky
  // certification endpoint is worse than a slightly slower one.
  let result = await runEngine()
  if (result.cause !== null || result.stdout.trim() === '') {
    result = await runEngine()
  }

  let parsed: { ok?: boolean; value?: EngineCertify; error?: { message?: string } }
  try {
    parsed = JSON.parse(result.stdout.trim()) as typeof parsed
  } catch {
    const why = result.cause ?? `exit ${result.code}`
    return NextResponse.json(
      {
        ok: false,
        detail: `the engine did not return a result (${why})`,
        fix:
          result.stderr.trim() ||
          'run `npm run pytest` to see the engine failure, and check PRODUCT_PYTHON is on PATH',
      },
      { status: 502 },
    )
  }

  if (parsed.ok !== true || parsed.value === undefined) {
    return NextResponse.json(
      {
        ok: false,
        detail: parsed.error?.message ?? 'engine reported an error',
        fix: 'check the declaration: every source_id must exist and no read may pass the source end',
      },
      { status: 422 },
    )
  }

  return NextResponse.json({ ok: true, ...parsed.value })
}
