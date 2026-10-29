import type { ApiContentBlock, ApiMessage } from 'claude-code'

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

// What the terminal draws of an assistant block between two tool calls: a reply, thinking
// that has text, and a server tool's call and result (the advisor's), drawn by Claude Code.
function isDrawn(block: ApiContentBlock): boolean {
  switch (block.type) {
    case 'text':
      return String(block.text).trim() !== ''
    case 'thinking':
      return String(block.thinking).trim() !== ''
    case 'redacted_thinking':
      return false
    default:
      return true
  }
}

// Which tool calls open a run of tool rows: what the transcript drew right before the call
// is not one of the skin's rows. A prompt, a drawn block and a row Claude Code draws (an
// agent, a question) end a run; results draw nothing, nor does a user text that rides in
// beside a result (a skill's).
export function runStarts(messages: readonly ApiMessage[]): Map<string, boolean> {
  const starts = new Map<string, boolean>()
  let isAfterRow = false

  for (const { role, content } of messages) {
    if (role === 'user' && !content.some(block => block.type === 'tool_result')) {
      isAfterRow = false
    }

    for (const block of role === 'assistant' ? content : []) {
      if (block.type === 'tool_use') {
        starts.set(String(block.id), !isAfterRow)
        isAfterRow = kindOf(String(block.name)) !== null
      } else if (isDrawn(block)) {
        isAfterRow = false
      }
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
