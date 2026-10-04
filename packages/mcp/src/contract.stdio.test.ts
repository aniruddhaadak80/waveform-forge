import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'bin.js')

const VALID = JSON.parse(readFileSync(join(ROOT, 'examples', 'promo-2997.json'), 'utf8')) as unknown
const BROKEN = JSON.parse(readFileSync(join(ROOT, 'examples', 'broken.json'), 'utf8')) as unknown

function client(): Client {
  return new Client({ name: 'waveform-forge-contract-test', version: '0.1.0' })
}

function transport(): StdioClientTransport {
  // Real stdio transport against the real built binary — not an in-process shortcut, because
  // the thing being verified is that the process speaks MCP correctly.
  return new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', 'serve'] })
}

describe('MCP server contract', () => {
  it('completes initialize and reports its identity', async () => {
    const c = client()
    await c.connect(transport())
    try {
      expect(c.getServerVersion()?.name).toBe('waveform-forge')
      expect(c.getServerCapabilities()?.tools).toBeDefined()
    } finally {
      await c.close()
    }
  }, 30_000)

  it('lists at least five tools, and the product tools among them', async () => {
    const c = client()
    await c.connect(transport())
    try {
      const { tools } = await c.listTools()
      const names = tools.map((tool) => tool.name)
      expect(names.length).toBeGreaterThanOrEqual(5)
      for (const expected of [
        'edl_certify',
        'timeline_compile',
        'edl_validate',
        'timeline_verify',
        'coverage_audit',
        'timeline_summary',
        'list_presets',
      ]) {
        expect(names).toContain(expected)
      }
      // Every tool must carry a schema an MCP client can actually send.
      for (const tool of tools) expect(tool.inputSchema.type).toBe('object')
    } finally {
      await c.close()
    }
  }, 30_000)

  it('certifies a real edit over MCP, reaching the Python engine', async () => {
    const c = client()
    await c.connect(transport())
    try {
      const result = await c.callTool({
        name: 'edl_certify',
        arguments: VALID as Record<string, unknown>,
      })
      expect(result.isError).toBeFalsy()
      const payload = JSON.parse((result.content as { text: string }[])[0]!.text) as {
        verdict: string
        summary: { total_out_frames: number }
        roundtrip: { lossless: boolean }
        coverage: { all_conserved: boolean; total_reused_frames: number }
      }
      expect(payload.verdict).toBe('certified')
      expect(payload.summary.total_out_frames).toBe(1965)
      expect(payload.roundtrip.lossless).toBe(true)
      expect(payload.coverage.all_conserved).toBe(true)
      expect(payload.coverage.total_reused_frames).toBe(3)
    } finally {
      await c.close()
    }
  }, 60_000)

  it('returns a real rejection with every violation for a broken edit', async () => {
    const c = client()
    await c.connect(transport())
    try {
      const result = await c.callTool({
        name: 'edl_certify',
        arguments: BROKEN as Record<string, unknown>,
      })
      const payload = JSON.parse((result.content as { text: string }[])[0]!.text) as {
        verdict: string
        errors: { code: string }[]
      }
      expect(payload.verdict).toBe('rejected')
      expect(payload.errors.map((error) => error.code)).toEqual(
        expect.arrayContaining(['READS_PAST_END', 'UNKNOWN_SOURCE', 'NON_POSITIVE_LENGTH']),
      )
    } finally {
      await c.close()
    }
  }, 60_000)

  it('returns an error envelope for invalid input rather than crashing', async () => {
    const c = client()
    await c.connect(transport())
    try {
      const result = await c.callTool({ name: 'edl_certify', arguments: { nope: true } })
      expect(result.isError).toBe(true)
      const text = (result.content as { text: string }[])[0]!.text
      expect(text).toContain('VALIDATION_FAILED')
    } finally {
      await c.close()
    }
  }, 30_000)

  it('is stateless: the same call twice gives the same answer', async () => {
    const c = client()
    await c.connect(transport())
    try {
      const first = await c.callTool({
        name: 'edl_certify',
        arguments: VALID as Record<string, unknown>,
      })
      const second = await c.callTool({
        name: 'edl_certify',
        arguments: VALID as Record<string, unknown>,
      })
      // durationMs lives inside the engine, not the tool result, so the payloads must match.
      expect((first.content as { text: string }[])[0]!.text).toBe(
        (second.content as { text: string }[])[0]!.text,
      )
    } finally {
      await c.close()
    }
  }, 90_000)
})
