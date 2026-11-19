#!/bin/sh
# A new, non-reader CLI: POSIX shell only. All executable paths arrive via argv.
set -eu
root=$2; shift 2
session=none; mode=start
if [ "${1-}" = --session ]; then session=$2; shift 2; fi
if [ "${1-}" = --resume ]; then mode=resume; shift; fi
prompt=$1
mkdir -p "$root/local-processes"
printf '%s\n%s\n%s\n' "$session" "$mode" "$prompt" > "$root/local-processes/$$"
# alpacawork's start text carries the request text on the line after the request heading.
request=$(printf '%s\n' "$prompt" | sed -n '/^## Request$/{n;p;q;}')
case "$request" in
  *fail) printf 'local reviewer rejected the prompt\n' >&2; exit 7 ;;
  *long)
    sleep 600 &
    printf '%s\n' "$!" > "$root/local-child"
    wait
    ;;
esac
printf 'session=%s mode=%s\n%s\n' "$session" "$mode" "$prompt"
