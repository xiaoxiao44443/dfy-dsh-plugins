import type { Agent } from '@deepseek-ai/dsh-agent';
import {
  MessageId,
  createUserMessage,
  freezeMessage,
  type ContentBlock,
  type LlmFailure,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm';
import type { SessionEvent as HarnessSessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
import { createHash } from 'node:crypto';
import { chunkText, settledText, LiveAssistantStream, type AssistantStreamFrame } from './streams.js';

// V3 settles assistant messages instead of persisting stream chunks. Keep the
// released chunk shape here so old hosts remain readable with either SDK's types.
type SessionEvent = HarnessSessionEvent | {
  type: 'assistant/chunk';
  seq: HarnessSessionEvent['seq'];
  time: number;
  data: { turn: number; step: number; chunk: StreamChunk };
} | {
  type: 'assistant/attempt'; seq: HarnessSessionEvent['seq']; time: number;
  data: { turn: number; step: number; stream: unknown[] };
};

export type RunMode = 'queue' | 'steer';
export type RunStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

interface RunError {
  message: string;
  code?: string;
  step?: number;
}

interface RunRecord {
  runId: string;
  agentId: string;
  messageId: string;
  mode: RunMode;
  clientRequestId?: string;
  startSeq: number;
  submittedAt: number;
  turn?: number;
  revision: number;
  cancellationRequested: boolean;
  discarded: boolean;
  disposed: boolean;
  errors: RunError[];
}

export interface LocatedMessage {
  message: UserMessage;
  mode: RunMode;
  startSeq: number;
  turn?: number;
}

export interface RunSnapshot {
  runId: string;
  sessionId: string;
  messageId: string;
  mode: RunMode;
  status: RunStatus;
  terminal: boolean;
  cursor: string;
  changed: boolean;
  submittedAt: number;
  turn?: number;
  completion?: TurnEndReason;
  latestText: string;
  textDelta: string;
  reasoningDelta: string;
  /** Replace previous streamed output when a transient attempt was abandoned. */
  outputReset: boolean;
  toolCalls: Record<string, unknown>[];
  events: Record<string, unknown>[];
  eventsTruncated: boolean;
  outputTruncated: boolean;
  errors: RunError[];
  agentStatus?: Agent['status'];
}

const RUN_PREFIX = 'dsh-run-';
const MAX_OUTPUT_CHARS = 500_000;
const MAX_ARGUMENT_CHARS = 20_000;
const DEFAULT_MAX_EVENTS = 100;

/** rc.1+ exposes immutable snapshots; retain older hosts' event-array support. */
function sessionEvents(session: Agent['session']): readonly SessionEvent[] {
  const view = session as unknown as {
    snapshotEvents?: () => readonly SessionEvent[];
    events?: readonly SessionEvent[];
  };
  if (typeof view.snapshotEvents === 'function') return view.snapshotEvents();
  if (Array.isArray(view.events)) return view.events;
  throw new Error('当前 Harness 不支持读取会话事件');
}

function bounded(value: string, maximum: number): { text: string; truncated: boolean } {
  if (value.length <= maximum) return { text: value, truncated: false };
  return { text: value.slice(0, maximum), truncated: true };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function deterministicMessageId(sessionId: string, clientRequestId: string): ReturnType<typeof MessageId> {
  const digest = createHash('sha256')
    .update('dsh-codex-bridge\0')
    .update(sessionId)
    .update('\0')
    .update(clientRequestId)
    .digest('hex');
  return MessageId(`message-codex-${digest}`);
}

export function runIdForMessageId(messageId: string): string {
  return `${RUN_PREFIX}${Buffer.from(messageId, 'utf8').toString('base64url')}`;
}

export function messageIdFromRunId(runId: string): string | undefined {
  if (!runId.startsWith(RUN_PREFIX)) return undefined;
  try {
    const value = Buffer.from(runId.slice(RUN_PREFIX.length), 'base64url').toString('utf8');
    return value.length > 0 && runIdForMessageId(value) === runId ? value : undefined;
  } catch {
    return undefined;
  }
}

export function createRunMessage(text: string, sessionId: string, clientRequestId?: string): UserMessage {
  if (clientRequestId === undefined) {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
  }
  return freezeMessage({
    id: deterministicMessageId(sessionId, clientRequestId),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
}

function textFromBlocks(blocks: readonly ContentBlock[]): string {
  let text = '';
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'reasoning') text += block.text;
    else if (block.type === 'tool-result') text += textFromBlocks(block.content);
  }
  return text;
}

export function userMessageText(message: UserMessage): string {
  return textFromBlocks(message.content.filter((block): block is ContentBlock => block.type === 'text'));
}

function publicContent(blocks: readonly ContentBlock[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'reasoning') result.push({ type: block.type, text: block.text });
    else if (block.type === 'image') result.push({ type: 'image' });
    else if (block.type === 'tool-call') {
      result.push({
        type: 'tool_call',
        callId: String(block.id),
        name: block.name,
        arguments: bounded(block.arguments, MAX_ARGUMENT_CHARS).text,
      });
    } else if (block.type === 'tool-result') {
      result.push({
        type: 'tool_result',
        callId: String(block.toolCallId),
        isError: block.isError === true,
        text: bounded(textFromBlocks(block.content), MAX_ARGUMENT_CHARS).text,
      });
    }
  }
  return result;
}

function eventTurn(event: SessionEvent): number | undefined {
  switch (event.type) {
    case 'turn/start':
    case 'turn/end':
    case 'step/start':
    case 'step/end':
    case 'assistant/chunk':
    case 'assistant/message':
    case 'assistant/attempt':
    case 'tool/call':
    case 'tool/result':
      return event.data.turn;
    default:
      return undefined;
  }
}

function terminalStatus(reason: TurnEndReason): RunStatus {
  if (reason.kind === 'completed') return 'completed';
  if (reason.kind === 'aborted') return 'cancelled';
  return 'failed';
}

function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function failureError(failure: LlmFailure, step?: number): RunError {
  return { message: failure.message, code: failure.code, ...(step === undefined ? {} : { step }) };
}

function unknownError(error: unknown, step?: number): RunError {
  const record = asRecord(error);
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === 'string'
      ? record.message
      : String(error);
  const code = typeof record?.code === 'string' ? record.code : undefined;
  return { message, ...(code === undefined ? {} : { code }), ...(step === undefined ? {} : { step }) };
}

function cursorParts(cursor: string | undefined): { revision: number; seq: number; text?: number; reasoning?: number; epoch?: number } | undefined {
  if (cursor === undefined) return undefined;
  const match = /^(\d+):(\d+)(?::(\d+):(\d+):(\d+))?$/.exec(cursor);
  if (match === null) throw new Error('cursor 格式无效');
  const revision = Number(match[1]);
  const seq = Number(match[2]);
  if (match.slice(1).some((value) => value !== undefined && !Number.isSafeInteger(Number(value)))) throw new Error('cursor 超出有效范围');
  return { revision, seq, ...(match[3] === undefined ? {} : { text: Number(match[3]), reasoning: Number(match[4]), epoch: Number(match[5]) }) };
}

function findTurnAndSeq(events: readonly SessionEvent[], messageId: string): { turn?: number; seq?: number } {
  let currentTurn: number | undefined;
  for (const event of events) {
    if (event.type === 'turn/start') currentTurn = event.data.turn;
    if (event.type === 'user/message' && String(event.data.id) === messageId) {
      return { turn: currentTurn, seq: event.seq };
    }
    if (event.type === 'turn/end' && currentTurn === event.data.turn) currentTurn = undefined;
  }
  return {};
}

export function findMessageInAgent(agent: Agent, messageId: string): LocatedMessage | undefined {
  const queued = agent.inbox.nextTurn.find((message) => String(message.id) === messageId);
  if (queued !== undefined) return { message: queued, mode: 'queue', startSeq: agent.session.seq };
  const steering = agent.inbox.nextStep.find((message) => String(message.id) === messageId);
  if (steering !== undefined) return { message: steering, mode: 'steer', startSeq: agent.session.seq };
  const events = sessionEvents(agent.session);
  const located = findTurnAndSeq(events, messageId);
  if (located.seq === undefined) return undefined;
  const event = events[located.seq];
  if (event?.type !== 'user/message') return undefined;
  return {
    message: event.data,
    mode: 'queue',
    startSeq: event.seq,
    ...(located.turn === undefined ? {} : { turn: located.turn }),
  };
}

function resultCallId(event: Extract<SessionEvent, { type: 'tool/result' }>): string | undefined {
  if (event.data.message.source.kind === 'tool') return String(event.data.message.source.callId);
  for (const block of event.data.message.content) {
    if (block.type === 'tool-result') return String(block.toolCallId);
  }
  return undefined;
}

function projectEvent(event: SessionEvent, turnForUser?: number): Record<string, unknown> | undefined {
  switch (event.type) {
    case 'turn/start':
      return { seq: event.seq, time: event.time, type: 'turn_start', turn: event.data.turn };
    case 'turn/end':
      return { seq: event.seq, time: event.time, type: 'turn_end', turn: event.data.turn, reason: event.data.reason };
    case 'user/message':
      return {
        seq: event.seq,
        time: event.time,
        type: 'message',
        role: 'user',
        messageId: String(event.data.id),
        ...(turnForUser === undefined ? {} : { turn: turnForUser }),
        content: publicContent(event.data.content),
      };
    case 'assistant/message':
      return {
        seq: event.seq,
        time: event.time,
        type: 'message',
        role: 'assistant',
        messageId: String(event.data.message.id),
        turn: event.data.turn,
        step: event.data.step,
        content: publicContent(event.data.message.content),
        ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
      };
    case 'tool/call': {
      const args = bounded(event.data.arguments, MAX_ARGUMENT_CHARS);
      return {
        seq: event.seq,
        time: event.time,
        type: 'tool_call',
        turn: event.data.turn,
        step: event.data.step,
        callId: String(event.data.callId),
        name: event.data.name,
        arguments: args.text,
        argumentsTruncated: args.truncated,
      };
    }
    case 'tool/result': {
      const text = bounded(textFromBlocks(event.data.message.content), MAX_ARGUMENT_CHARS);
      return {
        seq: event.seq,
        time: event.time,
        type: 'tool_result',
        turn: event.data.turn,
        step: event.data.step,
        callId: resultCallId(event),
        isError: event.data.error !== undefined
          || event.data.message.content.some((block) => block.type === 'tool-result' && block.isError === true),
        text: text.text,
        textTruncated: text.truncated,
        ...(event.data.error === undefined ? {} : { error: event.data.error }),
      };
    }
    default:
      return undefined;
  }
}

export class RunTracker {
  private readonly records = new Map<string, RunRecord>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly streams = new Map<Agent, LiveAssistantStream>();

  constructor(private readonly agents: () => readonly Agent[]) {}

  register(
    agent: Agent,
    message: UserMessage,
    mode: RunMode,
    startSeq: number,
    clientRequestId?: string,
  ): RunSnapshot {
    const messageId = String(message.id);
    const runId = runIdForMessageId(messageId);
    const existing = this.records.get(runId);
    if (existing !== undefined) return this.snapshot(runId);
    this.records.set(runId, {
      runId,
      agentId: String(agent.id),
      messageId,
      mode,
      ...(clientRequestId === undefined ? {} : { clientRequestId }),
      startSeq,
      submittedAt: Date.now(),
      revision: 0,
      cancellationRequested: false,
      discarded: false,
      disposed: false,
      errors: [],
    });
    return this.snapshot(runId);
  }

  trackExisting(agent: Agent, located: LocatedMessage, mode: RunMode, clientRequestId?: string): RunSnapshot {
    const snapshot = this.register(agent, located.message, mode, located.startSeq, clientRequestId);
    const record = this.records.get(snapshot.runId);
    if (record !== undefined && located.turn !== undefined) record.turn = located.turn;
    return this.snapshot(snapshot.runId);
  }

  forget(runId: string): void {
    this.records.delete(runId);
    this.notify(runId);
  }

  findMessage(agent: Agent, messageId: string): LocatedMessage | undefined {
    return findMessageInAgent(agent, messageId);
  }

  onClaimed(agent: Agent, message: UserMessage, turn: number): void {
    const record = this.records.get(runIdForMessageId(String(message.id)));
    if (record === undefined || record.agentId !== String(agent.id)) return;
    record.turn = turn;
    this.changed(record);
  }

  onDiscarded(agent: Agent, message: UserMessage): void {
    const record = this.records.get(runIdForMessageId(String(message.id)));
    if (record === undefined || record.agentId !== String(agent.id)) return;
    record.discarded = true;
    this.changed(record);
  }

  onSessionEvent(agent: Agent, event: SessionEvent): void {
    for (const record of this.records.values()) {
      if (record.agentId !== String(agent.id)) continue;
      let relevant = record.turn !== undefined && eventTurn(event) === record.turn;
      if (event.type === 'user/message' && String(event.data.id) === record.messageId) relevant = true;
      if (!relevant) continue;
      this.changed(record);
    }
  }

  onAssistantStream(agent: Agent, frame: AssistantStreamFrame): void {
    let stream = this.streams.get(agent);
    if (stream === undefined) { stream = new LiveAssistantStream(); this.streams.set(agent, stream); }
    const turn = frame.type === 'start' ? frame.turn : stream.attempt?.turn;
    if (!stream.accept(frame, agent.session.seq)) return;
    for (const record of this.records.values()) {
      if (record.agentId === String(agent.id) && record.turn === turn) this.changed(record);
    }
  }

  onRequestError(agent: Agent, turn: number, step: number, failure: LlmFailure): void {
    for (const record of this.records.values()) {
      if (record.agentId !== String(agent.id) || record.turn !== turn) continue;
      record.errors.push(failureError(failure, step));
      this.changed(record);
    }
  }

  onAgentError(agent: Agent, turn: number, step: number, error: unknown): void {
    for (const record of this.records.values()) {
      if (record.agentId !== String(agent.id) || record.turn !== turn) continue;
      record.errors.push(unknownError(error, step));
      this.changed(record);
    }
  }

  onDisposed(agent: Agent): void {
    this.streams.delete(agent);
    for (const record of this.records.values()) {
      if (record.agentId !== String(agent.id)) continue;
      record.disposed = true;
      this.changed(record);
    }
  }

  markCancellationRequested(runId: string): void {
    const record = this.requireRecord(runId);
    record.cancellationRequested = true;
    this.changed(record);
  }

  markQueuedCancelled(runId: string): void {
    const record = this.requireRecord(runId);
    record.cancellationRequested = true;
    record.discarded = true;
    this.changed(record);
  }

  resolve(runId: string): { record: Readonly<RunRecord>; agent?: Agent } {
    const record = this.requireRecord(runId);
    return { record, agent: this.agents().find((agent) => String(agent.id) === record.agentId) };
  }

  snapshot(runId: string, afterCursor?: string, maxEvents = DEFAULT_MAX_EVENTS): RunSnapshot {
    const record = this.requireRecord(runId);
    const agent = this.agents().find((candidate) => String(candidate.id) === record.agentId);
    const parsedCursor = cursorParts(afterCursor);
    const events = agent === undefined ? [] : sessionEvents(agent.session);
    const located = agent === undefined ? undefined : findTurnAndSeq(events, record.messageId);
    const turn = record.turn ?? located?.turn;
    if (record.turn === undefined && turn !== undefined) record.turn = turn;
    const pending = agent === undefined ? false : (
      agent.inbox.nextTurn.some((message) => String(message.id) === record.messageId)
      || agent.inbox.nextStep.some((message) => String(message.id) === record.messageId)
    );
    const relevant = events.filter((event) => {
      if (event.seq < record.startSeq) return false;
      if (event.type === 'user/message') return String(event.data.id) === record.messageId;
      return turn !== undefined && eventTurn(event) === turn;
    });
    const turnEnd = turn === undefined
      ? undefined
      : [...relevant].reverse().find((event): event is Extract<SessionEvent, { type: 'turn/end' }> => (
        event.type === 'turn/end' && event.data.turn === turn
      ));
    let status: RunStatus;
    if (turnEnd !== undefined) status = terminalStatus(turnEnd.data.reason);
    else if (record.disposed) status = 'failed';
    else if (record.discarded) status = 'cancelled';
    else if (record.cancellationRequested) status = 'cancelling';
    else if (turn !== undefined) status = 'running';
    else if (pending) status = 'queued';
    else status = agent?.status === 'running' ? 'running' : 'failed';

    let latestTextRaw = '';
    let latestReasoningRaw = '';
    let textDeltaRaw = '';
    let reasoningDeltaRaw = '';
    const afterSeq = parsedCursor?.seq ?? record.startSeq;
    const legacyChunks = relevant.some((event) => event.type === 'assistant/chunk');
    for (const event of relevant) {
      const part = event.type === 'assistant/chunk' ? chunkText(event.data.chunk)
        : !legacyChunks && (event.type === 'assistant/message' || event.type === 'assistant/attempt')
          ? settledText(event.data) : undefined;
      if (part === undefined) continue;
      latestTextRaw += part.text;
      latestReasoningRaw += part.reasoning;
      if (event.seq >= afterSeq) { textDeltaRaw += part.text; reasoningDeltaRaw += part.reasoning; }
    }
    const live = agent === undefined ? undefined : this.streams.get(agent);
    const attempt = live?.attempt;
    // The durable event is appended before the live end frame: exclude the
    // matching transient prefix even in that narrow notification interval.
    if (!legacyChunks && attempt !== undefined && attempt.turn === turn && !relevant.some((event) => (
      (event.type === 'assistant/message' || event.type === 'assistant/attempt')
      && event.seq >= attempt.startSeq && event.data.step === attempt.step
    ))) {
      latestTextRaw += attempt.text;
      latestReasoningRaw += attempt.reasoning;
      textDeltaRaw += attempt.text;
      reasoningDeltaRaw += attempt.reasoning;
    }
    const epoch = live?.epoch ?? 0;
    const outputReset = parsedCursor?.text !== undefined && (
      parsedCursor.epoch !== epoch || parsedCursor.text > latestTextRaw.length
      || (parsedCursor.reasoning ?? 0) > latestReasoningRaw.length
    );
    if (parsedCursor?.text !== undefined) {
      textDeltaRaw = latestTextRaw.slice(outputReset ? 0 : parsedCursor.text);
      reasoningDeltaRaw = latestReasoningRaw.slice(outputReset ? 0 : parsedCursor.reasoning);
    }
    const latestText = bounded(latestTextRaw, MAX_OUTPUT_CHARS);
    const textDelta = bounded(textDeltaRaw, MAX_OUTPUT_CHARS);
    const reasoningDelta = bounded(reasoningDeltaRaw, MAX_OUTPUT_CHARS);
    const projected = relevant
      .filter((event) => event.seq >= afterSeq && event.type !== 'assistant/chunk')
      .map((event) => projectEvent(event, turn))
      .filter((event): event is Record<string, unknown> => event !== undefined);
    const publicEvents = projected.slice(0, maxEvents);
    const toolResults = new Map<string, Extract<SessionEvent, { type: 'tool/result' }>>();
    for (const event of relevant) {
      if (event.type !== 'tool/result') continue;
      const callId = resultCallId(event);
      if (callId !== undefined) toolResults.set(callId, event);
    }
    const toolCalls = relevant
      .filter((event): event is Extract<SessionEvent, { type: 'tool/call' }> => event.type === 'tool/call')
      .map((event) => {
        const callId = String(event.data.callId);
        const result = toolResults.get(callId);
        const argumentsValue = bounded(event.data.arguments, MAX_ARGUMENT_CHARS);
        if (result === undefined) {
          return {
            callId,
            name: event.data.name,
            step: event.data.step,
            status: 'running',
            arguments: argumentsValue.text,
            argumentsTruncated: argumentsValue.truncated,
          };
        }
        const resultText = bounded(textFromBlocks(result.data.message.content), MAX_ARGUMENT_CHARS);
        const failed = result.data.error !== undefined
          || result.data.message.content.some((block) => block.type === 'tool-result' && block.isError === true);
        return {
          callId,
          name: event.data.name,
          step: event.data.step,
          status: failed ? 'failed' : 'completed',
          arguments: argumentsValue.text,
          argumentsTruncated: argumentsValue.truncated,
          resultText: resultText.text,
          resultTruncated: resultText.truncated,
          ...(result.data.error === undefined ? {} : { error: result.data.error }),
        };
      });
    const errors = [...record.errors];
    if (turnEnd?.data.reason.kind === 'error') errors.push(failureError(turnEnd.data.reason.error));
    if (record.disposed && turnEnd === undefined) errors.push({ message: 'Harness 会话已关闭，执行无法继续。', code: 'SESSION_DISPOSED' });
    if (status === 'failed' && errors.length === 0 && turnEnd === undefined) {
      errors.push({ message: '消息既不在队列中，也没有可关联的活动 turn。', code: 'RUN_LOST' });
    }
    const seq = agent?.session.seq ?? parsedCursor?.seq ?? record.startSeq;
    const cursor = `${record.revision}:${seq}:${latestTextRaw.length}:${latestReasoningRaw.length}:${epoch}`;
    return {
      runId: record.runId,
      sessionId: record.agentId,
      messageId: record.messageId,
      mode: record.mode,
      status,
      terminal: isTerminal(status),
      cursor,
      changed: afterCursor === undefined || cursor !== afterCursor,
      submittedAt: record.submittedAt,
      ...(turn === undefined ? {} : { turn }),
      ...(turnEnd === undefined ? {} : { completion: turnEnd.data.reason }),
      latestText: latestText.text,
      textDelta: textDelta.text,
      reasoningDelta: reasoningDelta.text,
      outputReset,
      toolCalls,
      events: publicEvents,
      eventsTruncated: projected.length > publicEvents.length,
      outputTruncated: latestText.truncated || textDelta.truncated || reasoningDelta.truncated,
      errors,
      ...(agent === undefined ? {} : { agentStatus: agent.status }),
    };
  }

  async wait(runId: string, cursor: string | undefined, timeoutMs: number, maxEvents = DEFAULT_MAX_EVENTS): Promise<RunSnapshot & { heartbeat: boolean }> {
    const initial = this.snapshot(runId, cursor, maxEvents);
    if (cursor === undefined || initial.changed || initial.terminal || timeoutMs === 0) {
      return { ...initial, heartbeat: false };
    }
    let timedOut = false;
    await new Promise<void>((resolve) => {
      const waiting = this.waiters.get(runId) ?? new Set<() => void>();
      const finish = (): void => {
        clearTimeout(timer);
        waiting.delete(finish);
        if (waiting.size === 0) this.waiters.delete(runId);
        resolve();
      };
      waiting.add(finish);
      this.waiters.set(runId, waiting);
      const timer = setTimeout(() => {
        timedOut = true;
        finish();
      }, timeoutMs);
      if (this.snapshot(runId).cursor !== cursor) finish();
    });
    const snapshot = this.snapshot(runId, cursor, maxEvents);
    return { ...snapshot, heartbeat: timedOut && !snapshot.changed && !snapshot.terminal };
  }

  readMessages(agent: Agent, afterSeq: number, limit: number): Record<string, unknown> {
    if (afterSeq > agent.session.seq) throw new Error(`cursor 超出当前会话范围：${afterSeq} > ${agent.session.seq}`);
    const projected: Record<string, unknown>[] = [];
    let currentTurn: number | undefined;
    let reachedLimit = false;
    for (const event of sessionEvents(agent.session)) {
      if (event.type === 'turn/start') currentTurn = event.data.turn;
      const item = projectEvent(event, currentTurn);
      if (event.seq >= afterSeq && item !== undefined) {
        if (projected.length < limit) projected.push(item);
        else reachedLimit = true;
      }
      if (event.type === 'turn/end' && currentTurn === event.data.turn) currentTurn = undefined;
    }
    const lastSeq = projected.length === 0
      ? afterSeq - 1
      : projected[projected.length - 1]?.seq;
    const nextCursor = reachedLimit && typeof lastSeq === 'number' ? lastSeq + 1 : agent.session.seq;
    return {
      sessionId: String(agent.id),
      cursor: nextCursor,
      sessionCursor: agent.session.seq,
      hasMore: reachedLimit,
      events: projected,
    };
  }

  dispose(): void {
    for (const waiting of this.waiters.values()) for (const finish of waiting) finish();
    this.waiters.clear();
    this.streams.clear();
  }

  private requireRecord(runId: string): RunRecord {
    const existing = this.records.get(runId);
    if (existing !== undefined) return existing;
    const messageId = messageIdFromRunId(runId);
    if (messageId === undefined) throw new Error(`runId 格式无效：${runId}`);
    for (const agent of this.agents()) {
      const located = findMessageInAgent(agent, messageId);
      if (located === undefined) continue;
      const record: RunRecord = {
        runId,
        agentId: String(agent.id),
        messageId,
        mode: located.mode,
        startSeq: located.startSeq,
        submittedAt: sessionEvents(agent.session)[located.startSeq]?.time ?? agent.session.header.createdAt,
        ...(located.turn === undefined ? {} : { turn: located.turn }),
        revision: 0,
        cancellationRequested: false,
        discarded: false,
        disposed: false,
        errors: [],
      };
      this.records.set(runId, record);
      return record;
    }
    throw new Error(`Harness 执行不存在或所属会话未运行：${runId}`);
  }

  private changed(record: RunRecord): void {
    record.revision += 1;
    this.notify(record.runId);
  }

  private notify(runId: string): void {
    const waiting = this.waiters.get(runId);
    if (waiting === undefined) return;
    for (const finish of [...waiting]) finish();
  }
}
