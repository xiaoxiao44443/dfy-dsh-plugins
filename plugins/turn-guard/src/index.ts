/** @dfy-plugins/dsh-turn-guard Host half: convergence guard for long-running turns. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import {
  beginFinalization,
  canonicalToolSignature,
  claimFinalizationStep,
  createTurnState,
  currentHardLimit,
  ensureTurnState,
  finalizationMessage,
  normalizeTurnGuardSettings,
  registerModelStep,
  registerToolCall,
  registerToolResult,
  takeBehaviorGuidance,
  takeConvergenceReminder,
  takeLimitWarning,
  toolFailureFingerprint,
  type GuardLimit,
  type TurnGuardSettings,
  type TurnState,
} from './logic.js';

export const name = 'turn-guard';
export const inject = ['settings', 'tools'];

export interface Config extends Partial<TurnGuardSettings> {}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  behaviorGuidance: z.boolean().default(true),
  hardStop: z.boolean().default(true),
  warningStep: z.number().step(1).min(2).max(199).default(12),
  maxModelSteps: z.number().step(1).min(4).max(200).default(20),
  maxToolCalls: z.number().step(1).min(8).max(500).default(50),
  maxDurationMinutes: z.number().step(1).min(1).max(180).default(15),
  repeatedCallLimit: z.number().step(1).min(2).max(20).default(3),
  repeatedFailureLimit: z.number().step(1).min(2).max(20).default(3),
});

const SETTINGS_NS = 'dsh-turn-guard' as SettingsNamespace;
const PLUGIN_ID = '@dfy-plugins/dsh-turn-guard';

function guardMessage(text: string, summary = '任务守卫建议当前回合收敛') {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_ID,
      form: 'notice',
      summary,
    },
  });
}

function injectReminder(agent: Agent, text: string | undefined): void {
  if (text !== undefined) agent.inject(guardMessage(text));
}

export function apply(ctx: Context, entryConfig: Config): void {
  const scope = ctx.settings.register(SETTINGS_NS, Config, { base: entryConfig });
  let settings = normalizeTurnGuardSettings(scope.get());
  scope.watch((next) => { settings = normalizeTurnGuardSettings(next); });
  const states = new Map<string, TurnState>();

  const stateFor = (agent: Agent, turn: number, now = Date.now()): TurnState => {
    const id = String(agent.id);
    const state = ensureTurnState(states.get(id), turn, now);
    states.set(id, state);
    return state;
  };

  const stopForLimit = (agent: Agent, state: TurnState, limit: GuardLimit): void => {
    if (state.stopped) return;
    if (!settings.hardStop) {
      injectReminder(agent, takeLimitWarning(state, limit));
      return;
    }
    state.stopped = true;
    agent.cancel({ kind: 'hook', reason: `任务守卫：${limit.reason}` }, { keepInbox: true });
  };

  const startFinalization = (state: TurnState, limit: GuardLimit): void => {
    beginFinalization(state, limit);
  };

  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    if (!settings.enabled) return next();
    const state = stateFor(payload.agent, payload.turn);
    registerModelStep(state, payload.step);
    const behaviorGuidance = takeBehaviorGuidance(state, settings);
    const behaviorMessage = behaviorGuidance === undefined
      ? []
      : [guardMessage(behaviorGuidance, '任务守卫约束当前回合行为')];
    if (state.finalizingLimit !== undefined && settings.hardStop) {
      if (!claimFinalizationStep(state, payload.step)) {
        stopForLimit(payload.agent, state, state.finalizingLimit);
        return { kind: 'reject' };
      }
      const decision = await next();
      if (decision.kind !== 'enter') return decision;
      return {
        kind: 'enter',
        messages: [...behaviorMessage, guardMessage(finalizationMessage(state.finalizingLimit)), ...decision.messages],
      };
    }
    const hardLimit = currentHardLimit(state, settings, Date.now());
    if (hardLimit !== undefined && settings.hardStop) {
      startFinalization(state, hardLimit);
      claimFinalizationStep(state, payload.step);
      const decision = await next();
      if (decision.kind !== 'enter') return decision;
      return {
        kind: 'enter',
        messages: [...behaviorMessage, guardMessage(finalizationMessage(hardLimit)), ...decision.messages],
      };
    }
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const hardWarning = hardLimit === undefined ? undefined : takeLimitWarning(state, hardLimit);
    const reminder = hardWarning ?? takeConvergenceReminder(state, settings, Date.now());
    const reminderMessages = reminder === undefined ? [] : [guardMessage(reminder)];
    if (behaviorMessage.length === 0 && reminderMessages.length === 0) return decision;
    return { kind: 'enter', messages: [...behaviorMessage, ...reminderMessages, ...decision.messages] };
  });

  ctx.on('tools/pre-execute', async (execution, next) => {
    if (!settings.enabled || execution.agent === undefined || execution.parent !== undefined) return next();
    const state = states.get(String(execution.agent.id)) ?? createTurnState(0, Date.now());
    states.set(String(execution.agent.id), state);
    if (state.finalizingLimit !== undefined && settings.hardStop) {
      return {
        kind: 'deny',
        reason: `任务守卫处于收尾阶段：${state.finalizingLimit.reason}。请直接向用户说明情况，不要继续调用工具。`,
      };
    }
    registerToolCall(state, canonicalToolSignature(execution.name, execution.arguments));
    const hardLimit = currentHardLimit(state, settings, Date.now());
    if (hardLimit !== undefined && settings.hardStop) {
      startFinalization(state, hardLimit);
      return {
        kind: 'deny',
        reason: `任务守卫已停止继续调用工具：${hardLimit.reason}。请在下一步直接向用户说明情况。`,
      };
    }
    if (hardLimit !== undefined) injectReminder(execution.agent, takeLimitWarning(state, hardLimit));
    else injectReminder(execution.agent, takeConvergenceReminder(state, settings, Date.now()));
    return next();
  });

  ctx.on('tools/result', (execution: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    if (!settings.enabled || execution.agent === undefined || execution.parent !== undefined) return;
    const state = states.get(String(execution.agent.id));
    if (state === undefined) return;
    registerToolResult(
      state,
      result.isError
        ? toolFailureFingerprint(
          execution.name,
          execution.arguments,
          result.error.info?.code,
          result.error.message,
        )
        : undefined,
    );
    const hardLimit = currentHardLimit(state, settings, Date.now());
    if (hardLimit !== undefined) {
      if (settings.hardStop) startFinalization(state, hardLimit);
      else stopForLimit(execution.agent, state, hardLimit);
    }
  });

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const state = states.get(String(agent.id));
    if (state?.turn === turn) states.delete(String(agent.id));
  });

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(String(agent.id));
  });
}
