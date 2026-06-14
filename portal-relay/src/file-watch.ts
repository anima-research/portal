/**
 * A JSON file with hot-reload. Uses fs.watchFile (mtime polling) rather than
 * fs.watch — robust against editors that save via atomic rename (which breaks
 * a path-based fs.watch). Self-writes are suppressed so the store's own
 * persist() doesn't trigger a reload of what it just wrote.
 */
import { readFileSync, writeFileSync, watchFile, unwatchFile } from 'node:fs';

export class WatchedFile {
  private suppressUntilMs = 0;

  constructor(
    private path: string,
    private onReload: () => void,
    private intervalMs = 1000,
  ) {}

  start(): void {
    watchFile(this.path, { interval: this.intervalMs }, (curr) => {
      if (curr.mtimeMs <= this.suppressUntilMs) return; // our own write
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

  /** Write + suppress the next watch tick so we don't reload our own change. */
  write(data: string): void {
    this.suppressUntilMs = Date.now() + this.intervalMs * 2;
    writeFileSync(this.path, data);
  }
}
