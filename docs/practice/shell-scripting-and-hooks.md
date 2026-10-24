# shell-scripting-and-hooks

Researched: 2026-10-21

## Claude Code hooks: input on stdin

- All events give these common fields on stdin as JSON: `session_id`, `transcript_path`, `cwd`, `permission_mode` (`"default"`, `"plan"`, `"acceptEdits"`, `"auto"`, `"dontAsk"` or `"bypassPermissions"`) and `hook_event_name`. code.claude.com/docs/en/hooks §Common input fields [standard or field body]
- `PreToolUse` adds `tool_name`, `tool_input` and `tool_use_id`. For `Write`, `tool_input` has `file_path` (absolute path) and `content`. code.claude.com/docs/en/hooks §PreToolUse input [standard or field body]
- For `Write`, `Edit` and `Read`, `tool_input.file_path` is always absolute. Claude Code expands `~` and relative paths before the hook runs. On Windows the path has backslashes; the docs tell you to normalise with `FILE_PATH="${FILE_PATH//\\//}"` and to match a path segment, not to anchor with `^`. code.claude.com/docs/en/hooks §PreToolUse input [standard or field body]

## Claude Code hooks: exit codes

- Exit 0: Claude Code applies the JSON fields on stdout, and the action continues unless those fields deny it. "Claude never sees stderr from a hook that exits 0." code.claude.com/docs/en/hooks §Exit code output [standard or field body]
- Exit 2: on an event that can block (`PreToolUse` can), Claude Code stops the action, and the block message is the hook's stderr. If stdout has valid JSON, Claude Code reads it, but the JSON cannot override the block. code.claude.com/docs/en/hooks §Exit code output [standard or field body]
- Any other exit code is a non-blocking error: the action continues and the transcript shows a `<hook name> hook error` notice. "If your hook is meant to enforce a policy, use `exit 2`." Thus a crash (for example `jq` missing, exit 127) in a deny hook fails open, unless the hook sets `onFailure` (below). code.claude.com/docs/en/hooks §Exit code output [standard or field body]
- `"onFailure": "block"` on a `command` or `http` hook (Claude Code 2.1.295 and later) makes a failure do what exit 2 does on that event, so a `PreToolUse` failure blocks the tool call. A failure is a hook that cannot start, an exit other than 0 or 2 (even with JSON that allows), a timeout, or output that will not parse or fails schema validation; plain-text stdout is not one. It has no effect on `Stop`, `SubagentStop`, `TaskCompleted` or `TeammateIdle`, nor on an `async` or `asyncRewake` hook. Unset, or `"continue"`, the action goes on. So a policy hook that must not fail open sets it, and returns every verdict it reaches itself by exit 0 or 2. code.claude.com/docs/en/hooks §Block the action when a hook fails, read 23 Oct 2026 [standard or field body]

## Claude Code hooks: JSON output

- A `PreToolUse` deny is `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` on stdout with exit 0. `permissionDecision` takes `"allow"`, `"deny"`, `"ask"` or `"defer"` (`defer` only in `-p` mode). For `"deny"` Claude sees the reason; for `"ask"` the user sees it; for `"allow"` and `"defer"` it goes to the debug log only. code.claude.com/docs/en/hooks §PreToolUse decision control [standard or field body]
- The top-level `decision` and `reason` fields are deprecated for `PreToolUse`; `"approve"` and `"block"` map to `"allow"` and `"deny"`. Other events (`PostToolUse`, `Stop`) still use top-level `decision`. code.claude.com/docs/en/hooks §PreToolUse decision control [standard or field body]
- `hookSpecificOutput.additionalContext` on `PreToolUse` is a "String added to Claude's context alongside the tool result", ignored when the decision is `"defer"`. Claude Code wraps it in a system reminder. If you put `additionalContext` at the top level, Claude Code ignores it with no message. code.claude.com/docs/en/hooks §Add context for Claude; code.claude.com/docs/en/hooks-guide (UserPromptSubmit example) [standard or field body]
- `additionalContext`, `systemMessage` and plain stdout are capped at 10,000 characters. A longer value goes to a file in the session directory, and Claude gets the path and a preview of the first 2,000 characters. code.claude.com/docs/en/hooks §JSON output [standard or field body]
- If many `PreToolUse` hooks give different decisions, the precedence is `deny` > `defer` > `ask` > `allow`. Deny and ask permission rules still apply whatever a hook returns. code.claude.com/docs/en/hooks §PreToolUse decision control [standard or field body]
- Print only one JSON object on stdout. Output that does not start with `{` and end with `}` is plain text, and for `PreToolUse` it goes only to the debug log. A profile `echo` (for example through `BASH_ENV`) before the JSON makes Claude Code ignore the JSON with no error. Build the JSON with an encoder such as `jq`, not string concatenation, so quotes and backslashes are escaped. code.claude.com/docs/en/hooks §JSON output; code.claude.com/docs/en/hooks-guide §Shell profile output before the JSON, §Limitations and troubleshooting [standard or field body]

