#!/usr/bin/env bash
# browser-profile-guard.sh — PreToolUse(Bash): refuse a command that would open
# a URL in the wrong Chrome profile. The Windows default browser and a bare
# chrome.exe open whichever profile Chrome picks, not the one signed in to this
# session's account (design-vault#64).
#
# The right profile is derived live, only once a trigger word matches (#5339):
# the session's account is `oauthAccount.emailAddress` in the config dir's
# `.claude.json`, matched against the `user_name` of each profile in Chrome's one
# `Local State` (`.profile.info_cache`). No email, no single `Local State`, or no
# single matching profile leaves it underived: every refusal still fires, naming
# no profile.
#
# Self-contained: it runs as a plugin hook and as the founder's machine copy at
# ~/.claude/hooks/, so it sources nothing from workflow-core and writes its own
# deny envelope. `npm run check:settings` holds the machine copy to this file.
#
# Named for what it guards, not `guard-*`: the founder's machine copy under
# ~/.claude/hooks/ carries this name, and check:settings pairs the two by it.
set -uo pipefail

cmd=$(jq -r '.tool_input.command // empty')
[[ -z "$cmd" ]] && exit 0

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# Every trigger below names one of these words, so a command naming none skips
# the scan and reads neither store.
grep -qiE 'chrome\.exe|xdg-open|wslview|explorer\.exe|cmd\.exe|start-process|url\.dll|auth +login|npm +login' <<<"$cmd" || exit 0

