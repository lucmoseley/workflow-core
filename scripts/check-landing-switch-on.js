#!/usr/bin/env node
/*
 * check-landing-switch-on.js — cut the main checkout over to the worktree
 * model at session start, where it still runs as one shared tree (#4688,
 * #5276).
 *
 * Usage:  node scripts/check-landing-switch-on.js [--notify] [--json]
 *
 * WFC_REPO_ROOT injects the repo.
 *
 * IMPLICIT:  at every session start, reads the main checkout's upstream; where it is not cut over, lists the live sessions (`claude agents --json`) and, where none stands in the main checkout, runs `cutover-main-checkout.js`'s cutover — landing the main checkout's local commits through a queue ref, removing `main`'s upstream and running a levelling pass — and prints its report; where one does, prints a FAIL naming each; prints nothing once cut over.
 * JUSTIFIED: fail-safe — otherwise a repo whose main checkout was never cut over shares one unguarded tree with nothing moving it (#4688), and the cutover waits on the founder's hands, the step that went missing (#5247 Q1 (A)).
 * DEFEAT:    none at the hook; the cutover clears it.
 * TREE:      host — reads and cuts over the main checkout
 */

const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");
const { readCutOver } = require("./lib/cutover.js");
const { GIT_TIMEOUT_MS, gitReader } = require("./lib/git.js");
const { hostRoot } = require("./lib/host-root.js");
const { judgeSwitchOn } = require("./lib/landing-switch-on.js");
const { mainCheckout } = require("./lib/main-checkout.js");
const { runCutover } = require("./cutover-main-checkout.js");

runCheck({
	name: "landing-switch-on",
	usage: "node check-landing-switch-on.js [--notify] [--json]",
	run(ctx) {
		const at = process.env.WFC_REPO_ROOT || hostRoot();
		const root = mainCheckout(at) ?? at;
		const judged = (() => {
			try {
				return judgeSwitchOn({
					cutOver: () => readCutOver(gitReader(root, GIT_TIMEOUT_MS)),
					runCutover: () => runCutover(root),
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