## Claude Code hooks: configuration, matcher, timeout, environment

- The structure has three levels: event (for example `PreToolUse`), then a matcher group (`"matcher": "Edit|Write"`), then handlers (`{"type":"command","command":"..."}`). Locations: `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed policy, plugin `hooks/hooks.json`, skill frontmatter, subagent frontmatter. code.claude.com/docs/en/hooks §Configuration [standard or field body]
- Matcher: `"*"`, `""` or no matcher matches all. A value of only letters, digits, `_`, `-`, spaces, `,` and `|` is an exact name or a list of exact names. Any other character makes it an unanchored JavaScript regex (`Edit.*` matches `NotebookEdit`; use `^...$` for a whole match). Matchers are case-sensitive. code.claude.com/docs/en/hooks §Matcher patterns; code.claude.com/docs/en/hooks-guide §Limitations and troubleshooting [standard or field body]
- `timeout` is in seconds. The default is 600 for `command` hooks (30 for `prompt`, 60 for `agent`). code.claude.com/docs/en/hooks §Hook handler fields [standard or field body]
- Shell form (no `args`) runs `command` through `sh -c` on macOS and Linux. Exec form (`args` present) spawns `command` directly with no shell. In exec form `${CLAUDE_PROJECT_DIR}` needs no quotes; in shell form, put it in double quotes, as in `"\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/protect-files.sh"`. code.claude.com/docs/en/hooks §Exec form and shell form, §Security best practices; hooks-guide §Block edits to protected files [standard or field body]
- Environment: `CLAUDE_PROJECT_DIR` is "the project root where the session started"; `CLAUDE_PLUGIN_ROOT` is the plugin install directory; `CLAUDE_PLUGIN_DATA` is "the plugin's persistent data directory, for dependencies and state that should survive plugin updates"; `CLAUDE_ENV_FILE` is for `SessionStart` hooks only. code.claude.com/docs/en/hooks §Environment variables [standard or field body]
- Matching hooks for one event run in parallel. An identical handler in more than one settings file runs once; a plugin's or skill's copy stays separate. Thus a once-per-session latch must be safe against a concurrent run of the same script. code.claude.com/docs/en/hooks §Hook execution [standard or field body]

## Claude Code hooks: per-session state

- The docs give no place for per-session hook state. The nearest vendor guidance: `CLAUDE_PLUGIN_DATA` for durable plugin state. The `once: true` handler field removes a hook after its first successful run, but only in skill frontmatter; settings files ignore it. Thus a settings-file hook that injects context once per session must keep its own latch, keyed on `session_id`. code.claude.com/docs/en/hooks §Hook handler fields (`once`), §Environment variables [standard or field body]
- For context at session start, the vendor event is `SessionStart`: `hookSpecificOutput.additionalContext` (or plain stdout) goes in "at the start of the conversation, before the first prompt". A `PreToolUse` latch is only necessary when the context must come at the first matching tool call. code.claude.com/docs/en/hooks §SessionStart [standard or field body]

## Claude Code hooks: security and testing

- Command hooks run "with your full user permissions". The vendor's best practices: validate and sanitise inputs; always quote shell variables (`"$VAR"`); block path traversal (check for `..`); use absolute paths for scripts; skip sensitive files (`.env`, `.git/`, keys). code.claude.com/docs/en/hooks §Security considerations [standard or field body]
- In an interactive session, Claude Code holds back settings-file hooks until the user accepts workspace trust. In a `-p` or SDK session it treats the folder as trusted, so committed `.claude/settings.json` hooks run. code.claude.com/docs/en/hooks §Workspace trust [standard or field body]
- To test a hook, pipe sample JSON into it: `echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | ./my-hook.sh`. To see what Claude Code did, run `claude --debug` and read `~/.claude/debug/<session-id>.txt`, or set `CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose`. code.claude.com/docs/en/hooks-guide §Limitations and troubleshooting; code.claude.com/docs/en/hooks §Debug hooks [standard or field body]

## Bash robustness: style and lint

- Google: "Bash is the only shell scripting language permitted for executables." Use shell only for small tools; rewrite in another language a script "more than 100 lines long, or that uses non-straightforward control flow logic". google.github.io/styleguide/shellguide.html §Which Shell, §When to use Shell [named expert]
- Google: "All error messages should go to `STDERR`"; "Always quote strings containing variables, command substitutions, spaces or shell meta characters"; "`[[ … ]]` is preferred over `[ … ]`"; "Bash arrays should be used to store lists of elements"; "`eval` should be avoided"; "Always check return values"; use `PIPESTATUS` for the status of each part of a pipe. google.github.io/styleguide/shellguide.html §STDOUT vs STDERR, §Quoting, §Test, §Arrays, §Eval, §Checking Return Values [named expert]
- Google recommends ShellCheck: "It is recommended for all scripts, large or small." google.github.io/styleguide/shellguide.html §ShellCheck [named expert]
- Declare and assign in two statements when the value comes from a command substitution, because `local var=$(cmd)` gives the status of `local`, not of `cmd`. Three sources agree: ShellCheck SC2155 ("Declare and assign separately to avoid masking return values", shellcheck.net/wiki/SC2155) [standard or field body]; Google §Use Local Variables; Wooledge BashPitfalls #27 [named expert]
- Use `printf '%s\n' "$var"`, not `echo $var`, for data you do not control; use `IFS= read -r`; use `--` before a path that can start with `-`. mywiki.wooledge.org/BashPitfalls #14, #12, #3 [named expert]
- To change a file, write a temp file and then `mv` it into place; do not read and write the same file in one pipeline. mywiki.wooledge.org/BashPitfalls #13 [named expert]

## Bash robustness: errexit, nounset, pipefail

- Bash manual: `set -e` does not exit when the failing command is in the test of `if`, `while` or `until`, in a `&&` or `||` list (but not the last command), in a pipeline (but not the last command, subject to `pipefail`), or negated with `!`. gnu.org/software/bash/manual §The Set Builtin [standard or field body]
- Wooledge BashFAQ/105 (GreyCat, geirha): "don't use set -e. Add your own error checking instead." Reasons: `set -e` stops inside a function called from `if f`, `f &&` or `f ||`; `local var=$(cmd)` masks the failure; `((i++))` with `i=0` returns 1 and kills the script; the rules change between Bash versions. mywiki.wooledge.org/BashFAQ/105; BashPitfalls #60 [named expert]
- `pipefail` makes `somecmd | head -n1` fail or not by chance, according to whether the output is larger than the pipe buffer (SIGPIPE). mywiki.wooledge.org/BashFAQ/105 [named expert]
- Google does not require `set -e`. It warns about `(( ))` "particularly with `set -e` enabled" and says to use `set` (not the shebang) for shell options. google.github.io/styleguide/shellguide.html §Arithmetic, §Which Shell [named expert]
- For a hook, the consequence: Claude Code treats an unplanned exit code (not 0, not 2) as a non-blocking error, so `set -e` turns an unexpected failure into "allow". A deny hook must check each failure explicitly and choose to exit 2 (fail closed) or 0 (fail open). Derived from the Claude Code exit-code rows and BashFAQ/105 [unverified]

## Bash robustness: testing shell scripts

- bats-core: `run` executes its arguments in a subshell and sets `$status`, `$output` (stdout and stderr together) and `${lines[@]}`. `run -N` fails the test if the exit status is not N; `run !` expects a non-zero status. `run --separate-stderr` puts stderr in `$stderr`. bats-core.readthedocs.io/en/stable/writing-tests.html §run [standard or field body]
- bats-core: `run` does not take a pipe or redirection ("Bash parses the pipe outside of `run`"). Use `bats_pipe`, or `run bash -c '... < fixture.json'`, to feed stdin. bats-core.readthedocs.io writing-tests.html §bats_pipe [standard or field body]
- bats-core gives `BATS_TEST_TMPDIR` ("a temporary directory unique for each test") and `BATS_FILE_TMPDIR`. Point the hook's state directory at one of these so that each test starts with no latch. bats-core.readthedocs.io writing-tests.html §Special variables [standard or field body]

## State files: where to put them

- XDG Base Directory spec: `XDG_RUNTIME_DIR` "MUST be owned by the user", its mode "MUST be 0700", its lifetime "MUST be bound to the user being logged in", and it "MUST be removed" when the user fully logs out. If it is not set, use a replacement with similar capabilities and print a warning. specifications.freedesktop.org/basedir/latest §Environment variables [standard or field body]
- XDG: `XDG_STATE_HOME` (default `$HOME/.local/state`) is for user state that must persist between application restarts. A relative path in any `XDG_*` variable is invalid and must be ignored. specifications.freedesktop.org/basedir/latest [standard or field body]
- Thus a per-session latch fits `XDG_RUNTIME_DIR` (private, removed at logout) or a directory that the tool owns, not a shared `/tmp` name. Derived from the XDG rows [unverified]
- A latch that only `session_id` keys is shared by the main session and its subagents. Claude Code gives `agent_id` only when the hook fires in a subagent, so key on both if each agent must get the context. The docs do not say if a subagent has the parent's `session_id`. code.claude.com/docs/en/hooks §Common input fields (`agent_id`, `agent_type`); repo `gp_agent_key` in `scripts/lib/guard-parse.sh` [standard or field body]

## State files: race-free create for a once-only latch

- A test-then-create (`[ -e f ] || : > f`) has "a time window between checking and creating the file, during which other programs may act". Use one atomic operation. mywiki.wooledge.org/BashFAQ/045 [named expert]
- `open(2)` with `O_CREAT|O_EXCL` fails with `EEXIST` if the path exists, and does not follow a symlink at the path. On NFS, `O_EXCL` needs NFSv3 or later; without it, locking that relies on it has a race. man7.org/linux/man-pages/man2/open.2.html §O_EXCL [standard or field body]
- Bash `set -C` (noclobber): "Prevent output redirection using '>', '>&', and '<>' from overwriting existing files." `>|` overrides it. gnu.org/software/bash/manual §The Set Builtin [standard or field body]
- Bash 5.2.21 on this machine opens the file with `O_WRONLY|O_CREAT|O_EXCL` under `set -C` (`strace -e trace=openat bash -c 'set -C; : > latch'` gives `openat(AT_FDCWD, "latch", O_WRONLY|O_CREAT|O_EXCL, 0666) = 3`), and a second run fails with "cannot overwrite existing file". Thus `if ( set -C; : > "$latch" ) 2>/dev/null; then <inject>; fi` is an atomic once-only test. Measurement, rerunnable (2026-10-21), resting on the `open(2)` and Bash manual rows above [standard or field body]
- Wooledge gives `mkdir` as the portable atomic check-and-create ("ensured at the operating system kernel level"), and lists `set -C` as an alternative with a caveat that ksh88 does not use `O_EXCL`. `flock` is the tool for a lock held for a time, not for a once-only marker. mywiki.wooledge.org/BashFAQ/045 [named expert]

## State files: temp files and atomic writes

- Use `mktemp`, which creates the file (not only a name), with read and write permission for the user only (`mktemp -d`: a directory with user-only permission). `mktemp -u` only prints a name and is "inherently unsafe". The template needs 3 or more `X`s; with no `-p`, `mktemp` uses `TMPDIR`, else `/tmp`. gnu.org/software/coreutils/manual §mktemp invocation [standard or field body]
- "Make sure that your tool actually creates the temporary file, and does not simply give you an unused name." A predictable name in `/tmp` (for example with `$$`) lets another program put a file or symlink there first. Remove temp files with `trap cleanup EXIT HUP INT TERM`. mywiki.wooledge.org/BashFAQ/062 [named expert]
- To replace a file atomically, write a temp file in the same directory and `mv` it over the target (a `rename(2)` in one file system). `rename(2)`: "If newpath already exists, it will be atomically replaced"; across file systems it fails with `EXDEV`, so the temp file must be in the target directory. mywiki.wooledge.org/BashPitfalls #13 [named expert]; man7.org/linux/man-pages/man2/rename.2.html [standard or field body]

## State files: untrusted ids in a path

- MITRE CWE-22: "When validating filenames, use stringent allowlists that limit the character set"; exclude directory separators such as "/"; allow a single "." at most; do not rely only on a filter that removes dangerous characters (one pass over ".../...//" that removes "../" leaves "../"). cwe.mitre.org/data/definitions/22.html §Potential Mitigations [standard or field body]
- OWASP: "Define what the application accepts and reject values outside those rules"; "Do not try to recognize every malicious string"; a regex must "Require a match of the entire value". cheatsheetseries.owasp.org Input_Validation_Cheat_Sheet [standard or field body]
- Claude Code: "Validate and sanitize inputs"; "Block path traversal: check for `..` in file paths". code.claude.com/docs/en/hooks §Security best practices [standard or field body]
- Thus, for `session_id`: accept it only if it matches the whole of an allowlist such as `[[ $sid =~ ^[A-Za-z0-9_-]{1,128}$ ]]`, else do not write a latch. The repo's `gp_agent_key` replaces each other character with `_` (`${sid//[^A-Za-z0-9_-]/_}`). That also removes `/` and `.`, but two different ids can then map to one name. Derived from the three rows above [unverified]

## Git hooks: githooks(5) and managers

- Git runs hooks from `$GIT_DIR/hooks`, or from `core.hooksPath` if set. "Hooks that don't have the executable bit set are ignored." In a non-bare repo a hook runs at the root of the working tree. git-scm.com/docs/githooks §DESCRIPTION [standard or field body]
- Git exports `GIT_DIR`, `GIT_WORK_TREE` and other variables to a hook. A hook that runs git in a different repo or worktree must clear them, for example `unset $(git rev-parse --local-env-vars)`. git-scm.com/docs/githooks §DESCRIPTION [standard or field body]
- `pre-commit` and `commit-msg` abort the command on a non-zero exit, and `--no-verify` bypasses both. Thus a git hook is a convenience gate; CI must run the same check. `pre-push` reads lines `<local-ref> SP <local-object-name> SP <remote-ref> SP <remote-object-name> LF` on stdin. git-scm.com/docs/githooks §pre-commit, §commit-msg, §pre-push [standard or field body]
- Managers: husky sets `core.hooksPath` and installs from the npm `prepare` script (typicode.github.io/husky); the pre-commit framework pins each hook repo to an immutable `rev`, passes the staged file names, and stashes unstaged changes while it runs (pre-commit.com); lefthook reads `lefthook.yml`, has `parallel: true` and a `{staged_files}` placeholder (lefthook.dev). [standard or field body]

## Summary: leading tools and practices for the immediate task

- Practice for a `PreToolUse` deny-plus-inject hook, derived from the rows above: read stdin once into a variable; parse each field with `jq -r '... // empty'`; quote each expansion; check each failure explicitly instead of `set -e`; print exactly one JSON object built by `jq -n --arg`; for a deny, prefer `permissionDecision: "deny"` with a reason (exit 0), or stderr plus exit 2; validate `session_id` against an anchored allowlist before it goes in a path; make the latch with one atomic create (`set -C` redirection or `mkdir`) in a private directory; test by spawning the script with fixture JSON on stdin and a state directory set to a fresh temp directory. [unverified]
