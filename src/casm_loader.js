// src/casm_loader.js
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function cwdBaseUrl() {
  // Ensure trailing slash so URL resolution treats it like a directory
  return pathToFileURL(process.cwd() + '/').href;
}

function fallbackBaseUrl() {
  // CJS runtime: __filename exists
  // eslint-disable-next-line no-undef
  if (typeof __filename !== 'undefined') return pathToFileURL(__filename).href;

  // ESM runtime (but we intentionally avoid import.meta here)
  return cwdBaseUrl();
}

/**
 * Load a .casm file as UTF-8 text.
 *
 * @param {string} baseUrl - A file: URL string pointing at the *caller module file* (recommended),
 *                          or a directory file: URL (also ok). If falsy/invalid, we fallback.
 * @param {string} relativePath - e.g. './cashassembly/pool_hash_fold_v0.casm'
 */
export async function loadCasm(baseUrl, relativePath) {
  const base =
    typeof baseUrl === 'string' && baseUrl.startsWith('file:')
      ? baseUrl
      : fallbackBaseUrl();

  // 1) Try relative to the calling module (dist or src)
  const primaryUrl = new URL(relativePath, base);

  try {
    return await fs.readFile(primaryUrl, 'utf8');
  } catch (e) {
    // 2) Fallback: load from repo-root src/..., so dist tests still work
    // './cashassembly/x.casm' -> 'src/cashassembly/x.casm'
    const rel = String(relativePath).replace(/^\.\//, '');
    const fallbackUrl = new URL(`src/${rel}`, cwdBaseUrl());
    return await fs.readFile(fallbackUrl, 'utf8');
  }
}