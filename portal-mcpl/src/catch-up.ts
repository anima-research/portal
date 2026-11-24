import type { AgentState, PendingPing } from './agent-state.js';

export const SHOWN_BEFORE = ' (shown before)';

export function catchUpHead(newCount: number, shownBeforeCount: number): string {
  if (shownBeforeCount === 0) return `[catch-up] ${newCount} message(s) addressed to you while you were away`;
  if (newCount === 0) {
    return (
      '[catch-up] nothing new was addressed to you while you were away. ' +
      `${shownBeforeCount} message(s) shown to an earlier session are still pending`
    );
  }
  return (
    `[catch-up] ${newCount} message(s) addressed to you while you were away, ` +
    `and ${shownBeforeCount} shown to an earlier session and still pending`
  );
}

export function forgetShownNotPending(state: AgentState, shownBeforeRead: string[], pending: PendingPing[]): void {
  const stillPending = new Set(pending.map((p) => p.message.id));
  state.forgetShown(shownBeforeRead.filter((id) => !stillPending.has(id)));
}
