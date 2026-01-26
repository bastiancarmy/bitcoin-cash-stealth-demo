// packages/cli/src/bch-stealth.ts
//
// Compatibility alias for the CLI.
// Prints a non-fatal deprecation hint, then loads the real CLI entrypoint.

const msg =
  'DEPRECATION: `bch-stealth` is now an alias. Please use `bchctl` going forward.';

try {
  // stderr is typical for warnings; keep it single-line and non-fatal.
  console.error(`[bch-stealth] ${msg}`);
} catch {
  // ignore logging failures
}

// Load the real CLI. It will parse argv and execute as normal.
await import('./index.js');