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

# Fast-forward pull that will not discard .env (gitignored) or require reset --hard.
# On compose-file stash conflicts, keep the incoming compose and rely on .env paths.
horde_git_pull() {
  local branch stashed=0
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" == "HEAD" ]]; then
    echo "Refusing to update on a detached HEAD. Checkout main (or your branch) first." >&2
    return 1
  fi

  echo "Pulling latest code (preserving .env and host volume paths)..."
  if git pull --ff-only --autostash origin "$branch"; then
    _horde_clear_compose_conflicts
    return 0
  fi

  echo "Fast-forward with --autostash failed; trying an explicit stash + pull..." >&2
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    git stash push -m "horde-update.sh autostash"
    stashed=1
  fi
  if git pull --ff-only origin "$branch" || git pull origin "$branch"; then
    if [[ "$stashed" -eq 1 ]]; then
      git stash pop || true
    fi
    _horde_clear_compose_conflicts
    return 0
  fi
  echo "git pull failed. Your .env was not modified; fix git state and retry." >&2
  return 1
}

_horde_clear_compose_conflicts() {
  local f conflicted=0
  for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
    if [[ -f "$f" ]] && grep -q -E '^(<<<<<<<|=======|>>>>>>>)' "$f"; then
      conflicted=1
      echo "Compose file ${f} has merge conflict markers; keeping the pulled version." >&2
      if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
        git checkout HEAD -- "$f"
      fi
    fi
  done
  if [[ "$conflicted" -eq 1 ]]; then
    git stash drop >/dev/null 2>&1 || true
    echo "Local compose edits were not re-applied. Host paths stay in .env." >&2
    echo "Re-apply other compose tweaks in docker-compose.override.yml (gitignored)." >&2
  fi
}
