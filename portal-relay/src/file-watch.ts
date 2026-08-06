/**
 * A JSON file with hot-reload. Uses fs.watchFile (mtime polling) rather than
 * fs.watch — robust against editors that save via atomic rename (which breaks
 * a path-based fs.watch). Self-writes are suppressed BY CONTENT IDENTITY, not
 * by time window: the old `suppressUntilMs` window discarded EVERY change for
 * 2s after any self-write — including other writers' — so a store persisting
 * at machine rate (mint_invite) could silently disable hot-reload of the very
 * file an operator hand-edits to revoke a code. Content identity is race-free:
 * a change event only skips reload when the file still holds exactly what we
 * last wrote.
 */
import { readFileSync, writeFileSync, watchFile, unwatchFile } from 'node:fs';

export class WatchedFile {
  private lastWritten?: string;

  constructor(
    private path: string,
    private onReload: () => void,
    private intervalMs = 1000,
  ) {}

  start(): void {
    watchFile(this.path, { interval: this.intervalMs }, () => {
      try {
        if (this.lastWritten !== undefined && this.read() === this.lastWritten) {
          return; // our own write (or a byte-identical external one — no-op either way)
        }
      } catch {
        /* unreadable mid-rename — fall through and let onReload's error path report */
      }
      try {
        this.onReload();
      } catch (err) {
        console.error(`[portal-relay] reload of ${this.path} failed:`, (err as Error).message);
      }
    });
  }

  stop(): void {
    unwatchFile(this.path);
  }

  read(): string {
    return readFileSync(this.path, 'utf8');
  }

  /** Write + remember the content so the next watch tick can recognize the
   *  self-write by identity instead of discarding a time window. */
  write(data: string): void {
    this.lastWritten = data;
    writeFileSync(this.path, data);
  }
}
