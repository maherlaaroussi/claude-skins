import type { SessionMessage } from 'claude-code'

import { oneLine, shortenPath } from './format'
import type { Kind } from './skin'

const BUILTIN: Readonly<Record<string, Kind>> = {
  Bash: 'run',
  PowerShell: 'run',
  Read: 'read',
  Edit: 'write',
  MultiEdit: 'write',
  Write: 'write',
  NotebookEdit: 'write',
  Glob: 'search',
  Grep: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Skill: 'other',
  TaskCreate: 'other',
  TaskUpdate: 'other',
}

const MAX_TARGET = 120

// Null leaves the row to Claude Code: agents, plan mode and todos draw live progress
// and dialogs that a skin would have to rebuild.
export function kindOf(tool: string): Kind | null {
  if (tool.startsWith('mcp__')) {
    return 'mcp'
  }

  return BUILTIN[tool] ?? null
}

// Which tool calls open a run of tool rows: the call the transcript drew right before it,
// if any, was not a tool call but a prompt or a reply. Thinking and results draw nothing
// between two calls, nor does a user text that rides in after a result (a skill's).
export function runStarts(messages: readonly SessionMessage[]): Map<string, boolean> {
  const starts = new Map<string, boolean>()
  let isAfterCall = false

  for (const [i, message] of messages.entries()) {
    const hasResults = (message.toolResults?.length ?? 0) > 0
    const isInjected = (messages[i - 1]?.toolResults?.length ?? 0) > 0

    if (message.text !== '' && !hasResults && !(message.role === 'user' && isInjected)) {
      isAfterCall = false
    }

    for (const use of message.toolUses) {
      starts.set(use.tool_use_id, !isAfterCall)
      isAfterCall = true
    }
  }

  return starts
}

// `mcp__github__search_code` reads as `github:search_code`.
export function toolLabel(tool: string): string {
  if (!tool.startsWith('mcp__')) {
    return tool
  }

  const [, server = '', ...name] = tool.split('__')

  return `${server}:${name.join('__')}`
}

type Fields = Readonly<Record<string, unknown>>

const fieldsOf = (input: unknown): Fields =>
  typeof input === 'object' && input !== null ? (input as Fields) : {}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

const firstString = (fields: Fields): string =>
  Object.values(fields).map(textOf).find(value => value !== '') ?? ''

// The one thing about a call worth a glance: the command, the file, the pattern.
export function summarize(tool: string, input: unknown, cwd: string): string {
  const fields = fieldsOf(input)

  const summary = ((): string => {
    switch (tool) {
      case 'Bash':
      case 'PowerShell':
        return textOf(fields.command)
      case 'Read':
      case 'Edit':
      case 'MultiEdit':
      case 'Write':
        return shortenPath(textOf(fields.file_path), cwd)
      case 'NotebookEdit':
        return shortenPath(textOf(fields.notebook_path), cwd)
      case 'Glob':
        return textOf(fields.pattern)
      case 'Grep': {
        const where = textOf(fields.path)

        return where === ''
          ? textOf(fields.pattern)
          : `${textOf(fields.pattern)} in ${shortenPath(where, cwd)}`
      }
      case 'WebFetch':
        return textOf(fields.url).replace(/^https?:\/\//, '')
      case 'WebSearch':
        return textOf(fields.query)
      case 'TaskUpdate':
        return [textOf(fields.taskId), textOf(fields.status)].filter(part => part !== '').join(' → ')
      default:
        return firstString(fields)
    }
  })()

  return oneLine(summary).slice(0, MAX_TARGET)
}
