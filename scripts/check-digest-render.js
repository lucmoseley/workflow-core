#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runCheck } = require("./lib/check");
const { coreRoot } = require("./lib/script-path");
const { caught } = require("./lib/caught.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

// guess, lucmoseley/mantahostels#2890
const MAX_QUOTED_LINES = 5;

const MAX_RENDER_BYTES = 32 * 1024 * 1024;

const GEN_REL = ".claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js";

function defaultGenerator() {
	if (fs.existsSync(GEN_REL)) return GEN_REL;
	return path.join(coreRoot(), GEN_REL);
}

/**
 * @param {Ctx} ctx
 * @param {string} genPath
 * @param {string} htmlPath
 * @returns {string}
 */
function render(ctx, genPath, htmlPath) {
	const r = spawnSync(process.execPath, [genPath, htmlPath, "--stdout"], {
		encoding: "utf8",
		maxBuffer: MAX_RENDER_BYTES,
		env: { ...process.env, WFC_CORE_SCRIPTS_DIR: __dirname },
	});
	if (r.error) ctx.broken(`could not run ${genPath} — ${r.error.message}`);
	if (r.status !== 0)
		ctx.broken(
			`${genPath} ${r.signal ? `died to ${r.signal}` : `exited ${r.status}`} ` +
				`rendering ${htmlPath} — ` +
				`${(r.stderr || "").trim() || "no stderr"}`,
		);

	return r.stdout;
}

/**
 * @param {Ctx} ctx
 * @param {{ committed: string, rendered: string, digestPath: string, genPath: string, htmlPath: string }} pair
 */
function reportDrift(
	ctx,
	{ committed, rendered, digestPath, genPath, htmlPath },
) {
	const have = committed.split("\n");
	const want = rendered.split("\n");
	const differing = [];
	for (let i = 0; i < Math.max(have.length, want.length); i++)
		if (have[i] !== want[i]) differing.push(i + 1);

	ctx.fail(
		"DIGEST-DRIFT",
		`${digestPath} is not what the generator renders.`,
		{
			digest: digestPath,
			generator: genPath,
			differingLines: differing.length,
		},
		`DIGEST-DRIFT\t${digestPath}`,
	);
	ctx.say(
		`${digestPath} differs from what ${genPath} renders from ${htmlPath} ` +
			`— ${differing.length} line(s), ${have.length} in the file against ` +
			`${want.length} rendered.`,
	);
	for (const n of differing.slice(0, MAX_QUOTED_LINES)) {
		ctx.say(`  line ${n}:`);
		ctx.say(`    in file:  ${have[n - 1] ?? "(no such line)"}`);
		ctx.say(`    rendered: ${want[n - 1] ?? "(no such line)"}`);
	}
	if (differing.length > MAX_QUOTED_LINES)
		ctx.say(`  … and ${differing.length - MAX_QUOTED_LINES} more.`);
	ctx.say(
		"\nThe digest is generated, not hand-written (docs/doc-map.md §A, " +
			"class `derived`). Put the change in the roadmap HTML through the " +
			"roadmap-edit skill, then regenerate:\n" +
			`  node ${genPath} ${htmlPath} --out ${digestPath}\n` +
			"and commit the pair together.",
	);
}

runCheck({
	name: "digest-render",
	module: "roadmap",
	usage:
		"node check-digest-render.js [<roadmap.html> [<digest.md> [<generator.js>]]]",
	run(/** @type {Ctx} */ ctx) {
		const htmlPath = ctx.args[0] || "docs/reference-roadmap.html";
		const digestPath = ctx.args[1] || "docs/roadmap-digest.md";
		const genPath = ctx.args[2] || defaultGenerator();

		if (!fs.existsSync(genPath))
			ctx.broken(`cannot find the digest generator at ${genPath}`);

		let committed;
		try {
			committed = fs.readFileSync(digestPath, "utf8");
		} catch (e) {
			ctx.broken(`cannot read digest at ${digestPath} — ${caught(e).message}`);
		}

		const rendered = render(ctx, genPath, htmlPath);
		if (rendered === committed)
			return {
				okLine: `${digestPath} is what ${genPath} renders from ${htmlPath}.`,
			};

		reportDrift(ctx, { committed, rendered, digestPath, genPath, htmlPath });
		return { noun: "digest line(s) not from the generator" };
	},
});
