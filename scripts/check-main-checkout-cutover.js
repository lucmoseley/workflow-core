#!/usr/bin/env node
/*
 * check-main-checkout-cutover.js — cut the main checkout over to the worktree
 * model at session start, where it still runs as one shared tree (workflow-core#4688,
 * workflow-core#5276).
 *
 * Usage:  node scripts/check-main-checkout-cutover.js [--notify] [--json]
 *
 * WFC_REPO_ROOT injects the repo.
 *
 * IMPLICIT:  at every session start (`--notify`), reads the main checkout's upstream; where it is not cut over, lists the live sessions (`claude agents --json`) and, where none stands in the main checkout, runs the cutover (lib/cutover-run.js) — landing the main checkout's local commits through a queue ref, removing `main`'s upstream and running a levelling pass — and prints its report; where one does, prints a FAIL naming each; prints nothing once cut over. Run without `--notify`, as `npm run status` does, it reports a main checkout not cut over and cuts nothing.
 * JUSTIFIED: fail-safe — otherwise a repo whose main checkout was never cut over shares one unguarded tree with nothing moving it (workflow-core#4688), and the cutover waits on the founder's hands (workflow-core#5247 Q1 (A)).
 * DEFEAT:    none at the hook; the cutover clears it.
 * TIMEOUT:   its hook allows 300 s. Untraced: a cutover's land, fetch and
 *            levelling pass run once per repo, and 300 s is a guess at their
 *            ceiling; the cut-over fast path is one `git config` read.
 * TREE:      host — reads and cuts over the main checkout
 */

const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");
const { readCutOver } = require("./lib/cutover.js");
const { runCutover } = require("./lib/cutover-run.js");
const { GIT_TIMEOUT_MS, gitReader } = require("./lib/git.js");
const { hostRoot } = require("./lib/host-root.js");
const { judgeCutover } = require("./lib/main-checkout-cutover.js");
const { mainCheckout } = require("./lib/main-checkout.js");

runCheck({
	name: "main-checkout-cutover",
	usage: "node check-main-checkout-cutover.js [--notify] [--json]",
	run(ctx) {
		const at = process.env.WFC_REPO_ROOT || hostRoot();
		const root = mainCheckout(at) ?? at;
		const judged = (() => {
			try {
				return judgeCutover({
					cutOver: () => readCutOver(gitReader(root, GIT_TIMEOUT_MS)),
					runCutover: ctx.notify ? () => runCutover(root) : undefined,
				});
			} catch (e) {
				return ctx.broken(`the cutover failed: ${caught(e).message.trim()}`);
			}
		})();
		if (judged.outcome === "broken") return ctx.broken(judged.line);
		if (judged.outcome === "skip") return ctx.skip(judged.line);
		if (judged.outcome === "ok") {
			for (const line of judged.lines) ctx.say(line);
			return { okLine: judged.line };
		}
		ctx.fail(judged.tag, judged.line);
		ctx.say(`${judged.tag} — ${judged.line}`);
		return { noun: "shared-tree exposure(s)" };
	},
});
