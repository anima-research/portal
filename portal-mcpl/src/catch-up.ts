import type { AgentState, PendingPing } from './agent-state.js';
import type { PortalAgent } from './agent.js';

export const SENT_BEFORE = ' (sent before)';

export function catchUpHead(newCount: number, sentBeforeCount: number): string {
  if (sentBeforeCount === 0) return `[catch-up] ${newCount} message(s) addressed to you while you were away`;
  if (newCount === 0) {
    return (
      '[catch-up] nothing new was addressed to you while you were away. ' +
      `${sentBeforeCount} message(s) sent to you before are still pending`
    );
  }
  return (
    `[catch-up] ${newCount} message(s) addressed to you while you were away, ` +
    `and ${sentBeforeCount} sent to you before and still pending`
  );
}

export function clearingNotes(anySentBefore: boolean): string[] {
  return [
    ...(anySentBefore ? ['[a mention marked (sent before) may already have an answer]'] : []),
    '[to clear a mention, reply with send_message and its id as replyToId, where the relay supports it, or mark_read its channel]',
  ];
}

export function forgetSentNotPending(state: AgentState, sentBeforeRead: string[], pending: PendingPing[]): void {
  const stillPending = new Set(pending.map((p) => p.message.id));
  state.forgetSent(sentBeforeRead.filter((id) => !stillPending.has(id)));
}

export function noteSentAndPrune(agent: PortalAgent, messageId: string): void {
  const sentBeforeRead = agent.state.sentIds();
  agent.state.noteSent([messageId]);
  agent.pendingPingsFromRelay().then(
    (pending) => forgetSentNotPending(agent.state, sentBeforeRead, pending),
    () => {},
  );
}

export function messageMark(messageId: string): string {
  return ` [message ${messageId}]`;
}
