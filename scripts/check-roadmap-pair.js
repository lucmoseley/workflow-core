#!/usr/bin/env node
/*
 * check-roadmap-pair.js — pre-commit guard that the roadmap ships with its digest.
 *
 * Usage:
 *   node check-roadmap-pair.js
 *
 * docs/roadmap-digest.md is derived from docs/reference-roadmap.html and the two
 * are only ever correct together. The roadmap-edit skill says to commit them as a
 * pair, and check-digest-version.js catches a mismatched pair in CI — but neither
 * catches the commit that stages the HTML and simply leaves the digest behind.
 * That is exactly the state an interrupted edit loop leaves on disk, and prose in
 * a skill file cannot stop a commit.
 *
 * So: any staged change to the roadmap HTML must be accompanied by a staged
 * change to the digest, in the same commit. This checks the index only — what is
 * about to be committed — not the working tree.
 *
 * The reverse case (digest alone) is an intrinsic WARN, so it exits 0: it is what
 * a legitimate catch-up regeneration looks like, and failing it would block one
 * at .husky/pre-commit (mantahostels#155, the ticket that settled the checker family's
 * exit-code alphabet).
 */

const { execFileSync } = require("node:child_process");
const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");
const { corePath } = require("./lib/script-path.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */

const HTML = "docs/reference-roadmap.html";
const DIGEST = "docs/roadmap-digest.md";
/* The skill ships in the plugin, so an adopter has no .claude/skills/ of its
 * own to run it from (#2234). */
const GENERATOR = corePath(
	".claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js",
);

runCheck({
	name: "roadmap-pair",
	module: "roadmap",
	usage: "node check-roadmap-pair.js",
	run(/** @type {Ctx} */ ctx) {
		let staged;
		try {
			staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
				encoding: "utf8",
			})
				.split("\n")
				.filter(Boolean);
		} catch (e) {
			// The index is repo state, so an unreadable one is BROKEN, not SKIP.
			ctx.broken(`cannot read the git index — ${caught(e).message}`);
		}

		const htmlStaged = staged.includes(HTML);
		const digestStaged = staged.includes(DIGEST);

		if (htmlStaged && !digestStaged) {
			ctx.fail("UNPAIRED", `${HTML} is staged without ${DIGEST}.`);
			// No severity prefix: check.js owns the one `SEVERITY:` line a run emits.
			ctx.say(`${HTML} is staged without ${DIGEST}.`);
			ctx.say("");
			ctx.say("The digest is derived from the HTML and the two are only ever");
			ctx.say("correct together. Regenerate it and commit both:");
			ctx.say("");
			ctx.say(`  node ${GENERATOR} \\`);
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
});
