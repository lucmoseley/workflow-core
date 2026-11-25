#!/usr/bin/env node

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
