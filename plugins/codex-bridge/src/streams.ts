import type { StreamChunk } from '@deepseek-ai/dsh-llm';

// Structural types keep the bridge buildable with the released older SDK.
export type AssistantStreamFrame = {
  type: 'start'; attemptId: string; revision: number; turn: number; step: number;
} | {
  type: 'chunk'; attemptId: string; revision: number; index: number; time: number; chunk: StreamChunk;
} | {
  type: 'end'; attemptId: string; revision: number; index: number;
  outcome: { kind: 'committed'; eventType: 'assistant/message' | 'assistant/attempt'; seq: number } | { kind: 'abandoned' };
};

export interface StreamText { text: string; reasoning: string }

export function chunkText(chunk: StreamChunk): StreamText {
  return {
    text: chunk.type === 'text-delta' ? chunk.text : '',
    reasoning: chunk.type === 'reasoning-delta' ? chunk.text : '',
  };
}

/** Read V3 compact records without losing the text of failed/retried attempts. */
export function settledText(data: { stream?: unknown; message?: { content: readonly unknown[] } }): StreamText {
  let text = '';
  let reasoning = '';
  if (Array.isArray(data.stream)) {
    for (const record of data.stream) {
      if (record.type === 'text-chunks') text += record.texts.join('');
      else if (record.type === 'reasoning-chunks') reasoning += record.texts.join('');
      else if (record.type === 'chunk') {
        const part = chunkText(record.chunk);
        text += part.text;
        reasoning += part.reasoning;
      }
    }
  }
  if (!Array.isArray(data.stream) || (!text && !reasoning)) {
    for (const value of data.message?.content ?? []) {
      const block = value as { type?: string; text?: string };
      if (block.type === 'text') text += block.text ?? '';
      else if (block.type === 'reasoning') reasoning += block.text ?? '';
    }
  }
  return { text, reasoning };
}

export class LiveAssistantStream {
  attempt?: { id: string; turn: number; step: number; startSeq: number; nextIndex: number; text: string; reasoning: string };
  revision = 0;
  epoch = 0;

  accept(frame: AssistantStreamFrame, sessionSeq: number): boolean {
    if (frame.revision <= this.revision) return false;
    this.revision = frame.revision;
    if (frame.type === 'start') {
      if (this.attempt) this.epoch++;
      this.attempt = { id: frame.attemptId, turn: frame.turn, step: frame.step, startSeq: sessionSeq, nextIndex: 0, text: '', reasoning: '' };
      return true;
    }
    const attempt = this.attempt;
    if (!attempt || attempt.id !== frame.attemptId) return false;
    if (frame.type === 'end') {
      if (frame.outcome.kind === 'abandoned') this.epoch++;
      this.attempt = undefined;
      return true;
    }
    if (frame.index < attempt.nextIndex) return false;
    // A local listener normally receives every frame. On a gap, publish an
    // explicit reset; final settlement will recover the authoritative stream.
    if (frame.index !== attempt.nextIndex) this.epoch++;
    attempt.nextIndex = frame.index + 1;
    const part = chunkText(frame.chunk);
    attempt.text += part.text;
    attempt.reasoning += part.reasoning;
    return true;
  }
}
