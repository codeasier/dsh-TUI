/**
 * Host-first `sharp` loader.
 *
 * dsh-tui runs inside the dsh process, and the host attachment service
 * (`@deepseek-ai/dsh-attachment-local`) loads its own `sharp` on demand. Loading
 * a second copy from this package's optional dependency puts two libvips
 * dylibs into one process; on macOS the Objective-C runtime reports the
 * duplicate classes on stderr, and that text lands on the alternate screen.
 *
 * Reuse an already-loaded sharp factory when available, otherwise resolve
 * from the host tree first and fall back to our own optional copy. Cache the
 * outcome so TUI consumers share one instance. A missing module resolves to
 * `undefined`; callers keep their fallback.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export type SharpModule = Awaited<typeof import('sharp')>['default']

let loader: Promise<SharpModule | undefined> | undefined

/** Share an already-loaded or host-preferred `sharp` with every TUI consumer. */
export function loadSharp(): Promise<SharpModule | undefined> {
  loader ??= resolveSharp()
  return loader
}

/**
 * Candidate `sharp` entry files, host first. The host anchor is a blessed
 * upstream package: profile installs alias `@deepseek-ai/*` to the running
 * dsh, so resolving `sharp` from that location walks the host's tree.
 */
export function sharpCandidatePaths(): string[] {
  const local = createRequire(import.meta.url)
  const paths: string[] = []
  try {
    const anchor = local.resolve('@deepseek-ai/dsh-session/package.json')
    paths.push(createRequire(anchor).resolve('sharp'))
  } catch {
    // The host tree has no sharp (or no dsh-session); use our own copy.
  }
  try {
    paths.push(local.resolve('sharp'))
  } catch {
    // Optional dependency not installed.
  }
  return [...new Set(paths)]
}

async function resolveSharp(): Promise<SharpModule | undefined> {
  // The attachment service uses createRequire, so its successful factory is
  // visible here even when a source checkout resolves a different dev tree.
  // Check the factory API, not a hard-coded sharp version or entry filename.
  for (const entry of Object.values(createRequire(import.meta.url).cache)) {
    if (entry?.loaded !== true) continue
    const candidate: unknown = entry.exports
    if (typeof candidate !== 'function') continue
    const factory = candidate as {
      versions?: { sharp?: unknown; vips?: unknown }
      cache?: unknown
      concurrency?: unknown
    }
    if (typeof factory.versions?.sharp === 'string'
      && typeof factory.versions.vips === 'string'
      && typeof factory.cache === 'function'
      && typeof factory.concurrency === 'function') {
      return candidate as SharpModule
    }
  }
  for (const path of sharpCandidatePaths()) {
    try {
      const mod = await import(pathToFileURL(path).href) as { default?: unknown }
      const candidate = mod.default ?? mod
      if (typeof candidate === 'function') return candidate as SharpModule
    } catch {
      // A broken native build in one tree must not hide a working one.
    }
  }
  return undefined
}
