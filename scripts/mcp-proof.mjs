#!/usr/bin/env node
/**
 * Paste-able MCP proof.
 *
 * Sends real JSON-RPC over a real stdio pipe to `wf mcp serve` and prints the exchange. This is
 * the transcript, not a summary of it — the point is that the protocol handshake, the tool list
 * and a tool call that reaches the Python engine are all observable.
 *
 *   node scripts/mcp-proof.mjs
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'bin.js')

const EDL = {
  program: {
    frame_rate: { num: 30000, den: 1001 },
    sources: [
      { id: 'cam_a', duration_frames: 45000, label: 'Street interview' },
      { id: 'cam_b', duration_frames: 30000, label: 'B-roll city' },
    ],
  },
  edl: [
    { source_id: 'cam_a', src_start_frame: 900, frame_count: 1200, token_id: 'open' },
    { source_id: 'cam_b', src_start_frame: 0, frame_count: 600, transition: 'dissolve' },
    { source_id: 'cam_a', src_start_frame: 2097, frame_count: 45 },
  ],
}

const child = spawn(process.execPath, [CLI, 'mcp', 'serve'], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
})

const replies = new Map()
const lines = createInterface({ input: child.stdout })
lines.on('line', (line) => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.id !== undefined) replies.set(message.id, message)
})

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
  return message.id
}

async function await_(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = replies.get(id)
    if (found !== undefined) return found
    await new Promise((resolve_) => setTimeout(resolve_, 50))
  }
  throw new Error(`timed out waiting for response to id=${id}`)
}

function show(label, value) {
  console.log(`\n--- ${label} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

try {
  // 1. initialize
  const initId = send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-proof', version: '0.1.0' },
    },
  })
  const init = await await_(initId)
  show('initialize →', init.result)

  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  // 2. tools/list
  const listId = send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const list = await await_(listId)
  const names = list.result.tools.map((tool) => tool.name)
  show('tools/list → names', names)
  show('tools/list → count', `${names.length} tools`)
  show(
    'tools/list → edl_certify description',
    list.result.tools.find((tool) => tool.name === 'edl_certify')?.description?.slice(0, 160) + '…',
  )

  // 3. tools/call that reaches the Python engine
  const callId = send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'edl_certify', arguments: EDL },
  })
  const call = await await_(callId, 60_000)
  const verdict = JSON.parse(call.result.content[0].text)
  show('tools/call edl_certify →', {
    verdict: verdict.verdict,
    total_out_frames: verdict.summary.total_out_frames,
    total_out_timecode: verdict.summary.total_out_timecode,
    lossless: verdict.roundtrip.lossless,
    all_conserved: verdict.coverage.all_conserved,
    total_reused_frames: verdict.coverage.total_reused_frames,
    tokens: verdict.tokens.length,
  })

  // 4. error envelope
  const badId = send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'edl_certify', arguments: { nope: true } },
  })
  const bad = await await_(badId)
  show('tools/call with invalid input →', bad.result)

  console.log('\nMCP surface verified over real stdio.')
} finally {
  child.stdin.end()
  child.kill()
  await once(child, 'exit').catch(() => undefined)
}
