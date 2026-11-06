/*
 * core-contract.js — what a guard dispatcher core is handed and what it
 * answers (#2786, ADR-0010): the contract every core types against, apart
 * from lib/guard-judge.js's judging, so the judging can move without
 * touching the cores (#4543).
 *
 * The ports beyond the kit's are lib/guard-host-ports.js's, beside the
 * adapters that fill them.
 */

/**
 * @typedef {import("./kit-context.js").KitContext} KitContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {import("./guard-cores.js").CoreRow} CoreRow
 * @typedef {import("./guard-host-ports.js").TreePorts} TreePorts
 * @typedef {import("./guard-host-ports.js").CorePorts} CorePorts
 * @typedef {(NonNullable<Decision> & { updatedInput?: Record<string, unknown> }) | null} CoreDecision
 *   a guard decision, a context under the persist room; either beside a
 *   context may carry the tool input the call runs with instead, allowed
 *   (vendor §PreToolUse decision control)
 * @typedef {KitContext & CorePorts & { session: string,
 *   tree: () => TreePorts }} CoreContext
 *   `session` is the payload's session id, "" where it carries none. `tree`
 *   is the session's tree (lib/host-root.js `sessionTree`): what a core reads
 *   for `git status`, `HEAD`, the index or working files, which in a linked
 *   worktree is that worktree and never the host. Resolved on first call; it
 *   throws where git names no top level, a repo fault the core is allowed on,
 *   logged (#4242). Each row's `tree` in lib/guard-cores.json records which
 *   of the two its core reads.
 * @typedef {CoreRow & { field: string | string[], noun: string, top?: boolean,
 *   decide: (subject: string, ctx: CoreContext) => CoreDecision }} LoadedCore
 * @typedef {CoreRow & { loadFault: string }} UnloadedCore a row whose module
 *   threw on require, carrying what to say when the row comes to run
 * @typedef {LoadedCore | UnloadedCore} Core
 */

module.exports = {};