# Where CLAUDE_CONFIG_DIR is unset, Claude Code keeps `.claude.json` in $HOME.
config_dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
claude_json=$config_dir/.claude.json
[[ -z "${CLAUDE_CONFIG_DIR:-}" ]] && [[ ! -f "$claude_json" ]] && claude_json=$HOME/.claude.json
email=$(jq -r '.oauthAccount.emailAddress // empty' "$claude_json" 2>/dev/null)
profile='' profile_email=''
if [[ -n "$email" ]]; then
  shopt -s nullglob
  stores=("${BROWSER_GUARD_WINDOWS_USERS:-/mnt/c/Users}"/*/AppData/Local/Google/Chrome/'User Data'/'Local State')
  shopt -u nullglob
  if [[ "${#stores[@]}" -eq 1 ]]; then
    matches=$(jq -r --arg e "$email" '.profile.info_cache // {} | to_entries | map(select(.value.user_name == $e)) | if length == 1 then .[0].key else empty end' "${stores[0]}" 2>/dev/null)
    [[ -n "$matches" ]] && profile=$matches profile_email=$email
  fi
fi
if [[ -n "$profile" ]]; then
  open_right='Open it with: "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" --profile-directory="'"$profile"'" "<url>" — the profile signed in to '"$profile_email"'.'
else
  open_right="No single Chrome profile could be matched to this session's account, so pass chrome.exe --profile-directory the one signed in to it."
fi
picker='Name a profile to the founder by its account, never by its directory; its number in Chrome'"'"'s profile picker is in the machine note the `browser-ladder` skill names.'

# The triggers are matched against what the command would RUN, not its raw text
# (workflow-core#1547): heredoc bodies, comments and quoted arguments are dropped.
# Kept, because they run:
#   - a quoted word before the command word, assignment values included, and a
#     quoted absolute path ending in .exe wherever it stands;
#   - the string handed to a shell's `-c`, `eval`, an interpreter's `-c`/`-e`,
#     cmd.exe, PowerShell or rundll32 — a shell's and eval's re-read the same
#     way unless built by a substitution, which keeps it whole;
#   - `$(…)` and backticks, inside double quotes and unquoted heredocs too;
#   - a heredoc body a shell, interpreter or PowerShell reads as its program
#     (`bash <<EOF`, `cat <<EOF | sh`, `python3 - <<EOF`), or that is written to
#     a file the command then runs.
# A dropped quoted argument that held a URL leaves `"https:"` behind, so
# `explorer.exe "https://…"` still matches. This is a lexer, not a shell: where
# it misreads it keeps text. Perl, because a bash character loop is quadratic.
# Where perl fails, the raw command is matched.
run=$(
  printf '%s' "$cmd" | perl /dev/fd/3 3<<'PERL'
use strict;
use warnings;

my $SHELL_NAMES = 'bash|sh|zsh|dash|ksh|script|su';
my $INTERP_NAMES = 'node|python3?|perl|ruby';
my $SHELLS = qr/^(?:$SHELL_NAMES)$/;
my $INTERPS = qr/^(?:$INTERP_NAMES)$/;
# Every argument of these is part of the command line they run.
my $PASSERS = qr/^(?:cmd|powershell|pwsh|rundll32)(?:\.exe)?$/i;
# Words after which the command word is still to come.
my $LEADERS = qr/^(?:sudo|doas|nohup|setsid|coproc|env|exec|command|builtin|nice|time|timeout|stdbuf|xargs|watch|export|local|declare|readonly|typeset|if|then|else|elif|do|while|until|!|\{)$/;

# Heredoc bodies dropped while written to a file, as [file, body]: kept after
# all where the command goes on to run that file.
my @written;
# Every command word scan() settles, at any depth.
my @commands;

# dq($s, $to_end): read a double-quoted span from pos($$s) to its closing quote,
# or to the end of $$s given $to_end. Returns its text and the substitutions in
# it, which run.
sub dq {
  my ($s, $to_end) = @_;
  my $plain = $to_end ? qr/\G(?:[^\\`\$]+|\\.?|\$(?!\())/s : qr/\G(?:[^\\"`\$]+|\\.?|\$(?!\())/s;
  my $start = pos($$s) // 0;
  my $subs = '';
  while (1) {
    if ($$s =~ /$plain/gc) { }
    elsif ($$s =~ /\G\$\(/gc) { $subs .= ' $(' . scan($s, ')') . ')' }
    elsif ($$s =~ /\G`/gc) { $subs .= ' `' . scan($s, '`') . '`' }
    else { last }
  }
  my $raw = substr($$s, $start, (pos($$s) // 0) - $start);
  $$s =~ /\G"/gc unless $to_end;
  return ($raw, $subs);
}

# scan($s, $end): read $$s from pos() up to $end — `)` closing a `$(`, a
# backtick, or '' for the end — and return what would run.
sub scan {
  my ($s, $end) = @_;
  my ($out, $word, $in_word, $depth, $line_at, @docs) = ('', '', 0, 0, 0);
  # The simple command being read.
  my $before_command = 1;    # its command word is still to come
  my $after_leader = 0;      # a leader such as sudo or timeout has been read
  my $leader_option = 0;     # the word read last was a leader's option, such as sudo's -u
  my $names_shell = 0;
  my $names_interp = 0;
  my $names_passer = 0;
  my $names_eval = 0;
  my $strings_run = 0;       # its quoted strings are code it runs
  my $here_string = 0;       # the word being read follows `<<<`
  my $redirect_to = 0;       # the word being read follows `>` or `<`

  my $end_word = sub {
    return unless $in_word;
    (my $base = $word) =~ s{.*/}{};
    if ($before_command && !$redirect_to) {
      my $was_option = $leader_option;
      $leader_option = 0;
      if ($word =~ /^[A-Za-z_]\w*=/) { }
      elsif ($base =~ $LEADERS) { $after_leader = 1 }
      elsif ($after_leader && $word =~ /^-/) { $leader_option = 1 }
      elsif ($after_leader && $word =~ /^[\d.]+[smhd]?$/) { }
      # An option's value, such as sudo -u's user; a path is taken as the command.
      elsif ($was_option && $word !~ m{/}) { }
      else { $before_command = 0; push @commands, $word }
    }
    if ($base =~ $SHELLS) { $names_shell = 1 }
    elsif ($base =~ $INTERPS) { $names_interp = 1 }
    elsif ($base =~ $PASSERS) { $names_passer = $strings_run = 1 }
    elsif ($base eq 'eval') { $names_eval = $strings_run = 1 }
    elsif ($names_shell && $word =~ /^-[A-Za-z]*c[A-Za-z]*$/) { $strings_run = 1 }
    elsif ($names_interp && $word =~ /^-[A-Za-z]*[ce][A-Za-z]*$/) { $strings_run = 1 }
    ($word, $in_word, $here_string, $redirect_to) = ('', 0, 0, 0);
  };
  my $new_command = sub {
    $end_word->();
    ($before_command, $after_leader, $leader_option, $names_shell, $names_interp, $names_passer, $names_eval, $strings_run) = (1, 0, 0, 0, 0, 0, 0, 0);
  };
  # A quoted span: kept where it runs or names what runs, else reduced to its
  # substitutions.
  my $quoted = sub {
    my ($q, $text, $subs) = @_;
    $in_word = 1;
    if ($before_command || $text =~ m{^(?:[A-Za-z]:)?[/\\].*\.exe$}i) { $out .= "$q$text$q" }
    elsif ($strings_run || ($here_string && ($names_shell || $names_interp))) {
      if (!$names_passer && ($names_shell || $names_eval) && $text !~ /\$\(|`/) {
        my $x = $text;
        $out .= ';' . scan(\$x, '') . ';';
      }
      else { $out .= "$q$text$q" }
    }
    else { $out .= '"' . $subs . ($text =~ /https?:/i ? 'https:' : '') . '"' }
    $word .= $text;
  };
  # The heredocs a line opened, read once the line ends: run as a program
  # where a shell, interpreter or PowerShell on that line has no script argument.
  my $bodies = sub {
    my $how = 'drop';
    my $line = substr($out, $line_at);
    while ($line =~ /(?:^|[\s;&|(])(?:\S*\/)?($SHELL_NAMES|$INTERP_NAMES|powershell|pwsh|cmd)(?:\.exe)?((?:[ \t]+-\S*)*)([ \t]*(?:$|[;&|)<>]))?/mgi) {
      my ($prog, $flags, $tail) = ($1, $2, $3);
      my $shell = $prog =~ $SHELLS;
      next unless defined $tail || ($shell && $flags =~ /(?:^|\s)-\w*s/);
      $how = $shell ? 'shell' : 'raw';
      last;
    }
    my ($file) = $line =~ /(?:>>?|\btee(?:[ \t]+-\S+)*)[ \t]*([^\s;&|<>()]+)/;
    for my $d (@docs) {
      my ($dash, $literal, $delim) = @$d;
      my $body = '';
      while ($$s =~ /\G([^\n]*)(\n|\z)/gc) {
        my ($l, $nl) = ($1, $2);
        (my $cmp = $l) =~ s/^\t+// if $dash;
        last if ($dash ? $cmp : $l) eq $delim;
        $body .= "$l\n";
        last if $nl eq '';
      }
      if ($how eq 'shell') { $out .= ';' . scan(\$body, '') . ';' }
      elsif ($how eq 'raw') { $out .= $body }
      else {
        push @written, [$file, $body] if defined $file;
        $out .= (dq(\$body, 1))[1] unless $literal;
      }
    }
    @docs = ();
  };

  while (1) {
    if ((pos($$s) // 0) >= length $$s) { last }
    elsif ($$s =~ /\G\\\n/gc) { }
    elsif ($$s =~ /\G(\\.)/gcs) { $out .= $1; $word .= substr($1, 1); $in_word = 1 }
    elsif ($$s =~ /\G\$'((?:[^'\\]|\\.)*)'?/gcs) { $quoted->("'", $1, '') }
    elsif ($$s =~ /\G'([^']*)'?/gc) { $quoted->("'", $1, '') }
    elsif ($$s =~ /\G"/gc) { $quoted->('"', dq($s, 0)) }
    elsif ($$s =~ /\G`/gc) {
      last if $end eq '`';
      $out .= '`' . scan($s, '`') . '`';
      ($word, $in_word) = ($word . 'x', 1);
    }
    elsif ($$s =~ /\G\$\(/gc) {
      $out .= '$(' . scan($s, ')') . ')';
      ($word, $in_word) = ($word . 'x', 1);
    }
    elsif ($$s =~ /\G\(/gc) { $new_command->(); $depth++; $out .= '(' }
    elsif ($$s =~ /\G\)/gc) {
      last if $end eq ')' && !$depth;
      $new_command->();
      $depth--;
      $out .= ')';
    }
    elsif (!$in_word && $$s =~ /\G#[^\n]*/gc) { }
    elsif ($$s =~ /\G([ \t]+)/gc) { $end_word->(); $out .= $1 }
    elsif ($$s =~ /\G\n/gc) {
      $new_command->();
      $out .= "\n";
      $bodies->() if @docs;
      $line_at = length $out;
    }
    elsif ($$s =~ /\G([;&|]+)/gc) { $new_command->(); $out .= $1 }
    elsif ($$s =~ /\G<<</gc) { $end_word->(); $out .= '<<<'; $here_string = 1 }
    elsif ($$s =~ /\G<<(-?)[ \t]*([^\s;&|<>()]+)/gc) {
      my ($dash, $delim) = ($1, $2);
      $end_word->();
      $out .= "<<$dash$delim";
      my $literal = $delim =~ /['"\\]/ ? 1 : 0;
      $delim =~ s/['"\\]//g;
      push @docs, [$dash, $literal, $delim];
    }
    elsif ($$s =~ /\G([<>]&?)/gc) { $end_word->(); $out .= $1; $redirect_to = 1 }
    elsif ($$s =~ /\G([^\s\\'"`\$()#;&|<>]+|.)/gcs) { $out .= $1; $word .= $1; $in_word = 1 }
    else { last }
  }
  $end_word->();
  return $out;
}

local $/;
my $cmd = <STDIN>;
my $run = scan(\$cmd, '');
# A written file the command goes on to run, by a shell, an interpreter,
# `source`, or its path as a command word: its body runs too. A path that is
# only an argument, such as `--comment-file x.md`, is data.
for my $w (@written) {
  my ($file, $body) = @$w;
  (my $name = $file) =~ s{.*/}{};
  my $n = quotemeta $name;
  $run .= "\n$body" if $run =~ /(?:^|[\s;&|(])(?:\S*\/)?(?:$SHELL_NAMES|$INTERP_NAMES|source|\.)(?:[ \t]+-\S+)*[ \t]+\S*\/?$n\b/m
    || grep { m{(?:^|/)$n$} && m{/} } @commands;
}
print $run;
PERL
) || {
  echo "browser-profile-guard: the scan failed, so the raw command is matched" >&2
  run=$cmd
}

if grep -qiE 'chrome\.exe' <<<"$run" && ! grep -qiE -- '--profile-directory' <<<"$cmd"; then
  deny "chrome.exe without --profile-directory opens whichever profile Chrome picks, not this session's. $open_right $picker"
fi

# Anything that hands a URL to the Windows default browser.
if grep -qiE '(^|[;&|(`][ ]*)([^ ]*/)?(xdg-open|wslview)([ ]|$)|explorer\.exe[^;&|]*https?:|cmd\.exe[^;&|]*start[^;&|]*https?:|start-process[^;&|]*https?:|url\.dll' <<<"$run"; then
  deny "This opens the URL in the Windows default browser, which opens whichever profile Chrome picks, not this session's. $open_right $picker"
fi

# Tools that open the default browser themselves: allowed only with their opener disabled.
# gh-route-exempt: only text matched in the command; claude-route-exempt: only text likewise.
if grep -qiE '(claude(\.exe)?"? +auth +login|gh +auth +login[^;&|]*--web|npm +login)' <<<"$run" && ! { grep -qF 'WSLENV=BROWSER/w' <<<"$cmd" && grep -qiF 'BROWSER='"'"'C:\Windows\System32\where.exe' <<<"$cmd"; }; then
  deny "This tool opens the Windows default browser itself, so its tab lands in whichever profile Chrome picks, not this session's. Never hand that to the founder. Prefix it with BROWSER='C:\\Windows\\System32\\where.exe' WSLENV=BROWSER/w to disable the opener, then open its link yourself with chrome.exe --profile-directory; for a Claude login, point redirect_uri at the waiting process's localhost port (method: workflow-core's docs/claude-user-settings.md, Claude login for the founder). $open_right $picker"
fi
exit 0
