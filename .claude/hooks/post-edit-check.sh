#!/usr/bin/env bash
#
# Post-edit gate: format, typecheck, lint.
#
# It FAILS LOUDLY and names the rule violated. It deliberately does NOT fix
# anything: `prettier --check`, never `--write`. A silent fix leaves the agent
# generating the wrong pattern forever, while a loud failure teaches the rule
# after one violation.
#
# Exit 2 tells Claude Code to feed stderr back to the model and block.

set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Only react to edits of files we actually check.
FILE="${CLAUDE_TOOL_FILE_PATH:-}"
case "$FILE" in
  *.ts|*.tsx|*.mjs|*.json|*.css|"") ;;
  *) exit 0 ;;
esac

[ -d node_modules ] || exit 0

fail=0
report() {
  printf '\n\033[1;31m✗ %s\033[0m\n%s\n' "$1" "$2" >&2
  fail=1
}

# ---------------------------------------------------------------- formatting
if ! out=$(npx --no-install prettier --check . 2>&1); then
  report "FORMATTING — prettier" "$(printf '%s\n' "$out" | grep -v '^Checking formatting' | head -20)
Rule: this repo is prettier-formatted (.prettierrc: single quotes, semicolons,
100 columns, trailing commas).
Fix it yourself with:  npm run format:write
Not auto-fixed on purpose — you should write it formatted the first time."
fi

# ---------------------------------------------------------------- types
if ! out=$(npx --no-install tsc --noEmit 2>&1); then
  report "TYPES — tsc --noEmit (strict)" "$(printf '%s\n' "$out" | head -20)
Rule: TypeScript strict, with noUncheckedIndexedAccess. Indexing an array or
Record yields 'T | undefined' — handle it or assert with '!' where a database
constraint already guarantees the row."
fi

# ---------------------------------------------------------------- lint
if ! out=$(npx --no-install eslint . 2>&1); then
  report "LINT — eslint" "$(printf '%s\n' "$out" | head -20)
Rule: see eslint.config.mjs. Unused variables must be prefixed with '_'."
fi

if [ "$fail" -ne 0 ]; then
  printf '\n\033[1;31mPost-edit check failed. Fix the violation above before continuing.\033[0m\n' >&2
  printf 'Run `npm run check` to see the full output.\n' >&2
  exit 2
fi

exit 0
