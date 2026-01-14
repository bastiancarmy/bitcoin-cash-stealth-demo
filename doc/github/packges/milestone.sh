export OWNER="bastiancarmy"
export REPO="bitcoin-cash-stealth-demo"

gh api -X POST "repos/$OWNER/$REPO/milestones" \
  -f title="Monorepo Build Completion — @bch-stealth/* normalization" \
  -f state="open" \
  -f description=$'Normalize workspace packages to @bch-stealth/* and get the full monorepo building cleanly in dependency order.\n\nScope:\n- Standardize package names + workspace dependency specifiers + source imports (remove @bch/* references)\n- Ensure electrum builds and exports a stable API\n- Ensure rpa-derive/rpa-scan/rpa umbrella build cleanly\n- Ensure pool-hash-fold builds cleanly\n- Implement pool-shards core scaffolding functions (remove “not implemented” paths)\n- Formalize demo-state storage contract\n- Get demo-cli sharded pool flow running end-to-end\n\nExit criteria:\n- `yarn install` succeeds\n- root `yarn build` succeeds\n- root `yarn typecheck` succeeds'