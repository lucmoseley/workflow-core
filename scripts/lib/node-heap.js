/*
 * node-heap.js — the guard-node-heap core (#2784, #3226): a command naming
 * the V8 heap cap is handed `rule:node-heap` before it runs (#2025).
 *
 * The raw command is matched, anywhere in it: a raise cannot be told from a
 * lowering without parsing every way NODE_OPTIONS can be built, and V8 takes
 * either spelling.
 *
 * INJECTION ONLY — it never denies. Setting a lower heap for one command is
 * legitimate. Its lib/guard-cores.json row narrows it to
 * `Bash(*max-old-space-size*)` and `Bash(*max_old_space_size*)`.
 *
 * LIMITS
 *  - A mixed spelling such as `max-old_space-size`, which V8 also accepts,
 *    passes the `if` narrowing and is never seen.
 *  - It matches the flag anywhere in the command, so a `grep` or `echo` that
 *    only mentions it spends the once-a-session delivery.
 *  - An edit to `~/.bashrc` through Write or Edit, or a heap set from inside a
 *    script the command runs, is no Bash command naming the flag.
 */

const HEAP_FLAG = /max[-_]old[-_]space[-_]size/;

/**
 * @param {string} command
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command) {
	return HEAP_FLAG.test(command) ? { injectRules: ["node-heap"] } : null;
}

module.exports = { field: "command", noun: "command", decide };
