export const MIN_MODEL_STEPS = 4;
export const MAX_MODEL_STEPS = 200;
export const MIN_TOOL_CALLS = 8;
export const MAX_TOOL_CALLS = 500;
export const MIN_DURATION_MINUTES = 1;
export const MAX_DURATION_MINUTES = 180;
export const MIN_REPEAT_LIMIT = 2;
export const MAX_REPEAT_LIMIT = 20;

export interface TurnGuardSettings {
  enabled: boolean;
  behaviorGuidance: boolean;
  hardStop: boolean;
  warningStep: number;
  maxModelSteps: number;
  maxToolCalls: number;
  maxDurationMinutes: number;
  repeatedCallLimit: number;
  repeatedFailureLimit: number;
}

export const DEFAULT_TURN_GUARD_SETTINGS: TurnGuardSettings = {
  enabled: true,
  behaviorGuidance: true,
  hardStop: true,
  warningStep: 12,
  maxModelSteps: 20,
  maxToolCalls: 50,
  maxDurationMinutes: 15,
  repeatedCallLimit: 3,
  repeatedFailureLimit: 3,
};

export type GuardLimitKind = 'steps' | 'tools' | 'duration' | 'repeated-call' | 'repeated-failure';

export interface GuardLimit {
  kind: GuardLimitKind;
  reason: string;
}

export interface TurnState {
  turn: number;
  startedAt: number;
  modelSteps: number;
  lastStep: number | undefined;
  toolCalls: number;
  lastToolSignature: string | undefined;
  repeatedCallStreak: number;
  lastFailureFingerprint: string | undefined;
  repeatedFailureStreak: number;
  behaviorGuidanceSent: boolean;
  reminderSent: boolean;
  warnedLimits: Set<GuardLimitKind>;
  finalizingLimit: GuardLimit | undefined;
  finalizationStep: number | undefined;
  stopped: boolean;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeTurnGuardSettings(value: Partial<TurnGuardSettings> | undefined): TurnGuardSettings {
  const maxModelSteps = boundedInteger(
    value?.maxModelSteps,
    DEFAULT_TURN_GUARD_SETTINGS.maxModelSteps,
    MIN_MODEL_STEPS,
    MAX_MODEL_STEPS,
  );
  return {
    enabled: value?.enabled ?? DEFAULT_TURN_GUARD_SETTINGS.enabled,
    behaviorGuidance: value?.behaviorGuidance ?? DEFAULT_TURN_GUARD_SETTINGS.behaviorGuidance,
    hardStop: value?.hardStop ?? DEFAULT_TURN_GUARD_SETTINGS.hardStop,
    warningStep: Math.min(
      maxModelSteps - 1,
      boundedInteger(value?.warningStep, DEFAULT_TURN_GUARD_SETTINGS.warningStep, 2, MAX_MODEL_STEPS - 1),
    ),
    maxModelSteps,
    maxToolCalls: boundedInteger(
      value?.maxToolCalls,
      DEFAULT_TURN_GUARD_SETTINGS.maxToolCalls,
      MIN_TOOL_CALLS,
      MAX_TOOL_CALLS,
    ),
    maxDurationMinutes: boundedInteger(
      value?.maxDurationMinutes,
      DEFAULT_TURN_GUARD_SETTINGS.maxDurationMinutes,
      MIN_DURATION_MINUTES,
      MAX_DURATION_MINUTES,
    ),
    repeatedCallLimit: boundedInteger(
      value?.repeatedCallLimit,
      DEFAULT_TURN_GUARD_SETTINGS.repeatedCallLimit,
      MIN_REPEAT_LIMIT,
      MAX_REPEAT_LIMIT,
    ),
    repeatedFailureLimit: boundedInteger(
      value?.repeatedFailureLimit,
      DEFAULT_TURN_GUARD_SETTINGS.repeatedFailureLimit,
      MIN_REPEAT_LIMIT,
      MAX_REPEAT_LIMIT,
    ),
  };
}

export function createTurnState(turn: number, now: number): TurnState {
  return {
    turn,
    startedAt: now,
    modelSteps: 0,
    lastStep: undefined,
    toolCalls: 0,
    lastToolSignature: undefined,
    repeatedCallStreak: 0,
    lastFailureFingerprint: undefined,
    repeatedFailureStreak: 0,
    behaviorGuidanceSent: false,
    reminderSent: false,
    warnedLimits: new Set(),
    finalizingLimit: undefined,
    finalizationStep: undefined,
    stopped: false,
  };
}

export function ensureTurnState(state: TurnState | undefined, turn: number, now: number): TurnState {
  return state?.turn === turn ? state : createTurnState(turn, now);
}

export function registerModelStep(state: TurnState, step: number): void {
  if (state.lastStep === step) return;
  state.lastStep = step;
  state.modelSteps += 1;
}

function stableValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item, seen)]));
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function canonicalToolSignature(name: string, args: unknown): string {
  const serialized = JSON.stringify(stableValue(args, new WeakSet())) ?? String(args);
  return `${name}:${shortHash(serialized)}`;
}

