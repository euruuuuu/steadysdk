#!/usr/bin/env bash
# The steps of the steadysdk GitHub Action (action.yml), kept in a script so they can be run and tested
# outside GitHub. Inputs arrive as environment variables:
#   STEADYSDK_CLI                path of the built CLI (packages/cli/dist/index.js)
#   INPUT_WORKING_DIRECTORY      where to run (the config is searched from there upwards)
#   INPUT_CONFIG                 explicit config file
#   INPUT_CHECK                  true: fail when the committed SDK is out of date
#   INPUT_BASE                   git revision to compare the spec against (default: PR base / previous commit)
#   INPUT_REQUIRE_BUMP           true: fail on breaking changes without a new major info.version
#   INPUT_FAIL_ON_BREAKING       true: fail on any breaking change
#   INPUT_SUMMARY                true: write results and the changelog to $GITHUB_STEP_SUMMARY
#   GITHUB_EVENT_NAME, GITHUB_BASE_REF, GITHUB_EVENT_BEFORE, GITHUB_STEP_SUMMARY, GITHUB_OUTPUT (from GitHub)
set -uo pipefail

steadysdk() { node "${STEADYSDK_CLI:?STEADYSDK_CLI must point at the built CLI}" "$@"; }

cd "${INPUT_WORKING_DIRECTORY:-.}" || exit 1
config=()
[[ -n "${INPUT_CONFIG:-}" ]] && config=(--config "$INPUT_CONFIG")
summary=/dev/null
[[ "${INPUT_SUMMARY:-true}" == true && -n "${GITHUB_STEP_SUMMARY:-}" ]] && summary="$GITHUB_STEP_SUMMARY"
outputs="${GITHUB_OUTPUT:-/dev/null}"
failed=0

echo "## steadysdk" >> "$summary"

# 1. The committed SDK must be exactly what the spec and config produce.
if [[ "${INPUT_CHECK:-true}" == true ]]; then
  echo "::group::steadysdk generate --check"
  if steadysdk generate --check ${config[@]+"${config[@]}"}; then
    echo "- ✅ The generated SDK is up to date with the spec." >> "$summary"
  else
    failed=1
    echo "- ❌ The generated SDK is out of date: run \`steadysdk generate\` and commit the result." >> "$summary"
  fi
  echo "::endgroup::"
fi

# 2. API changes since the base revision: the pull request's target branch, or the commit before a push.
base="${INPUT_BASE:-}"
if [[ -z "$base" ]]; then
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request | pull_request_target) [[ -n "${GITHUB_BASE_REF:-}" ]] && base="origin/$GITHUB_BASE_REF" ;;
    push) [[ -n "${GITHUB_EVENT_BEFORE:-}" && ! "$GITHUB_EVENT_BEFORE" =~ ^0+$ ]] && base="$GITHUB_EVENT_BEFORE" ;;
  esac
fi

if [[ -z "$base" ]]; then
  echo "- No base revision to compare the API against (not a pull request or a push), so no changelog." >> "$summary"
else
  # Shallow checkouts (the actions/checkout default) do not have the base yet: fetch just that commit.
  if ! git rev-parse --verify --quiet "$base^{commit}" > /dev/null; then
    if [[ "$base" == origin/* ]]; then
      git fetch --no-tags --depth=1 origin "+refs/heads/${base#origin/}:refs/remotes/$base"
    else
      git fetch --no-tags --depth=1 origin "$base"
    fi
  fi

  gate=()
  [[ "${INPUT_REQUIRE_BUMP:-true}" == true ]] && gate+=(--require-bump)
  [[ "${INPUT_FAIL_ON_BREAKING:-false}" == true ]] && gate+=(--fail-on-breaking)
  echo "::group::steadysdk diff --base $base ${gate[*]-}"
  log="$(mktemp)"
  # No colors: the failure lines are copied into the summary.
  steadysdk diff --base "$base" --no-color ${config[@]+"${config[@]}"} ${gate[@]+"${gate[@]}"} 2> "$log"
  status=$?
  cat "$log" >&2
  echo "::endgroup::"
  if [[ $status -ne 0 ]]; then
    failed=1
    while IFS= read -r line; do echo "- ❌ ${line#✖ }" >> "$summary"; done < <(grep '^✖' "$log")
  fi

  changes="$(mktemp)"
  if steadysdk changelog --base "$base" ${config[@]+"${config[@]}"} --json --out "$changes" > /dev/null 2>&1; then
    node -e '
      const { summary } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      console.log(`breaking=${summary.breaking}\nnon-breaking=${summary.nonBreaking}`);
    ' "$changes" >> "$outputs"
    { echo; steadysdk changelog --base "$base" ${config[@]+"${config[@]}"} 2> /dev/null; } >> "$summary"
  fi
fi

exit "$failed"
