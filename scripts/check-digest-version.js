#!/usr/bin/env node

const fs = require("node:fs");
const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

const VERSION_RE = /v\d+\.\d+ · updated [^·<\n]+/;

runCheck({
	name: "digest-version",
	module: "roadmap",
	usage: "node check-digest-version.js [<roadmap.html> <digest.md>]",
	run(/** @type {Ctx} */ ctx) {
		const htmlPath = ctx.args[0] || "docs/reference-roadmap.html";
		const digestPath = ctx.args[1] || "docs/roadmap-digest.md";

		const extract = (/** @type {string} */ p, /** @type {string} */ label) => {
			let text;
			try {
				text = fs.readFileSync(p, "utf8");
			} catch (e) {
				ctx.broken(`cannot read ${label} at ${p} — ${caught(e).message}`);
			}
			const m = text.match(VERSION_RE);
			if (!m) ctx.broken(`no version line found in ${label} (${p})`);
			return m[0].trim();
		};

		const htmlVer = extract(htmlPath, "roadmap HTML");
		const digestVer = extract(digestPath, "digest");

		if (htmlVer !== digestVer) {
			ctx.fail(
				"DRIFT",
				"roadmap HTML and digest version lines have drifted.",
				{
					html: htmlVer,
					digest: digestVer,
				},
				`DRIFT\t${digestPath}`,
			);
			ctx.say("The roadmap HTML and digest version lines have drifted.");
			ctx.say(`  HTML   (${htmlPath}):   ${htmlVer}`);
			ctx.say(`  digest (${digestPath}): ${digestVer}`);
			ctx.say(
				"\nThe digest is derived from the HTML by the roadmap-edit skill and the " +
					"two must be committed together. Regenerate the digest from the current " +
					"HTML (gen-roadmap-digest.js) and commit both files.",
			);
			return { noun: "version line(s) drifted" };
		}

		return { okLine: `roadmap HTML and digest agree — ${htmlVer}` };
	},
});