export function registerToolCall(state: TurnState, signature: string): void {
  state.toolCalls += 1;
  if (state.lastToolSignature === signature) state.repeatedCallStreak += 1;
  else {
    state.lastToolSignature = signature;
    state.repeatedCallStreak = 1;
  }
}

export function failureFingerprint(code: string | undefined, message: string): string {
  const normalized = message
    .replace(/\u001b\[[0-9;]*m/gu, '')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}[t ][\d:.+-]+z?\b/giu, '<time>')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
  return `${code ?? 'error'}:${shortHash(normalized)}`;
}

export function toolFailureFingerprint(
  name: string,
  args: unknown,
  code: string | undefined,
  message: string,
): string {
  return `${canonicalToolSignature(name, args)}:${failureFingerprint(code, message)}`;
}

export function registerToolResult(state: TurnState, fingerprint: string | undefined): void {
  if (fingerprint === undefined) {
    state.lastFailureFingerprint = undefined;
    state.repeatedFailureStreak = 0;
    return;
  }
  if (state.lastFailureFingerprint === fingerprint) state.repeatedFailureStreak += 1;
  else {
    state.lastFailureFingerprint = fingerprint;
    state.repeatedFailureStreak = 1;
  }
}

export function currentHardLimit(
  state: TurnState,
  settings: TurnGuardSettings,
  now: number,
): GuardLimit | undefined {
  if (state.modelSteps > settings.maxModelSteps) {
    return { kind: 'steps', reason: `模型步数已超过 ${String(settings.maxModelSteps)} 步` };
  }
  if (state.toolCalls > settings.maxToolCalls) {
    return { kind: 'tools', reason: `工具调用已超过 ${String(settings.maxToolCalls)} 次` };
  }
  if (now - state.startedAt > settings.maxDurationMinutes * 60_000) {
    return { kind: 'duration', reason: `单轮运行已超过 ${String(settings.maxDurationMinutes)} 分钟` };
  }
  if (state.repeatedCallStreak >= settings.repeatedCallLimit) {
    return { kind: 'repeated-call', reason: `相同工具与参数已连续出现 ${String(state.repeatedCallStreak)} 次` };
  }
  if (state.repeatedFailureStreak >= settings.repeatedFailureLimit) {
    return { kind: 'repeated-failure', reason: `相同工具错误已连续出现 ${String(state.repeatedFailureStreak)} 次` };
  }
  return undefined;
}

export function takeConvergenceReminder(
  state: TurnState,
  settings: TurnGuardSettings,
  now: number,
): string | undefined {
  if (state.reminderSent) return undefined;
  const toolWarningAt = Math.min(6, Math.max(4, Math.floor(settings.maxToolCalls * 0.7)));
  const timeWarningAt = settings.maxDurationMinutes * 60_000 * 0.7;
  if (state.modelSteps < settings.warningStep
    && state.toolCalls < toolWarningAt
    && now - state.startedAt < timeWarningAt) return undefined;
  state.reminderSent = true;
  return [
    '任务守卫检查点：当前回合已进行多次模型或工具步骤。',
    '现在只选择一种动作：直接完成；进行一次会改变决定的关键调用；采用一次实质不同的恢复方案；说明阻塞或询问一个必要问题。',
    '只有能明确说出“缺少哪项事实或状态、结果将如何改变下一步”时才可继续调用工具。失败、超时、空结果和未实际读取的来源都不算证据。',
    '若最近两次调用没有减少不确定性、推进目标状态或验证结果，立即停止工具调用；下一次输出必须直接面向用户，不得继续猜测、反复比较或在内部补全结论。',
  ].join('');
}

