import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

/**
 * Watches a changing set of files. It watches their directories rather than the files themselves:
 * many editors save by writing a new file and renaming it over the old one, which a file watch misses.
 */
export class FileWatcher {
  private readonly onChange: (file: string) => void;
  private readonly watchers = new Map<string, FSWatcher>();
  private files = new Set<string>();

  constructor(onChange: (file: string) => void) {
    this.onChange = onChange;
  }

  get size(): number {
    return this.files.size;
  }

  /** Replaces the watched files. Directories that cannot be watched (yet) are retried on the next call. */
  set(files: Iterable<string>): void {
    this.files = new Set([...files].map((file) => path.resolve(file)));
    const directories = new Set([...this.files].map((file) => path.dirname(file)));
    for (const [directory, watcher] of this.watchers) {
      if (directories.has(directory)) continue;
      watcher.close();
      this.watchers.delete(directory);
    }
    for (const directory of directories) {
      if (this.watchers.has(directory)) continue;
      try {
        const watcher = watch(directory, (_event, name) => {
          // Some platforms omit the name; then any change in the directory counts.
          const file = name === null ? undefined : path.join(directory, name.toString());
          if (file === undefined || this.files.has(file)) this.onChange(file ?? directory);
        });
        watcher.on('error', () => this.watchers.delete(directory));
        this.watchers.set(directory, watcher);
      } catch {
        // The directory does not exist right now.
      }
    }
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}
