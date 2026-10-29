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

// The rows Claude Code draws for a user text nobody typed, as the API form frames it: a task's
// notification (inside its system reminder), an agent's message, a nested CLAUDE.md the call
// loaded (`└ Loaded`).
// shortcut: matches the framing Claude Code 2.1.312 writes, upgrade if a build renames it.
const NOTIFICATION = /^(?:<system-reminder>\s*\[SYSTEM NOTIFICATION[\s\S]*?)?<task-notification>/
const MESSAGE = /<agent-message from=/
const LOADED = /^<system-reminder>\s*Contents of /

const textsOf = (content: readonly ApiContentBlock[]): string[] => content.flatMap(block => (block.type === 'text' ? [String(block.text)] : []))
const hasResult = (content: readonly ApiContentBlock[]): boolean => content.some(block => block.type === 'tool_result')
const isNotice = (content: readonly ApiContentBlock[]): boolean => textsOf(content).some(said => NOTIFICATION.test(said) || MESSAGE.test(said))
// A tool Claude Code draws nothing of: a tool search.
export const isHidden = (tool: string): boolean => tool === 'ToolSearch'
const isSearch = (block: ApiContentBlock): boolean => block.type === 'tool_use' && isHidden(String(block.name))
// A server tool's call and result (the advisor's), a row Claude Code draws.
const isServerTool = (block: ApiContentBlock): boolean => block.type === 'server_tool_use' || block.type.endsWith('_tool_result')

// Which tool calls open a run of tool rows: what the transcript drew right before the call
// is not a row. A prompt and a drawn block end a run; results draw nothing, nor does a user
// text that rides in beside a result (a skill's). A row Claude Code draws (an agent, a
// question, a stopped task), a notification, an agent's message and the advisor sit tight
// against the row under them, as one of the skin's rows does.
export function runStarts(messages: readonly ApiMessage[]): Map<string, boolean> {
  const starts = new Map<string, boolean>()
  let isAfterRow = false

  for (const { role, content } of messages) {
    if (role === 'user' && (isNotice(content) || !hasResult(content))) {
      isAfterRow = isNotice(content)
    }

    for (const block of role === 'assistant' ? content : []) {
      if (isSearch(block)) {
        continue
      } else if (block.type === 'tool_use') {
        starts.set(String(block.id), !isAfterRow)
        isAfterRow = true
      } else if (isServerTool(block)) {
        isAfterRow = true
      } else if (isDrawn(block)) {
        isAfterRow = false
      }
    }
  }

  return starts
}

type Above = 'row' | 'loaded' | 'other'

// Whether each reply is drawn right under a notification, an agent's message, the advisor or
// a CLAUDE.md load, by its text: a render names no block. Claude Code draws a load at the end
// of its group of tool rows, so a load stays above the reply through the calls after it; a
// message does not.
export function repliesUnderNotices(messages: readonly ApiMessage[]): Map<string, boolean> {
  const replies = new Map<string, boolean>()
  let above: Above = 'other'

  for (const { role, content } of messages) {
    if (role === 'user') {
      if (isNotice(content)) {
        above = 'row'
      } else if (!hasResult(content)) {
        above = 'other'
      } else if (textsOf(content).some(said => LOADED.test(said))) {
        above = 'loaded'
      }

      continue
    }

    for (const block of content) {
      if (isSearch(block)) {
        continue
      }

      if (block.type === 'text' && isDrawn(block)) {
        replies.set(String(block.text).trim(), above !== 'other')
      }

      if (isServerTool(block)) {
        above = 'row'
      } else if (block.type === 'tool_use' ? above === 'row' : isDrawn(block)) {
        above = 'other'
      }
    }
  }

  return replies
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
