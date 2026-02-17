export OWNER="bastiancarmy"
export REPO="bitcoin-cash-stealth-demo"
export LABELS="refactor"
export MILESTONE="Monorepo Build Completion — @bch-stealth/* normalization"


gh issue create --repo "$OWNER/$REPO" \
  --title "TKT-A1 — Standardize package scopes + workspace deps (global)" \
  --body-file "TKT-A1.md" \
  --label "$LABELS" \
  --milestone "$MILESTONE"

gh issue create --repo "$OWNER/$REPO" \
  --title "TKT-A2 — Electrum package builds clean + exports stable API" \
  --body-file "TKT-A2.md" \
  --label "$LABELS" \
  --milestone "$MILESTONE"

gh issue create --repo "$OWNER/$REPO" \
  --title "TKT-A3 — RPA Derivation package build + types" \
  --body-file "TKT-A3.md" \
  --label "$LABELS" \
  --milestone "$MILESTONE"

gh issue create --repo "$OWNER/$REPO" \
  --title "TKT-A4 — RPA Scan package build + stable inputs/outputs" \
  --body-file "TKT-A4.md" \
  --label "$LABELS" \
  --milestone "$MILESTONE"

gh issue create --repo "$OWNER/$REPO" \
  --title "TKT-A5 — RPA umbrella package exports derive + scan" \
  --body-file "TKT-A5.md" \
  --label "$LABELS" \
  --milestone "$MILESTONE"

gh issue create --repo "$OWNER/$REPO" \
  --title "TKT-A6 — Pool Hash-Fold package scope/deps + build verification" \
  --body-file "TKT-A6.md" \
  --label "$LABELS" \
  --milestone "$MILESTONE"

gh issue create --repo "$OWNER/$REPO" \
  --title "TKT-A7 — Pool Shards: implement scaffolding functions" \
  --body-file "TKT-A7.md" \
  --label "$LABELS" \
  --milestone "$MILESTONE"

gh issue create --repo "$OWNER/$REPO" \
  --title "TKT-A8 — Demo State package: formalize storage contract used by demo + shards" \
  --body-file "TKT-A8.md" \
  --label "$LABELS" \
  --milestone "$MILESTONE"

gh issue create --repo "$OWNER/$REPO" \
  --title "TKT-A9 — Demo CLI: get demo_sharded_pool running end-to-end" \
  --body-file "TKT-A9.md" \
  --label "$LABELS" \
  --milestone "$MILESTONE"