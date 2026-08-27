#!/usr/bin/env bash
# command-center.sh — visual tmux launcher for project folders.
#
#   cc            visual fzf menu: live sessions (●) + project folders (○); pick to attach/create
#   cc <name>     jump straight to a project's session (creates it if needed)
#   cc --list     list live sessions
#   cc --kill     pick a session to kill
#
# Each project gets ONE persistent tmux session, cd'd into its folder. Sessions
# survive disconnects (that's tmux). Reach them remotely over Tailscale SSH:
#   ssh you@myhost   then run:  cc
# Installed as ~/.local/bin/cc (symlink). Canonical copy lives in the PM hub.

set -uo pipefail
export PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME/Projects}"

sanitize() { printf '%s' "$1" | tr ' .:' '___' | tr -cd '[:alnum:]_-'; }

attach_or_switch() {   # attach if outside tmux, switch if already inside one
  local sess="$1"
  if [ -n "${TMUX:-}" ]; then tmux switch-client -t "=$sess"; else tmux attach -t "=$sess"; fi
}

ensure_session() {     # create session (detached, cd'd) if missing, then enter it
  local name="$1" dir="$2"
  tmux has-session -t "=$name" 2>/dev/null || tmux new-session -d -s "$name" -c "$dir"
  attach_or_switch "$name"
}

# --- direct sub-commands ---------------------------------------------------
case "${1:-}" in
  --list|-l) tmux ls 2>/dev/null || echo "no live sessions"; exit 0 ;;
  --kill|-k) k=$(tmux ls -F '#{session_name}' 2>/dev/null | fzf --prompt="kill ▸ " --height=40% --reverse)
             [ -n "$k" ] && tmux kill-session -t "=$k" && echo "killed $k"; exit 0 ;;
  "" ) : ;;                                   # fall through to menu
  * )  m=$(ls -1 "$PROJECTS_ROOT" 2>/dev/null | grep -i "^$1" | head -1)
       t="${m:-$1}"; ensure_session "$(sanitize "$t")" "$PROJECTS_ROOT/$t"; exit 0 ;;
esac

# --- visual menu -----------------------------------------------------------
build_menu() {
  tmux ls -F '#{session_name}' 2>/dev/null | while read -r s; do printf '● session  %s\n' "$s"; done
  for d in "$PROJECTS_ROOT"/*/; do printf '○ project  %s\n' "$(basename "$d")"; done
  printf '＋ new      [named session in \$HOME]\n'
}

sel=$(build_menu | awk '!seen[$0]++' | fzf --ansi --height=70% --reverse \
        --prompt="command-center ▸ " \
        --header="↵ attach/create   ● live session   ○ project folder" \
        --preview-window=right:52%:wrap \
        --preview='name=$(printf "%s" {} | awk "{print \$NF}");
                   d="$PROJECTS_ROOT/$name";
                   if tmux has-session -t "=$name" 2>/dev/null; then
                     echo "── live session: $name ──"; tmux capture-pane -pt "=$name" 2>/dev/null | tail -25;
                   elif [ -d "$d/.git" ]; then
                     echo "── $name (git) ──";
                     git -C "$d" -c color.status=always status -sb 2>/dev/null | head -20;
                     echo; echo "last commit:"; git -C "$d" log -1 --format="  %cr — %s" 2>/dev/null;
                   else echo "$name"; ls -1 "$d" 2>/dev/null | head -20; fi')

[ -z "${sel:-}" ] && exit 0
kind=$(printf '%s' "$sel" | awk '{print $2}')
name=$(printf '%s' "$sel" | awk '{print $NF}')

case "$kind" in
  session) attach_or_switch "$name" ;;
  project) ensure_session "$(sanitize "$name")" "$PROJECTS_ROOT/$name" ;;
  new)     printf 'session name: '; read -r nn; [ -n "$nn" ] && ensure_session "$(sanitize "$nn")" "$HOME" ;;
esac
