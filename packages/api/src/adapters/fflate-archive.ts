import { zipSync } from 'fflate';

import type { ArchiveBuilder, ArchiveEntry, ArchiveResult } from '@athlya/members';

/**
 * Build an {@link ArchiveBuilder} backed by `fflate`'s `zipSync`.
 *
 * Entries are drained from the async iterable one at a time (serial,
 * not parallel) before being passed to `zipSync`. This means at most
 * one collection's bytes are held alongside the growing `files` map
 * during the drain phase; once `zipSync` runs its output replaces all
 * individual entry buffers in a single allocation.
 *
 * `level: 0` (store without deflate) is used because the payloads are
 * already UTF-8 JSON / CSV — deflate buys little and costs CPU budget
 * on the Worker. Switch to `level: 6` if the archive size matters more
 * than the CPU time.
 */
export function createFflateArchiveBuilder(): ArchiveBuilder {
  return {
    async build(entries: AsyncIterable<ArchiveEntry>): Promise<ArchiveResult> {
      const files: Record<string, Uint8Array> = {};
      for await (const entry of entries) {
        files[entry.name] = entry.bytes;
      }
      const bytes = zipSync(files, { level: 0 });
      return { bytes, sizeBytes: bytes.byteLength };
    },
  };
}
