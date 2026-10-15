# shellcheck shell=bash
# Shared helpers for update.sh — keep host volume paths and .env across git pull.
# Sourced, not executed. Callers should enable `set -euo pipefail`.

horde_env_quote() {
  local v="$1"
  if [[ "$v" =~ [^A-Za-z0-9_./:@+-] ]]; then
    v="${v//\\/\\\\}"
    v="${v//\"/\\\"}"
    printf '"%s"' "$v"
  else
    printf '%s' "$v"
  fi
}

# Print the last assignment of KEY in a dotenv-style file (empty if missing).
horde_env_get() {
  local file="$1"
  local key="$2"
  local line stripped k v found=""
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    stripped="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$stripped" || "$stripped" == \#* ]] && continue
    if [[ "$stripped" =~ ^export[[:space:]]+ ]]; then
      stripped="${stripped#export}"
      stripped="${stripped#"${stripped%%[![:space:]]*}"}"
    fi
    k="${stripped%%=*}"
    k="${k%"${k##*[![:space:]]}"}"
    [[ "$k" == "$key" ]] || continue
    v="${stripped#*=}"
    v="${v#"${v%%[![:space:]]*}"}"
    if [[ "$v" == \"*\" ]]; then
      v="${v#\"}"
      v="${v%\"}"
      v="${v//\\\"/\"}"
      v="${v//\\\\/\\}"
    elif [[ "$v" == \'*\' ]]; then
      v="${v#\'}"
      v="${v%\'}"
    fi
    found="$v"
  done < "$file"
  printf '%s' "$found"
  return 0
}

# Replace or append KEY=value. Empty VALUE is ignored (does not clear).
horde_env_upsert() {
  local file="$1"
  local key="$2"
  local value="$3"
  local quoted tmp line stripped k found=0 dir
  [[ -n "$value" ]] || return 0
  quoted="$(horde_env_quote "$value")"
  dir="$(dirname "$file")"
  mkdir -p "$dir"
  if [[ ! -f "$file" ]]; then
    printf '# Horde host configuration — volume paths here survive git pull / rebuilds.\n%s=%s\n' \
      "$key" "$quoted" > "$file"
    return 0
  fi
  tmp="${file}.tmp.$$"
  : > "$tmp"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    stripped="${line#"${line%%[![:space:]]*}"}"
    k=""
    if [[ -n "$stripped" && "$stripped" != \#* ]]; then
      if [[ "$stripped" =~ ^export[[:space:]]+ ]]; then
        stripped="${stripped#export}"
        stripped="${stripped#"${stripped%%[![:space:]]*}"}"
      fi
      k="${stripped%%=*}"
      k="${k%"${k##*[![:space:]]}"}"
    fi
    if [[ "$k" == "$key" ]]; then
      if [[ "$found" -eq 0 ]]; then
        printf '%s=%s\n' "$key" "$quoted" >> "$tmp"
        found=1
      fi
      continue
    fi
    printf '%s\n' "$line" >> "$tmp"
  done < "$file"
  if [[ "$found" -eq 0 ]]; then
    printf '%s=%s\n' "$key" "$quoted" >> "$tmp"
  fi
  mv "$tmp" "$file"
}

horde_env_set_if_missing() {
  local file="$1"
  local key="$2"
  local value="$3"
  local current
  current="$(horde_env_get "$file" "$key")"
  if [[ -n "$current" ]]; then
    return 0
  fi
  horde_env_upsert "$file" "$key" "$value"
}

horde_normalize_path() {
  local p="$1"
  [[ -n "$p" ]] || return 0
  while [[ "$p" != / && "$p" == */ ]]; do
    p="${p%/}"
  done
  if command -v realpath >/dev/null 2>&1 && [[ -e "$p" ]]; then
    realpath "$p"
    return 0
  fi
  printf '%s' "$p"
}

horde_paths_equal() {
  local a b
  a="$(horde_normalize_path "$1")"
  b="$(horde_normalize_path "$2")"
  [[ -n "$a" && "$a" == "$b" ]]
}

# Mounts file lines: /container/path=/host/path
horde_mount_source() {
  local mounts_file="$1"
  local dest="$2"
  local line d s
  [[ -f "$mounts_file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -n "$line" ]] || continue
    d="${line%%=*}"
    s="${line#*=}"
    if [[ "$d" == "$dest" ]]; then
      printf '%s' "$s"
      return 0
    fi
  done < "$mounts_file"
  return 0
}

# Copy live DOWNLOADS_PATH / DATA_PATH / PUID / PGID / OLLAMA_DATA_PATH into .env.
horde_seed_env_from_snapshot() {
  local envfile="$1"
  local snap="$2"
  local key val
  for key in DOWNLOADS_PATH DATA_PATH PUID PGID OLLAMA_DATA_PATH; do
    val="$(horde_env_get "$snap" "$key")"
    if [[ -n "$val" ]]; then
      horde_env_upsert "$envfile" "$key" "$val"
    fi
  done
}

# Return 0 if recreating is safe; 1 if a live mount would move.
horde_guard_volume_paths() {
  local live_dl="$1"
  local live_data="$2"
  local plan_dl="$3"
  local plan_data="$4"
  local failed=0
  if [[ -n "$live_dl" && -n "$plan_dl" ]] && ! horde_paths_equal "$live_dl" "$plan_dl"; then
    echo "DOWNLOADS_PATH would change: ${live_dl} -> ${plan_dl}" >&2
    failed=1
  fi
  if [[ -n "$live_data" && -n "$plan_data" ]] && ! horde_paths_equal "$live_data" "$plan_data"; then
    echo "DATA_PATH would change: ${live_data} -> ${plan_data}" >&2
    failed=1
  fi
  return "$failed"
}

# Read `docker compose config` JSON (preferred) or YAML text from stdin.
# Prints dest=source lines for Horde bind mounts (and Ollama data if present).
horde_extract_horde_bind_mounts() {
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  local parser
  parser="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/parse_compose_mounts.py"
  python3 "$parser"
}

HORDE_COMPOSE_FILES=(docker-compose.yml docker-compose.yaml compose.yml compose.yaml)

# Print tracked compose files that have local modifications (one per line).
horde_dirty_compose_files() {
  local f
  for f in "${HORDE_COMPOSE_FILES[@]}"; do
    if git ls-files --error-unmatch "$f" >/dev/null 2>&1 \
      && ! git diff --quiet HEAD -- "$f"; then
      printf '%s\n' "$f"
    fi
  done
}

# Update the checkout with fetch + `merge --ff-only`. Never stashes, never
# merges, never rewrites history, never discards .env (gitignored), and so
# never leaves conflict markers behind.
#
# A locally modified compose file is backed up to BACKUP_DIR (default
# .local/update-backups/manual-<ts>) and the update STOPS with instructions,
# unless HORDE_DISCARD_COMPOSE_EDITS=1, which restores the committed file after
# the backup (host paths live in .env, so nothing is lost).
# Other locally modified files are fine as long as the incoming change does not
# touch them; otherwise git refuses the fast-forward and nothing changes.
horde_git_pull() {
  local backup_dir="${1:-}" branch dirty f
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" == "HEAD" ]]; then
    echo "Refusing to update on a detached HEAD. Checkout main (or your branch) first." >&2
    return 1
  fi
  if ! git remote get-url origin >/dev/null 2>&1; then
    echo "This checkout has no 'origin' remote, so there is nothing to pull from." >&2
    echo "Re-clone with: git clone https://github.com/jm-connell/horde.git" >&2
    return 1
  fi

  dirty="$(horde_dirty_compose_files)"
  if [[ -n "$dirty" ]]; then
    [[ -n "$backup_dir" ]] || backup_dir=".local/update-backups/manual-$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$backup_dir"
    while IFS= read -r f; do
      cp -p "$f" "$backup_dir/$f.local-edit"
      echo "Backed up your edited $f to $backup_dir/$f.local-edit" >&2
    done <<<"$dirty"
    if [[ "${HORDE_DISCARD_COMPOSE_EDITS:-}" == "1" ]]; then
      while IFS= read -r f; do
        git checkout HEAD -- "$f"
        echo "HORDE_DISCARD_COMPOSE_EDITS=1: restored the committed $f." >&2
      done <<<"$dirty"
      echo "Host paths come from .env; re-apply other tweaks in docker-compose.override.yml (gitignored)." >&2
    else
      {
        echo
        echo "Stopping: you have local edits in: $(tr '\n' ' ' <<<"$dirty")"
        echo "Horde will not stash or merge them (that can leave conflict markers in the compose file)."
        echo "Your copy is saved in ${backup_dir}/."
        echo "Host volume paths belong in .env (already seeded from the running container)."
        echo "Put other tweaks in docker-compose.override.yml (gitignored), then either:"
        echo "  git checkout -- $(tr '\n' ' ' <<<"$dirty")  # drop the edits, then re-run update.sh"
        echo "  HORDE_DISCARD_COMPOSE_EDITS=1 bash update.sh   # same, in one step"
      } >&2
      return 1
    fi
  fi

  echo "Fetching latest code (preserving .env and host volume paths)..."
  if ! git fetch origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"; then
    echo "git fetch failed. Check network access to GitHub. Nothing was changed." >&2
    return 1
  fi
  if ! git merge --ff-only "refs/remotes/origin/${branch}"; then
    {
      echo
      echo "Cannot fast-forward '${branch}' to origin/${branch}. Nothing was changed."
      echo "Either you have local commits or edits that overlap the incoming change."
      echo "Inspect with: git status && git log --oneline origin/${branch}..HEAD"
    } >&2
    return 1
  fi
  return 0
}

# Print the version to bake into the image: the nearest v* tag with the number of
# commits since it (e.g. 1.2.0-5-gabc1234) or "dev" when the clone has no tags.
horde_version_string() {
  local described
  described="$(git describe --tags --match 'v[0-9]*' 2>/dev/null || true)"
  if [[ -z "$described" ]]; then
    printf 'dev'
    return 0
  fi
  printf '%s' "${described#v}"
}

# Keep the newest KEEP entries of DIR (timestamped names sort chronologically).
horde_prune_backups() {
  local dir="$1" keep="${2:-5}" entry count=0 i
  local -a entries=()
  [[ -d "$dir" ]] || return 0
  [[ "$keep" =~ ^[0-9]+$ && "$keep" -ge 1 ]] || keep=5
  while IFS= read -r entry; do
    entries+=("$entry")
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort -r)
  count="${#entries[@]}"
  for ((i = keep; i < count; i++)); do
    rm -rf -- "${entries[$i]}"
  done
}

# Decide whether the database must be restored when going back to the previous
# release: only when the Alembic revision changed. "none" (no alembic_version
# table, a pre-Alembic database) -> a revision counts as a change too, because
# that is the Alembic adoption migrating the schema. An unknown (empty) revision
# before the update means no decision can be made.
horde_schema_changed() {
  local before="$1" after="$2"
  [[ -n "$before" && -n "$after" && "$before" != "$after" ]]
}