export function takeBehaviorGuidance(
  state: TurnState,
  settings: TurnGuardSettings,
): string | undefined {
  if (!settings.behaviorGuidance || state.behaviorGuidanceSent) return undefined;
  state.behaviorGuidanceSent = true;
  return [
    '<task-execution-contract>',
    '范围：只处理用户当前明确要求的结果；同一回合内，最新补充和纠正覆盖冲突的旧信息、假设与计划。用户提供的专名、路径、数字、代码和搜索词必须原样传给工具，不得擅自替换。',
    '能力选择：先判断用户要求的动作，再选择工具或技能。附件、文件类型、链接、界面元素和可用能力只是上下文，不能单独触发技能或扩大任务范围。',
    '完成定义：行动前在内部确定可观察的完成条件与最小验证方式。一次调用必须至少做到一件事：减少关键不确定性、推进所需状态，或验证结果；不得仅为了继续工作而调用工具。',
    '结果判定：每次调用后只做一个决定——继续、以实质不同的方案恢复、完成，或说明阻塞。继续前必须指出仍缺少的事实或状态，以及下一次结果将怎样改变决定。',
    '证据门槛：外部事实必须能在成功工具结果的实际内容中定位。失败、超时、空结果、未打开的页面、搜索排名或标题、模型记忆都不是已验证证据，不能据此引用或补写细节。名称、别名、身份和因果关系同样必须验证，不能因相似而合并。',
    '假设控制：发现事实与当前假设冲突时立即作废该假设。需要比较多个解释、实现或候选时，使用同一组决定性约束检查支持与冲突证据，不得只为当前偏好的答案寻找佐证。',
    '最终门槛：回答前把关键结论区分为已验证、合理推断或未知。决定性结论若仍只属于推断或未知，禁止写成确定事实；应明确不确定性，或只询问一个能够解除阻塞的必要问题。',
    '停止规则：连续两次调用没有减少不确定性、推进目标状态或验证结果，或者现有能力无法取得关键证据时，停止调用工具。一旦停止，下一次输出必须直接面向用户；不得继续内部猜测、反复比较、重述计划或强行选择答案。',
    '完成规则：完成条件一旦满足就立即交付，不为追求额外确定性、更多材料或形式上的收尾继续调用工具。简单问题直接简洁回答，不附加无意义的“任务完成”说明。',
    '工具纪律：严格遵守工具名称、参数、资源类型与调用层级；URL、本地路径、命令和资源不得混用。工具失败后先判断原因，最多采用一次确有不同且符合契约的恢复路线，禁止用近义参数重复同一路线。',
    '用户沟通：工具前最多给一句有信息量的简短说明。不要展示内部推理、自我争辩、未验证的候选清单或逐步排除过程；先取得结果，再报告结论、证据边界与必要的下一步。',
    '</task-execution-contract>',
  ].join('\n');
}

export function takeLimitWarning(state: TurnState, limit: GuardLimit): string | undefined {
  if (state.warnedLimits.has(limit.kind)) return undefined;
  state.warnedLimits.add(limit.kind);
  return `任务守卫已检测到：${limit.reason}。请停止当前路线，直接报告已验证结果、证据边界和阻塞点。`;
}

export function beginFinalization(state: TurnState, limit: GuardLimit): boolean {
  if (state.finalizingLimit !== undefined) return false;
  state.finalizingLimit = limit;
  return true;
}

export function claimFinalizationStep(state: TurnState, step: number): boolean {
  if (state.finalizingLimit === undefined || state.stopped) return false;
  if (state.finalizationStep === undefined) {
    state.finalizationStep = step;
    return true;
  }
  return state.finalizationStep === step;
}

export function finalizationMessage(limit: GuardLimit): string {
  return [
    `任务守卫已停止继续调用工具：${limit.reason}。`,
    '请立即用一条简短的用户可见回复说明已验证结果、未完成部分和可行下一步。',
    '这是本轮唯一的收尾步骤；不要调用工具、继续内部推演、伪造完成或添加形式化的“任务完成”结语。',
  ].join('');
}
