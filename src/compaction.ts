import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Message } from '@deepseek-ai/dsh-llm';

const textOf = (message: Message) => message.content.flatMap(block =>
  block.type === 'text' ? [block.text] : block.type === 'tool-call' ? [`${block.name}: ${block.arguments}`] : []).join('\n');
const excerpt = (text: string, bytes: number) => {
  const encoded = Buffer.from(text);
  return encoded.length <= bytes ? text : encoded.subarray(0, bytes).toString('utf8').replace(/\uFFFD$/, '') + ' […]';
};
const requestLabel = 'User request in this region: ';
const excerptsLabel = 'Recent source excerpts:\n';
const checkpointBlock = (message: Message, label: string) => message.source.kind === 'compact-checkpoint'
  ? message.content.flatMap(block => block.type === 'text' && block.text.startsWith(label)
    ? [block.text.slice(label.length)] : []).at(0) : undefined;

// DSH owns region selection, retention, replacement and overflow recovery.
// Saved results are durable: a bounded extractive checkpoint needs no LLM call.
export default class ResearchCompaction extends BasicCompactionEngine {
  protected override async summarize(input: { messages: readonly Message[] }, agent: Agent, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const target = agent.session.requestHeader()!.config;
    const history = input.messages.filter(message => message.role !== 'system');
    const request = history.toReversed().map(message => message.role === 'user' && message.source.kind === 'user'
      ? textOf(message) : checkpointBlock(message, requestLabel)).find(text => text !== undefined);
    const references = [...new Set(history.toReversed().flatMap(message =>
      textOf(message).match(/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/g) ?? []))].slice(0, 32);
    let remaining = Math.min(3000, Math.floor(history.reduce((n, message) => n + Buffer.byteLength(textOf(message)), 0) / 3));
    const excerpts: string[] = [];
    for (const message of history.toReversed()) {
      if (remaining < 100 || message.source.kind === 'user') continue;
      const body = checkpointBlock(message, excerptsLabel) ?? (message.role === 'user' ? '' : textOf(message));
      if (!body.trim()) continue;
      const line = `${message.role}: ${excerpt(body, Math.min(1000, remaining - 32))}`;
      excerpts.push(line);
      remaining -= Buffer.byteLength(line) + 1;
    }
    return { provider: target.provider, model: target.model,
      summary: [
        'Extracted history, not new observations. Saved SQL/results can be read by evidence ID; excerpts may be incomplete. Continue from the later messages.',
        request ? requestLabel + excerpt(request, 2300) : '',
        `Saved evidence references: ${references.join(', ')}`,
        excerpts.length ? excerptsLabel + excerpts.toReversed().join('\n') : '',
      ].filter(Boolean).map(text => ({ type: 'text' as const, text })) };
  }
}
