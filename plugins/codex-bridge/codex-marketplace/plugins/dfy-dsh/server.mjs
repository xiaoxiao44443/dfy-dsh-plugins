import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SERVER_NAME = 'dfy-dsh'
const SERVER_VERSION = '0.1.1'
const DISCOVERY_PATH = process.env.DSH_CODEX_BRIDGE_FILE
  || join(homedir(), '.saltfish', 'dfy-dsh', 'codex-bridge-endpoint.json')

const STATIC_TOOLS = [
  {
    name: 'dsh_list_sessions',
    description: 'List active DeepSeek Harness agent sessions available to this local bridge.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'dsh_create_session',
    description: 'Create a new DeepSeek Harness conversation. By default it inherits the most recently active Harness session\'s workspace, model route, Agent preset, tools, and skills.',
    inputSchema: {
      type: 'object',
      properties: {
        templateSessionId: {
          type: 'string',
          description: 'Optional active Harness session to inherit. Omit to use the most recently active session.',
        },
        workspaceId: { type: 'string', description: 'Optional existing Harness workspace id.' },
        cwd: { type: 'string', description: 'Optional absolute workspace directory. A workspace entry is created when needed.' },
        provider: { type: 'string', description: 'Optional provider route override.' },
        model: { type: 'string', description: 'Optional model id override.' },
        maxTokens: { type: 'integer', minimum: 1, description: 'Optional maximum output tokens override.' },
        agentPreset: { type: 'string', description: 'Optional Agent preset id override.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_send_message',
    description: 'Send a message to an existing DeepSeek Harness session and return a runId immediately. queue starts a follow-up turn; steer targets the nearest step boundary. Supply clientRequestId to make retries idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 100000, description: 'Message text to send.' },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          default: 'queue',
          description: 'queue creates a follow-up turn; steer injects at the nearest step boundary.',
        },
        clientRequestId: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Optional caller-generated idempotency key scoped to the session.',
        },
        sessionId: {
          type: 'string',
          description: 'Optional active Harness session id. Omit to use the most recently active session.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_get_run',
    description: 'Read one Harness run: status, output accumulated so far, text/reasoning deltas since cursor, tool calls/results, completion reason, and errors. When outputReset=true, replace previously collected output with latestText and the returned reasoningDelta instead of appending.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', minLength: 1, description: 'runId returned by dsh_send_message.' },
        cursor: { type: 'string', description: 'Optional opaque cursor from an earlier run response for incremental output.' },
        maxEvents: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_wait_run',
    description: 'Long-poll one Harness run for at most 30 seconds. Returns immediately when cursor changes or the run is terminal; otherwise returns heartbeat=true at the deadline. When outputReset=true, replace previously collected output with latestText and the returned reasoningDelta instead of appending.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', minLength: 1, description: 'runId returned by dsh_send_message.' },
        cursor: { type: 'string', description: 'Opaque cursor from dsh_send_message, dsh_get_run, or the previous wait.' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 30000, default: 25000 },
        maxEvents: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_cancel_run',
    description: 'Cancel one queued or active Harness run without clearing unrelated queued messages. Reports cancelled, no_op, or timeout and returns the latest run snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', minLength: 1, description: 'runId returned by dsh_send_message.' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 30000, default: 10000 },
        maxEvents: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_read_messages',
    description: 'Read public conversation events from a Harness session at or after a numeric event cursor, including user/assistant messages, tool calls/results, and turn boundaries.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Optional active Harness session id. Omit to use the most recently active session.',
        },
        cursor: { type: 'integer', minimum: 0, default: 0, description: 'Inclusive session event cursor.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_list_tools',
    description: 'List the Harness tools currently available to the selected session. Use this when the dynamic MCP catalog is stale or session-specific.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Optional active Harness session id. Omit to use the most recently active session.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_call_tool',
    description: 'Call one Harness tool directly through the selected session while preserving Harness permission checks. Use this when the named tool is not present in the current MCP catalog.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Exact Harness tool name returned by dsh_list_tools.' },
        arguments: {
          type: 'object',
          description: 'Arguments for the Harness tool. Omit when the tool takes no arguments.',
          additionalProperties: true,
        },
        sessionId: {
          type: 'string',
          description: 'Optional active Harness session id. Omit to use the most recently active session.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_list_skills',
    description: 'List model-invocable skills exposed by the selected DeepSeek Harness session.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'Optional active Harness session id.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_read_skill',
    description: 'Read the complete instructions for one DeepSeek Harness skill before using it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Harness skill name.' },
        sessionId: { type: 'string', description: 'Optional active Harness session id.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
]

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  while (true) {
    const newline = input.indexOf('\n')
    if (newline < 0) break
    const line = input.slice(0, newline).trim()
    input = input.slice(newline + 1)
    if (line.length === 0) continue
    void handleLine(line)
  }
})

