/*
 * git-options.js — git's own options before the subcommand that take the
 * next word as a value (git.c's `handle_options`). `--exec-path` takes one
 * only after `=`. A leaf: the guard parser (lib/shell-words.js) and the read
 * audit (lib/read-audit-git.js) both read it, so neither pulls in the other.
 */

const GIT_VALUED = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--attr-source",
	"--shallow-file",
]);

module.exports = { GIT_VALUED };
