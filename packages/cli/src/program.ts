import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Command } from 'commander'
import { buildToolRegistry, createContext } from './bootstrap.js'
import { doctor, renderReport } from './doctor.js'

const VERSION = '0.1.0'

/**
 * Decode a file that may have been written by any shell.
 *
 * Redirecting stdout to a file from PowerShell 5.1 produces UTF-16 with a BOM, and `JSON.parse`
 * rejects both the BOM and the NUL-interleaved content. Without this, the documented
 * `wf mcp call timeline_compile @edit.json > timeline.json` pipeline breaks on Windows only.
 */
export function readTextJson(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  const text = buffer.toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Exit codes are part of the contract: 0 ok, 1 runtime failure, 2 usage error. */
export function buildProgram(): Command {
  const program = new Command()

  program
    .name('wf')
    .description('waveform-forge — A self-hosted agent product with a deterministic core.')
    .version(VERSION, '-v, --version', 'print the version')
    .exitOverride((error) => {
      process.exitCode = error.exitCode === 0 ? 0 : 2
      throw error
    })

  program
    .command('doctor')
    .description('diagnose every subsystem and print an actionable report')
    .option('--json', 'machine-readable output')
    .action(async () => {
      const report = await doctor()
      process.stdout.write(
        process.argv.includes('--json')
          ? `${JSON.stringify(report, null, 2)}\n`
          : `${renderReport(report)}\n`,
      )
      if (!report.ok) process.exitCode = 1
    })

  program
    .command('tools')
    .description('list the registered tools — the authoritative capability list')
    .option('--json', 'machine-readable output')
    .action(() => {
      const registry = buildToolRegistry()
      const tools = registry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        surface: registry.surfaceOf(tool.name),
        source: registry.sourceOf(tool.name),
        permissions: tool.permissions,
        inputSchema: tool.inputSchema,
      }))
      if (process.argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`)
        return
      }
      const width = Math.max(...tools.map((t) => t.name.length), 4)
      for (const tool of tools) {
        process.stdout.write(`  ${tool.name.padEnd(width)}  [${tool.surface}]  ${tool.description}\n`)
      }
    })

  program
    .command('skills')
    .description('load the skill catalog from disk and report every validation issue')
    .option('--json', 'machine-readable output')
    .option('--bodies', 'include each skill body')
    .action(async () => {
      const { loadCatalog } = await import('@waveformforge/skills')
      const result = loadCatalog(join(process.cwd(), 'skills'))
      const skills = result.skills.map((skill) => ({
        name: skill.name,
        version: skill.version,
        description: skill.description,
        ...(process.argv.includes('--bodies') ? { body: skill.body } : {}),
      }))
      if (process.argv.includes('--json')) {
        process.stdout.write(
          `${JSON.stringify({ count: skills.length, issues: result.issues, skills }, null, 2)}\n`,
        )
      } else {
        const width = Math.max(...skills.map((s) => s.name.length), 5)
        for (const skill of skills) {
          process.stdout.write(`  ${skill.name.padEnd(width)}  v${skill.version}  ${skill.description}\n`)
        }
        for (const issue of result.issues) process.stdout.write(`  [ISSUE] ${issue}\n`)
        process.stdout.write(`\n${skills.length} skills, ${result.issues.length} issues\n`)
      }
      // A skill that fails to load is a product defect, so it fails the command.
      if (result.issues.length > 0) process.exitCode = 1
    })

  program
    .command('plugins')
    .description('resolve the plugin registry, reporting why each plugin was accepted or rejected')
    .option('--json', 'machine-readable output')
    .action(async () => {
      const { buildRegistry } = await import('@waveformforge/plugins')
      const result = buildRegistry(join(process.cwd(), 'plugins'))
      if (process.argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        return
      }
      for (const plugin of result.active) {
        process.stdout.write(
          `  [ACTIVE]   ${plugin.manifest.name}@${plugin.manifest.version}  ${plugin.manifest.capabilities.join(', ')}\n`,
        )
      }
      for (const plugin of result.disabled) {
        process.stdout.write(`  [DISABLED] ${plugin.manifest.name}\n`)
      }
      for (const plugin of result.rejected) {
        process.stdout.write(`  [REJECTED] ${plugin.path}\n`)
        for (const issue of plugin.issues) process.stdout.write(`             ${issue}\n`)
      }
      process.stdout.write(
        `\n${result.active.length} active, ${result.disabled.length} disabled, ${result.rejected.length} rejected\n`,
      )
    })

  const mcp = program.command('mcp').description('Model Context Protocol commands')

  mcp
    .command('serve')
    .description('run the MCP server over stdio')
    .action(async () => {
      const { serveStdio } = await import('@waveformforge/mcp')
      const registry = buildToolRegistry()
      // stdout belongs to the protocol from here on; diagnostics must go to stderr.
      await serveStdio(registry, createContext('mcp'))
    })

  mcp
    .command('call')
    .description('invoke one tool directly, without MCP')
    .argument('<tool>', 'tool name')
    .argument('<input>', 'JSON input document, or @path/to/file.json to read it from disk')
    .action(async (tool: string, raw: string) => {
      let source = raw
      // An edit decision list is comfortably longer than a command line should carry, and every
      // shell mangles embedded quotes differently. @path is the reliable way to pass one.
      if (raw.startsWith('@')) {
        const path = raw.slice(1)
        try {
          source = readTextJson(readFileSync(path))
        } catch (cause) {
          process.stderr.write(`error: cannot read ${path} — ${String(cause)}\n`)
          process.exitCode = 2
          return
        }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(source)
      } catch (cause) {
        process.stderr.write(`error: input is not valid JSON — ${String(cause)}\n`)
        process.exitCode = 2
        return
      }
      const registry = buildToolRegistry()
      try {
        const value = await registry.invoke(tool, parsed, createContext('cli'), [
          'fs:read',
          'net:fetch',
          'proc:spawn',
        ])
        process.stdout.write(`${JSON.stringify(value ?? null, null, 2)}\n`)
      } catch (cause) {
        const code = (cause as { code?: string }).code ?? 'INTERNAL'
        process.stderr.write(`${code}: ${cause instanceof Error ? cause.message : String(cause)}\n`)
        process.exitCode = 1
      }
    })

  program
    .command('version')
    .description('print version and runtime information as JSON')
    .action(() => {
      process.stdout.write(
        `${JSON.stringify(
          {
            name: 'waveform-forge',
            version: VERSION,
            node: process.versions.node,
            platform: process.platform,
            tools: buildToolRegistry().size,
          },
          null,
          2,
        )}\n`,
      )
    })

  return program
}
