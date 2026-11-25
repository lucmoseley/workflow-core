#!/usr/bin/env node

const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");
const { corePath } = require("./lib/script-path.js");
const { execGit } = require("./lib/git.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

const HTML = "docs/reference-roadmap.html";
const DIGEST = "docs/roadmap-digest.md";
const generator = () =>
	corePath(".claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js");

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "roadmap-pair",
	module: "roadmap",
	usage: "node check-roadmap-pair.js",
	run(/** @type {Ctx} */ ctx) {
		let staged;
		try {
			staged = execGit(["diff", "--cached", "--name-only"], {
				encoding: "utf8",
			})
				.split("\n")
				.filter(Boolean);
		} catch (e) {
			ctx.broken(`cannot read the git index — ${caught(e).message}`);
		}

		const htmlStaged = staged.includes(HTML);
		const digestStaged = staged.includes(DIGEST);

		if (htmlStaged && !digestStaged) {
			ctx.fail("UNPAIRED", `${HTML} is staged without ${DIGEST}.`);
			ctx.say(`${HTML} is staged without ${DIGEST}.`);
			ctx.say("");
			ctx.say("The digest is derived from the HTML and the two are only ever");
			ctx.say("correct together. Regenerate it and commit both:");
			ctx.say("");
			ctx.say(`  node ${generator()} \\`);
			ctx.say(`    ${HTML} --out ${DIGEST}`);
			ctx.say(`  git commit -m "<what changed> (vX.YY)" -- ${HTML} ${DIGEST}`);
			ctx.say("");
			ctx.say(
				"Never hand-edit the digest, and do not reach for --no-verify: since",
			);
			ctx.say(
				"mantahostels#975 the commit guard denies that flag to an agent session.",
			);
			return { noun: "roadmap edit(s) staged without the digest" };
		}

		if (digestStaged && !htmlStaged) {
			ctx.warn(
				"CATCH-UP",
				`${DIGEST} is staged without ${HTML} — fine if this is a catch-up regeneration, wrong if the HTML change was forgotten.`,
			);
			ctx.say(
				`${DIGEST} is staged without ${HTML} — fine if this is a catch-up regeneration, wrong if the HTML change was forgotten.`,
			);
			return { noun: "digest staged on its own" };
		}

		return { okLine: "the roadmap and its digest are staged together." };
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
