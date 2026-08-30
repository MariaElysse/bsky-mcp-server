#!/usr/bin/env bash
# workspace-push.sh — Scan for git workspaces/repositories and push each to origin.
#
# Usage:
#   ./src/scripts/workspace-push.sh [OPTIONS] [PATH...]
#
# If PATH is omitted, the script scans the current directory for subdirectories
# that are git repos (including git worktrees).
#
# Options:
#   --dry-run          Preview what would happen without making changes
#   --force            Force-push existing branches
#   --skip-empty       Skip repos with no uncommitted changes (default: true)
#   --no-skip-empty    Do NOT skip empty workspaces
#   --branch-prefix P  Prefix for generated branch names (default: "ws")
#   --commit-message M Custom commit message (default: "workspace push")
#   --verbose          Print detailed git output

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
DRY_RUN=false
FORCE_PUSH=false
SKIP_EMPTY=true
BRANCH_PREFIX="ws"
COMMIT_MSG="workspace push"
VERBOSE=false
TARGETS=()  # positional args; empty means "scan cwd"

# ── Argument parsing ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)       DRY_RUN=true; shift ;;
        --force)         FORCE_PUSH=true; shift ;;
        --skip-empty)    SKIP_EMPTY=true; shift ;;
        --no-skip-empty) SKIP_EMPTY=false; shift ;;
        --branch-prefix) BRANCH_PREFIX="$2"; shift 2 ;;
        --commit-message) COMMIT_MSG="$2"; shift 2 ;;
        --verbose)       VERBOSE=true; shift ;;
        -*)              echo "Unknown option: $1" >&2; exit 1 ;;
        *)               TARGETS+=("$1"); shift ;;
    esac
done

