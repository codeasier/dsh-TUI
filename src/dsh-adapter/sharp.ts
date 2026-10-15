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
 * outcome so TUI consumers share one instance. Sixel workers receive the
 * selected entry explicitly: their JS caches are separate, but libvips is
 * process-wide. A missing module resolves to `undefined`; callers keep their
 * fallback.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { isMainThread, workerData } from 'node:worker_threads'

export type SharpModule = Awaited<typeof import('sharp')>['default']

let loader: Promise<SharpModule | undefined> | undefined
let selectedPath: string | undefined

/** Workers have separate module caches but share the process's native libraries. */
export async function loadSharpWorkerData(): Promise<{ dshTuiSharpPath: string | null }> {
  await loadSharp()
  return { dshTuiSharpPath: selectedPath ?? null }
}

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
  const inherited: unknown = workerData
  if (!isMainThread && inherited !== null && typeof inherited === 'object'
    && 'dshTuiSharpPath' in inherited) {
    // Never fall back to another native build after the parent chose one.
    // null also propagates the parent's optional-dependency degradation.
    return typeof inherited.dshTuiSharpPath === 'string'
      ? importSharp(inherited.dshTuiSharpPath)
      : undefined
  }
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
      selectedPath = entry.filename
      return candidate as SharpModule
    }
  }
  for (const path of sharpCandidatePaths()) {
    const sharp = await importSharp(path)
    if (sharp !== undefined) return sharp
  }
  return undefined
}

async function importSharp(path: string): Promise<SharpModule | undefined> {
  try {
    const mod = await import(pathToFileURL(path).href) as { default?: unknown }
    const candidate = mod.default ?? mod
    if (typeof candidate === 'function') {
      selectedPath = path
      return candidate as SharpModule
    }
  } catch {
    // Callers decide whether another tree is safe to try.
  }
  return undefined
}