async function handleLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch (error) {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error) } })
    return
  }
  if (!Object.hasOwn(message, 'id')) return
  try {
    const result = await dispatch(message.method, message.params ?? {})
    write({ jsonrpc: '2.0', id: message.id, result })
  } catch (error) {
    write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    })
  }
}

async function dispatch(method, params) {
  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }
  }
  if (method === 'ping') return {}
  if (method === 'tools/list') {
    let dynamic = []
    try {
      const result = await bridgeRequest('tools.list', {})
      dynamic = Array.isArray(result?.tools) ? result.tools : []
    } catch (error) {
      process.stderr.write(`[dfy-dsh] ${error instanceof Error ? error.message : String(error)}\n`)
    }
    const reserved = new Set(STATIC_TOOLS.map((tool) => tool.name))
    return {
      tools: [
        ...STATIC_TOOLS,
        ...dynamic
          .filter((tool) => tool && typeof tool.name === 'string' && !reserved.has(tool.name))
          .map((tool) => ({
            name: tool.name,
            description: typeof tool.description === 'string' ? tool.description : '',
            inputSchema: addSessionId(tool.parameters),
          })),
      ],
    }
  }
  if (method === 'tools/call') {
    const name = params.name
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    if (name === 'dsh_list_sessions') return jsonResult(await bridgeRequest('sessions.list', {}))
    if (name === 'dsh_create_session') return jsonResult(await bridgeRequest('sessions.create', args))
    if (name === 'dsh_send_message') return jsonResult(await bridgeRequest('runs.send', args))
    if (name === 'dsh_get_run') return jsonResult(await bridgeRequest('runs.get', args))
    if (name === 'dsh_wait_run') return jsonResult(await bridgeRequest('runs.wait', args))
    if (name === 'dsh_cancel_run') return jsonResult(await bridgeRequest('runs.cancel', args))
    if (name === 'dsh_read_messages') return jsonResult(await bridgeRequest('messages.read', args))
    if (name === 'dsh_list_tools') return jsonResult(await bridgeRequest('tools.list', sessionSelection(args)))
    if (name === 'dsh_call_tool') {
      if (typeof args.name !== 'string' || args.name.trim().length === 0) throw new Error('dsh_call_tool requires a Harness tool name')
      if (args.arguments !== undefined && (args.arguments === null || typeof args.arguments !== 'object' || Array.isArray(args.arguments))) {
        throw new Error('dsh_call_tool arguments must be an object')
      }
      return toolResult(await bridgeRequest('tools.call', {
        name: args.name.trim(),
        arguments: args.arguments ?? {},
        ...sessionSelection(args),
      }))
    }
    if (name === 'dsh_list_skills') return jsonResult(await bridgeRequest('skills.list', args))
    if (name === 'dsh_read_skill') return skillResult(await bridgeRequest('skills.get', args))
    if (typeof name !== 'string' || name.length === 0) throw new Error('Missing MCP tool name')
    return toolResult(await bridgeRequest('tools.call', {
      name,
      arguments: withoutSessionId(args),
      ...(typeof args.sessionId === 'string' ? { sessionId: args.sessionId } : {}),
    }))
  }
  throw new Error(`Unsupported MCP method: ${method}`)
}

function addSessionId(schema) {
  const source = schema && typeof schema === 'object' && !Array.isArray(schema)
    ? schema
    : { type: 'object', properties: {} }
  return {
    ...source,
    type: 'object',
    properties: {
      ...(source.properties && typeof source.properties === 'object' ? source.properties : {}),
      sessionId: {
        type: 'string',
        description: 'Optional active Harness session id. Omit to use the most recently active session.',
      },
    },
  }
}

function withoutSessionId(args) {
  const result = { ...args }
  delete result.sessionId
  return result
}

function sessionSelection(args) {
  return typeof args.sessionId === 'string' && args.sessionId.length > 0
    ? { sessionId: args.sessionId }
    : {}
}

async function bridgeRequest(method, params) {
  let discovery
  try {
    discovery = JSON.parse(await readFile(DISCOVERY_PATH, 'utf8'))
  } catch {
    throw new Error('DeepSeek Harness is not running or the Codex bridge is disabled. Check 设置 → 插件 → Codex 连接.')
  }
  if (typeof discovery.origin !== 'string' || typeof discovery.token !== 'string') {
    throw new Error('DeepSeek Harness bridge discovery file is invalid')
  }
  const response = await fetch(new URL('/v1/rpc', discovery.origin), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${discovery.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(60 * 60_000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || typeof payload.error === 'string') {
    throw new Error(typeof payload.error === 'string' ? payload.error : `Harness bridge HTTP ${response.status}`)
  }
  return payload.result
}

function toolResult(result) {
  if (result && Array.isArray(result.content)) {
    return { content: result.content, ...(result.isError === true ? { isError: true } : {}) }
  }
  return jsonResult(result)
}

function skillResult(skill) {
  if (skill && typeof skill.content === 'string') return { content: [{ type: 'text', text: skill.content }] }
  return jsonResult(skill)
}

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
