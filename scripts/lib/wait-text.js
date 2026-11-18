/*
 * wait-text.js — what a guard tells a session waiting on something in the
 * background, the parent and a subagent apart (workflow-core#1735, workflow-core#1779). lib/agent-poll.js
 * and lib/echo-call.js both say it, so it is written once.
 *
 * A SUBAGENT IS TOLD OTHERWISE (workflow-core#1169). Its turn ending is its work ending —
 * nothing wakes it to resume — so where the parent is told to end the turn, a
 * subagent is told to wait inside it.
 *
 * Each text names its scripts as `scripts/x`: the caller passes the whole
 * message through `ctx.corePaths`, which spells them at the plugin root in an
 * install, once.
 */

/**
 * Why the parent ending its turn loses nothing, written to continue a clause
 * (`and stop: `) and be continued (`, so …`) (workflow-core#1779).
 */
const PARENT_WAIT =
	"the completion notification wakes the session or, arriving mid-call, is folded into the next tool result (97%, workflow-core#845)";

/**
 * What a subagent is told where the parent is told to end its turn, written to
 * continue a clause (`Instead: `, `then `) (workflow-core#1735).
 */
const SUBAGENT_WAIT =
	"wait inside the turn — what you wait on in the foreground with `timeout: 600000`, a bg-run.sh job with `scripts/bg-run.sh wait <name>`, or the blocked operation retried directly. You are a subagent: ending your turn ends your work for good, since nothing wakes you to resume it.";

/** Where a refusal template holds its wait text, spliced by `withWait`. */
const WAIT_SLOT = "@WAIT@";

/**
 * `template` with its WAIT_SLOT replaced by `wait`, verbatim: a `$` in the
 * wait text is never read as a replacement pattern.
 * @param {string} template
 * @param {string} wait
 */
const withWait = (template, wait) => template.replace(WAIT_SLOT, () => wait);

module.exports = { PARENT_WAIT, SUBAGENT_WAIT, WAIT_SLOT, withWait };
