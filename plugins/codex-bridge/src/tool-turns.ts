import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm';

const OWNER = '@dfy-plugins/dsh-codex-bridge/tool-turn';
interface Pending {
  agent: Agent;
  message: UserMessage;
  turn?: number;
  run(signal: AbortSignal): Promise<unknown>;
  resolve(result: unknown): void;
  reject(error: unknown): void;
  result?: { value: unknown } | { error: unknown };
  stop(): void;
}

/** Use the real Agent driver to own approval/PTC audit boundaries, without an LLM request. */
export class ToolTurns {
  private readonly pending = new Map<string, Pending>();
  private readonly emptyTurns = new Map<Agent, number>();
  private disposed = false;

  constructor(ctx: Context) {
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const pending = this.pending.get(String(message.id));
      if (pending?.agent === agent) pending.turn = turn;
    });
    ctx.on('agent/error', ({ agent, turn, error }) => {
      for (const pending of this.pending.values()) {
        if (pending.agent === agent && pending.turn === turn && pending.result === undefined) pending.result = { error };
      }
    });
    ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
      const controls = messages.filter((message) => message.source.kind === 'plugin' && message.source.plugin === OWNER);
      if (controls.length === 0) return next();
      for (const message of controls) {
        const pending = this.pending.get(String(message.id));
        if (pending?.agent === agent) pending.turn = turn;
      }
      let decision;
      try { decision = await next(); } // Preserve guards and other admission vetoes.
      catch (error) {
        for (const message of controls) {
          const pending = this.pending.get(String(message.id));
          if (pending?.agent === agent) pending.result = { error };
        }
        throw error;
      }
      for (const message of controls) {
        const pending = this.pending.get(String(message.id));
        if (pending?.agent !== agent) continue; // Never replay an orphaned request after restart.
        pending.turn = turn;
        if (decision.kind === 'reject') pending.result = { error: new Error('Harness 拒绝了工具调用轮次') };
        else {
          try { pending.result = { value: await pending.run(signal) }; }
          catch (error) { pending.result = { error }; }
        }
      }
      if (decision.kind === 'reject') return decision;
      // With only a control message the loop closes a real, empty-model turn.
      // Simultaneously claimed steering is preserved and may enter its normal step.
      if (messages.every((message) => controls.includes(message))) {
        this.emptyTurns.set(agent, turn);
        return { ...decision, messages: [] };
      }
      const ids = new Set(controls.map((message) => String(message.id)));
      return { ...decision, messages: decision.messages.filter((message) => !ids.has(String(message.id))) };
    }, { prepend: true });
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return;
      for (const [agent, turn] of this.emptyTurns) {
        if (agent.session !== session || turn !== event.data.turn) continue;
        this.emptyTurns.delete(agent);
        // DSH stops its driver after an empty first step, even with queued work.
        // Wake through the public inbox after it has fully retired. The control
        // notice is filtered above; other queued/steering input keeps its order.
        if (event.data.reason.kind === 'completed') void agent.whenIdle().then(() => {
          if (this.disposed || agent.status !== 'idle' || (!agent.inbox.nextTurn.length && !agent.inbox.nextStep.length)) return;
          agent.steer(createUserMessage({ content: [{ type: 'text', text: '继续处理桥接轮次后的待处理输入。' }], source: { kind: 'plugin', plugin: OWNER } }));
        }).catch(() => {});
      }
      for (const pending of this.pending.values()) {
        if (pending.agent.session !== session || pending.turn !== event.data.turn) continue;
        const result = pending.result;
        if (result && 'value' in result) pending.resolve(result.value);
        else pending.reject(result && 'error' in result ? result.error : new Error('工具调用轮次未完成'));
      }
    });
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const pending = this.pending.get(String(message.id));
      if (pending?.agent === agent) pending.reject(new Error('工具调用已从队列取消'));
    });
    ctx.on('agent/disposed', ({ agent }) => {
      for (const pending of this.pending.values()) if (pending.agent === agent) pending.reject(new Error('Harness 会话已关闭'));
    });
  }

  execute(agent: Agent, toolName: string, run: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('Codex 桥接已停止'));
    signal.throwIfAborted();
    const message = createUserMessage({
      content: [{ type: 'text', text: `Codex 请求直接调用工具：${toolName}（由桥接执行，无需模型回复）。` }],
      source: { kind: 'plugin', plugin: OWNER, form: 'notice', summary: `Codex 工具调用：${toolName}` },
    });
    const id = String(message.id);
    return new Promise((resolve, reject) => {
      const cancel = new AbortController();
      const finish = (settle: () => void): void => {
        if (!this.pending.delete(id)) return;
        signal.removeEventListener('abort', aborted);
        cancel.abort(new Error('桥接调用已结束'));
        settle();
      };
      const aborted = (): void => {
        const pending = this.pending.get(id);
        if (pending?.turn === undefined) agent.inbox.remove(MessageId(id));
        finish(() => reject(signal.reason));
      };
      this.pending.set(id, {
        agent, message,
        run: (turnSignal) => run(AbortSignal.any([turnSignal, signal, cancel.signal])),
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
        stop: () => { if (this.pending.get(id)?.turn === undefined) agent.inbox.remove(MessageId(id)); finish(() => reject(new Error('Codex 桥接已停止'))); },
      });
      signal.addEventListener('abort', aborted, { once: true });
      try { agent.followup(message); }
      catch (error) { finish(() => reject(error)); }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.emptyTurns.clear();
    for (const pending of [...this.pending.values()]) pending.stop();
  }
}