# ── Helpers ─────────────────────────────────────────────────────────────────
log()   { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
info()  { log " INFO: $*"; }
ok()    { log " OK:     $*"; }
warn()  { log " WARN:   $*"; }
err()   { log " ERROR:  $*"; }

# Run a git command inside a directory. Uses cd+subshell to avoid -C issues on Windows.
git_in() {
    local dir="$1"; shift
    (cd "$dir" && if "$VERBOSE"; then git "$@"; else git "$@" >/dev/null 2>&1; fi)
}

# ── Discover repos ─────────────────────────────────────────────────────────
is_repo_root() {
    local dir="$1"
    local cdup
    cdup="$(git -C "$dir" rev-parse --show-cdup 2>/dev/null)" || return 1
    [[ -z "$cdup" ]]
}

discover_repos() {
    local -a repos=()

    if [[ ${#TARGETS[@]} -eq 0 ]]; then
        # Scan current directory for subdirs that are git worktrees/repos.
        while IFS= read -r -d '' entry; do
            [[ -d "$entry" ]] || continue
            if is_repo_root "$entry"; then
                repos+=("$entry")
            fi
        done < <(find . -maxdepth 1 -mindepth 1 -print0 2>/dev/null | sort -z)

        # Also scan inside .worktrees/ for git worktree roots (depth 2)
        if [[ -d "./.worktrees" ]]; then
            while IFS= read -r -d '' entry; do
                [[ -d "$entry" ]] || continue
                if is_repo_root "$entry"; then
                    repos+=("$entry")
                fi
            done < <(find ./.worktrees -maxdepth 1 -mindepth 1 -print0 2>/dev/null | sort -z)
        fi
    else
        for t in "${TARGETS[@]}"; do
            if [[ -d "$t" ]] && is_repo_root "$t"; then
                repos+=("$t")
            fi
        done
    fi

    printf '%s\0' "${repos[@]}"
}

# ── Process a single repo ───────────────────────────────────────────────────
# Returns: 0=success, 2=skipped, 1=error
process_repo() {
    local repo_path="$1"
    local abs_path
    abs_path="$(cd "$repo_path" && pwd)"
    local bname
    bname="$(basename "$abs_path")"
    local branch="${BRANCH_PREFIX}-${bname}"

    info "Processing: $abs_path"

    # ── Check for origin remote ────────────────────────────────────────
    if ! git_in "$abs_path" remote get-url origin >/dev/null 2>&1; then
        err " → No 'origin' remote found. Skipping."
        return 0
    fi

    # ── Check for uncommitted changes ──────────────────────────────────
    if [[ "$SKIP_EMPTY" == true ]]; then
        local has_changes=false
        if ! git_in "$abs_path" diff --quiet HEAD 2>/dev/null; then
            has_changes=true
        fi
        if ! git_in "$abs_path" diff-index --quiet --cached HEAD -- 2>/dev/null; then
            has_changes=true
        fi
        local untracked
        untracked="$(git -C "$abs_path" ls-files --others --exclude-standard 2>/dev/null)" || true
        if [[ -n "$untracked" ]]; then
            has_changes=true
        fi

        if [[ "$has_changes" == false ]]; then
            info " → [SKIPPED-EMPTY] No uncommitted changes."
            return 2
        fi
    fi

    # ── Detect current branch ──────────────────────────────────────────
    local current_branch
    current_branch="$(git -C "$abs_path" rev-parse --abbrev-ref HEAD 2>/dev/null)" || true
    if [[ -z "$current_branch" ]]; then
        current_branch="$branch"
    fi

    # ── Fetch latest refs ──────────────────────────────────────────────
    info " → Fetching origin..."
    if ! git_in "$abs_path" fetch origin 2>&1; then
        err " → Failed to fetch. Skipping."
        return 0
    fi

    # ── Stage all changes ──────────────────────────────────────────────
    info " → Staging all changes..."
    if ! git_in "$abs_path" add . 2>&1; then
        err " → Failed to stage. Skipping."
        return 0
    fi

    # Check again after staging — nothing new to commit?
    local untracked_after
    untracked_after="$(git -C "$abs_path" ls-files --others --exclude-standard 2>/dev/null)" || true
    if ! git_in "$abs_path" diff-index --quiet --cached HEAD -- 2>/dev/null; then
        : # staged changes exist, proceed
    elif [[ -z "$untracked_after" ]]; then
        info " → [SKIPPED-EMPTY] Nothing to commit after staging."
        return 2
    else
        : # untracked files were added, proceed
    fi

    # ── Dry-run mode: report without committing/pushing ────────────────
    if [[ "$DRY_RUN" == true ]]; then
        warn " → [DRY-RUN] Would commit and push to origin/$current_branch"
        info " → Changes staged:"
        (cd "$abs_path" && git diff --cached --stat 2>/dev/null) || true
        return 0
    fi

    # ── Commit ─────────────────────────────────────────────────────────
    info " → Committing..."
    if ! git_in "$abs_path" commit -m "$COMMIT_MSG" 2>&1; then
        err " → Failed to commit (maybe nothing new?). Skipping push."
        return 0
    fi

    # ── Checkout / create branch ───────────────────────────────────────
    info " → Switching to branch '$current_branch'..."
    if ! git_in "$abs_path" checkout -B "$current_branch" 2>&1; then
        err " → Failed to switch branches. Skipping push."
        return 0
    fi

    # ── Push (use subshell to avoid -C path issues on Windows) ─────────
    info " → Pushing to origin/$current_branch..."
    local push_output=""
    if [[ "$FORCE_PUSH" == true ]]; then
        push_output="$(cd "$abs_path" && git push origin "$current_branch" --force 2>&1)" || true
    else
        push_output="$(cd "$abs_path" && git push origin "$current_branch" 2>&1)" || true
    fi

    if [[ -z "$(echo "$push_output" | grep -i 'error\|fatal')" ]]; then
        ok " → [SUCCESS] Pushed to origin/$current_branch"
    else
        # Check for denied/rejected (branch exists without --force)
        if echo "$push_output" | grep -qi "denied\|rejected"; then
            warn " → Branch exists without --force. Retrying with force..."
            push_output="$(cd "$abs_path" && git push origin "$current_branch" --force 2>&1)" || true
            if [[ -z "$(echo "$push_output" | grep -i 'error\|fatal')" ]]; then
                ok " → [SUCCESS] Force-pushed to origin/$current_branch"
            else
                err " → Push failed: $(echo "$push_output" | tail -3)"
                return 0
            fi
        else
            err " → Push failed: $(echo "$push_output" | tail -3)"
            return 0
        fi
    fi

    return 0
}

# ── Main ────────────────────────────────────────────────────────────────────
main() {
    log "═══════════════════════════════════════════"
    log "workspace-push.sh — starting"
    log "  dry-run:      $DRY_RUN"
    log "  force-push:   $FORCE_PUSH"
    log "  skip-empty:   $SKIP_EMPTY"
    log "  branch-prefix:$BRANCH_PREFIX"
    log "  commit-msg:   '$COMMIT_MSG'"
    log "═══════════════════════════════════════════"

    local -a repos=()
    while IFS= read -r -d '' repo; do
        [[ -n "$repo" ]] && repos+=("$repo")
    done < <(discover_repos)

    if [[ ${#repos[@]} -eq 0 ]]; then
        warn "No git repositories found."
        exit 1
    fi

    info "Found ${#repos[@]} repository/ies to process."

    local success=0
    local skipped=0
    local errors=0

    for repo in "${repos[@]}"; do
        # Capture output and exit code separately
        local tmpfile
        tmpfile="$(mktemp)"
        set +e
        process_repo "$repo" >"$tmpfile" 2>&1
        local rc=$?
        set -e

        cat "$tmpfile"
        rm -f "$tmpfile"

        case $rc in
            0) ((success++)) || true ;;
            2) ((skipped++)) || true ;;
            *) ((errors++)) || true ;;
        esac
    done

    log ""
    log "═══════════════════════════════════════════"
    log "Summary: ${#repos[@]} repos processed"
    log "  SUCCESS: $success"
    log "  SKIPPED: $skipped"
    log "  ERRORS:  $errors"
    log "═══════════════════════════════════════════"

    if [[ $errors -gt 0 ]]; then
        exit 1
    fi
}

main "$@"
