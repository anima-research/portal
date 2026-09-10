/**
 * Wake sinks — where an addressed portal message goes when it should wake the
 * agent behind this server.
 *
 * Claude Code has a native channel push (`notifications/claude/channel`), which
 * is the default. Codex has no push at all — but `codex queue --thread <id>
 * --message <text>` injects a user turn into a RUNNING TUI session, so a codex
 * hand can be woken from inside its own portal MCP server. That is exactly where
 * the relay already delivers the persona's mentions and replies, guild-wide
 * (relay.ts deliverMessage: addressed ⇒ dispatched regardless of subscription),
 * so no launcher has to shadow-subscribe channels to wake it.
 *
 * Selected by PORTAL_WAKE:
 *   (unset) → Claude Code channel notification (unchanged behaviour)
 *   codex   → CodexQueueSink, driven by a sidecar file (PORTAL_WAKE_FILE, default
 *             <state dir>/<personaId>.wake.json) written by whoever launched
 *             codex once it knows the thread id:
 *               { "codexBin": "/abs/path/to/codex", "threadId": "<uuid>" }
 *             The sidecar is re-read on every wake: the thread id only exists
 *             after codex boots, and a revival may write a new one.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface WakePayload {
  content: string;
  meta: Record<string, string>;
}

export interface WakeSink {
  readonly kind: string;
  deliver(payload: WakePayload): Promise<void>;
}

export interface CodexWakeTarget {
  codexBin: string;
  threadId: string;
}

/** A wake is context, not a transcript — keep it bounded. Tail-preserving,
 *  because the trigger (the message addressed to us) is rendered last. */
export const CODEX_WAKE_MAX_CHARS = 12_000;
/** The launcher writes the sidecar right after it discovers the thread id; a
 *  mention can beat that by a few seconds. Wait, don't drop. */
export const SIDECAR_WAIT_MS = 90_000;
const SIDECAR_POLL_MS = 2_000;

type Exec = (bin: string, args: string[]) => Promise<unknown>;
type Sleep = (ms: number) => Promise<void>;

export class CodexQueueSink implements WakeSink {
  readonly kind = 'codex';

  constructor(
    readonly file: string,
    private readonly exec: Exec = async (bin, args) => run(bin, args),
    private readonly sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async deliver(payload: WakePayload): Promise<void> {
    const target = await this.waitForTarget();
    await this.exec(target.codexBin, ['queue', '--thread', target.threadId, '--message', renderCodexWake(payload)]);
  }

  private async waitForTarget(): Promise<CodexWakeTarget> {
    const deadline = this.now() + SIDECAR_WAIT_MS;
    for (;;) {
      const target = readCodexWakeTarget(this.file);
      if (target) return target;
      if (this.now() >= deadline) {
        throw new Error(`no codex wake target at ${this.file} — is the launcher writing it?`);
      }
      await this.sleep(SIDECAR_POLL_MS);
    }
  }
}

/** Parse the sidecar; anything short of a complete target reads as "not yet"
 *  (a half-written file is retried, not fatal). */
export function readCodexWakeTarget(file: string): CodexWakeTarget | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<CodexWakeTarget>;
    if (typeof j.codexBin === 'string' && j.codexBin && typeof j.threadId === 'string' && j.threadId) {
      return { codexBin: j.codexBin, threadId: j.threadId };
    }
  } catch {
    /* partial write or garbage → treat as absent */
  }
  return undefined;
}

/** One header line so the hand knows this is a portal delivery (not its
 *  operator typing), then the same folded context Claude Code would get. */
export function renderCodexWake({ content, meta }: WakePayload): string {
  const where = meta.threadId
    ? `thread ${meta.threadId} (channel ${meta.channelId})`
    : `channel ${meta.channelId}`;
  const replyHint = meta.threadId
    ? `send_message(channelId ${meta.channelId}, threadId ${meta.threadId})`
    : `send_message(channelId ${meta.channelId})`;
  const head = meta.catchup
    ? '[portal] Messages addressed to you arrived while you were away — reply where each came from with send_message.'
    : `[portal] ${meta.author} addressed you in ${where} — reply there with ${replyHint}.`;
  const body =
    content.length > CODEX_WAKE_MAX_CHARS
      ? `[${content.length - CODEX_WAKE_MAX_CHARS} chars of earlier context omitted — use fetch_history]\n` +
        content.slice(-CODEX_WAKE_MAX_CHARS)
      : content;
  return `${head}\n${body}`;
}

export function wakeSinkFromEnv(
  env: NodeJS.ProcessEnv,
  defaults: { stateDir: string; personaId: string },
): WakeSink | undefined {
  const mode = (env.PORTAL_WAKE ?? '').trim();
  if (!mode) return undefined;
  if (mode === 'codex') {
    return new CodexQueueSink(env.PORTAL_WAKE_FILE ?? join(defaults.stateDir, `${defaults.personaId}.wake.json`));
  }
  throw new Error(`PORTAL_WAKE=${mode} is not a wake sink I know (expected "codex" or unset)`);
}
