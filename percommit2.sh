#!/bin/bash
SP=/tmp/claude-0/-home-user-horde/d3776dd8-d2e0-55bb-8adf-2714698fd5e2/scratchpad
for c in $(git -C /home/user/horde rev-list --reverse "$1"); do
  rm -rf $SP/pc && mkdir -p $SP/pc && git -C /home/user/horde archive $c | tar -x -C $SP/pc
  cd $SP/pc/backend
  r=$($2/bin/ruff check . -q >/dev/null 2>&1 && echo ok || echo RUFF_FAIL)
  f=$($2/bin/ruff format --check . -q >/dev/null 2>&1 && echo ok || echo FMT_FAIL)
  t=$(PYTHONPATH=. timeout 900 setsid $2/bin/python -m pytest -p no:warnings -o addopts="" -q 2>&1 | tail -1)
  echo "$(git -C /home/user/horde log -1 --format='%h %s' $c) | $r | $f | $t"
done
