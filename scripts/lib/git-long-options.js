/*
 * git-long-options.js — the long options of each git subcommand the
 * guard-pull-form core judges, and git's reading of an abbreviated one (workflow-core#3998).
 *
 * git takes a long option's unique abbreviation, among ALL of that subcommand's
 * options: `git merge --e` is `--edit`, and `git branch --for` is refused as
 * ambiguous with `--format`. Read against a
 * guard's own tables, `--e` would be rebase's `--edit-todo`, which passes.
 *
 * Taken from `git <sub> --git-completion-helper-all`, `git stash push` for
 * stash, on git 2.43.0. A later git's new option leaves a word this list reads
 * as one option ambiguous there, so git refuses it, unless that word is the new
 * option's whole name. An older git lacking a listed option can take as unique a
 * word this list calls ambiguous, and that word reads here as spelled.
 */

/** @type {Record<string, string>} */
const LONG_OPTIONS = {
	branch:
		"--verbose --quiet --track --set-upstream --set-upstream-to --unset-upstream --color --remotes --contains --no-contains --with --without --abbrev --all --delete --move --omit-empty --copy --list --show-current --create-reflog --edit-description --force --merged --no-merged --column --sort --points-at --ignore-case --recurse-submodules --format --no-verbose --no-quiet --no-track --no-set-upstream --no-set-upstream-to --no-unset-upstream --no-color --no-abbrev --no-delete --no-move --no-omit-empty --no-copy --no-list --no-show-current --no-create-reflog --no-edit-description --no-force --no-column --no-sort --no-points-at --no-ignore-case --no-recurse-submodules --no-format",
	"update-ref":
		"--no-deref --stdin --create-reflog --deref --no-stdin --no-create-reflog",
	"symbolic-ref":
		"--quiet --delete --short --recurse --no-quiet --no-delete --no-short --no-recurse",
	checkout:
		"--guess --overlay --quiet --recurse-submodules --progress --merge --conflict --detach --track --force --orphan --overwrite-ignore --ignore-other-worktrees --ours --theirs --patch --ignore-skip-worktree-bits --pathspec-from-file --pathspec-file-nul --no-guess --no-overlay --no-quiet --no-recurse-submodules --no-progress --no-merge --no-conflict --no-detach --no-track --no-force --no-orphan --no-overwrite-ignore --no-ignore-other-worktrees --no-patch --no-ignore-skip-worktree-bits --no-pathspec-from-file --no-pathspec-file-nul",
	switch:
		"--create --force-create --guess --discard-changes --quiet --recurse-submodules --progress --merge --conflict --detach --track --force --orphan --overwrite-ignore --ignore-other-worktrees --no-create --no-force-create --no-guess --no-discard-changes --no-quiet --no-recurse-submodules --no-progress --no-merge --no-conflict --no-detach --no-track --no-force --no-orphan --no-overwrite-ignore --no-ignore-other-worktrees",
	reset:
		"--quiet --no-refresh --mixed --soft --hard --merge --keep --recurse-submodules --patch --intent-to-add --pathspec-from-file --pathspec-file-nul --refresh --no-quiet --no-recurse-submodules --no-patch --no-intent-to-add --no-pathspec-from-file --no-pathspec-file-nul",
	restore:
		"--source --staged --worktree --ignore-unmerged --overlay --quiet --recurse-submodules --progress --merge --conflict --ours --theirs --patch --ignore-skip-worktree-bits --pathspec-from-file --pathspec-file-nul --no-source --no-staged --no-worktree --no-ignore-unmerged --no-overlay --no-quiet --no-recurse-submodules --no-progress --no-merge --no-conflict --no-patch --no-ignore-skip-worktree-bits --no-pathspec-from-file --no-pathspec-file-nul",
	clean:
		"--quiet --dry-run --force --interactive --exclude --no-quiet --no-dry-run --no-force --no-interactive",
	stash:
		"--keep-index --staged --patch --quiet --include-untracked --all --message --pathspec-from-file --pathspec-file-nul --no-keep-index --no-staged --no-patch --no-quiet --no-include-untracked --no-all --no-message --no-pathspec-from-file --no-pathspec-file-nul",
	pull: "--verbose --quiet --progress --recurse-submodules --rebase --stat --summary --log --signoff --squash --commit --edit --cleanup --ff --ff-only --verify --verify-signatures --autostash --strategy --strategy-option --gpg-sign --allow-unrelated-histories --all --append --upload-pack --force --tags --prune --jobs --dry-run --keep --depth --shallow-since --shallow-exclude --deepen --unshallow --update-shallow --refmap --server-option --ipv4 --ipv6 --negotiation-tip --show-forced-updates --set-upstream --no-verbose --no-quiet --no-progress --no-recurse-submodules --no-rebase --no-stat --no-summary --no-log --no-signoff --no-squash --no-commit --no-edit --no-cleanup --no-ff --no-verify --no-verify-signatures --no-autostash --no-strategy --no-strategy-option --no-gpg-sign --no-allow-unrelated-histories --no-all --no-append --no-upload-pack --no-force --no-tags --no-prune --no-jobs --no-dry-run --no-keep --no-depth --no-shallow-since --no-shallow-exclude --no-deepen --no-update-shallow --no-server-option --no-ipv4 --no-ipv6 --no-negotiation-tip --no-show-forced-updates --no-set-upstream",
	merge:
		"--stat --summary --log --squash --commit --edit --cleanup --ff --ff-only --rerere-autoupdate --verify-signatures --strategy --strategy-option --message --file --into-name --verbose --quiet --abort --quit --continue --allow-unrelated-histories --progress --gpg-sign --autostash --overwrite-ignore --signoff --no-verify --verify --no-stat --no-summary --no-log --no-squash --no-commit --no-edit --no-cleanup --no-ff --no-rerere-autoupdate --no-verify-signatures --no-strategy --no-strategy-option --no-message --no-into-name --no-verbose --no-quiet --no-abort --no-quit --no-continue --no-allow-unrelated-histories --no-progress --no-gpg-sign --no-autostash --no-overwrite-ignore --no-signoff",
	rebase:
		"--onto --keep-base --no-verify --quiet --verbose --no-stat --signoff --committer-date-is-author-date --reset-author-date --ignore-date --ignore-whitespace --whitespace --force-rebase --no-ff --continue --skip --abort --quit --edit-todo --show-current-patch --apply --merge --interactive --preserve-merges --rerere-autoupdate --empty --keep-empty --autosquash --update-refs --gpg-sign --autostash --exec --allow-empty-message --rebase-merges --fork-point --strategy --strategy-option --root --reschedule-failed-exec --reapply-cherry-picks --verify --stat --ff --no-onto --no-keep-base --no-quiet --no-verbose --no-signoff --no-committer-date-is-author-date --no-reset-author-date --no-ignore-date --no-ignore-whitespace --no-whitespace --no-force-rebase --no-preserve-merges --no-rerere-autoupdate --no-keep-empty --no-autosquash --no-update-refs --no-gpg-sign --no-autostash --no-exec --no-allow-empty-message --no-rebase-merges --no-fork-point --no-strategy --no-strategy-option --no-root --no-reschedule-failed-exec --no-reapply-cherry-picks",
};

/**
 * The long option `flag` names under `git <sub>`: its whole name where it
 * abbreviates exactly one, else `flag` as spelled, git refusing an ambiguous or
 * unknown word. A whole name is itself, though it begins a longer one.
 * @param {string} sub
 * @param {string} flag
 * @returns {string}
 */
function expandLongOption(sub, flag) {
	const row = LONG_OPTIONS[sub];
	if (row === undefined) throw new Error(`no long options for git ${sub}`);
	const names = row.split(" ");
	if (names.includes(flag)) return flag;
	const [only, second] = names.filter((name) => name.startsWith(flag));
	return only !== undefined && second === undefined ? only : flag;
}

module.exports = { expandLongOption };
