#!/usr/bin/env node
/*
 * check-digest-render.js — the digest's bytes are what its generator renders.
 *
 * Usage:
 *   node check-digest-render.js [<roadmap.html> [<digest.md> [<generator.js>]]]
 *   (defaults: docs/reference-roadmap.html docs/roadmap-digest.md
 *    .claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js, else the
 *    core's own copy)
 *
 * docs/roadmap-digest.md is `derived` in docs/doc-map.md §A: only
 * gen-roadmap-digest.js may write it. Two guards already sat next to that
 * claim and neither enforced it — check-roadmap-pair.js refuses the
 * half-staged pair, check-digest-version.js refuses a drifted version line —
 * so a hand-edit preserving the version stamp passed both (mantahostels#2890). This is
 * §A's own shape (check-doc-map.js assertion 17): render fresh from the
 * source of truth, and refuse bytes that differ.
 *
 * It runs the generator with --stdout, which writes nothing and takes no
 * file-claim; --out is the only branch that does either.
 *
 * A generator that will not run is BROKEN, not a finding: nothing was
 * compared, so there is no verdict about the digest (scripts/lib/check.js for
 * the alphabet). The digest is tracked, so an unreadable one is BROKEN too.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runCheck } = require("./lib/check");
const { coreRoot } = require("./lib/script-path");
const { caught } = require("./lib/caught.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */

/* How many differing lines the failure quotes before it stops. A GUESS, and
 * stated as one: the digest is one line per card, so a real hand-edit touches
 * one or two lines and never reaches this, while a whole-file rewrite differs
 * on all ~170 and quoting them buries the fault. Nothing measured picks 5. */
const MAX_QUOTED_LINES = 5;

/* docs/roadmap-digest.md is 34 KB today (`wc -c`, v6.75, 172 lines). The
 * ceiling is for a roadmap that grows: an ENOBUFS truncation would read as a
 * content difference and report the wrong fault, so give it room the file
 * cannot plausibly reach. */
const MAX_RENDER_BYTES = 32 * 1024 * 1024;

const GEN_REL = ".claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js";

/* Run bare in a host with no generator, the checker reads the core's own copy
 * (#649) — an install's, or a source checkout's run against another repo
 * (#1549), which renders with the checkout's generator rather than the one
 * that repo pins, so a generator change not yet released can read as drift
 * there. A host copy still wins, unlike the pre-commit gate, which prefers
 * the plugin's even over a copy a cut is deleting. In the core's own checkout
 * the two are one file, so a missing one stays BROKEN. */
function defaultGenerator() {
	if (fs.existsSync(GEN_REL)) return GEN_REL;
	return path.join(coreRoot(), GEN_REL);
}

/**
 * The generator's --stdout render of htmlPath; BROKEN where it will not run.
 *
 * @param {Ctx} ctx
 * @param {string} genPath
 * @param {string} htmlPath
 * @returns {string}
 */
function render(ctx, genPath, htmlPath) {
	/* process.execPath, not "node": the hook runs under whatever node started
	 * this checker, and a PATH `node` need not be the same one. */
	/* WFC_CORE_SCRIPTS_DIR: pre-commit hands this checker a staged COPY of the
	 * generator, whose relative require of the config reader resolves to
	 * nothing from a temp dir. */
	const r = spawnSync(process.execPath, [genPath, htmlPath, "--stdout"], {
		encoding: "utf8",
		maxBuffer: MAX_RENDER_BYTES,
		env: { ...process.env, WFC_CORE_SCRIPTS_DIR: __dirname },
	});
	if (r.error) ctx.broken(`could not run ${genPath} — ${r.error.message}`);
	/* `r.signal` where a signal killed it: spawnSync reports status null
	 * there, and "exited null" names nothing a reader can act on. */
	if (r.status !== 0)
		ctx.broken(
			`${genPath} ${r.signal ? `died to ${r.signal}` : `exited ${r.status}`} ` +
				`rendering ${htmlPath} — ` +
				`${(r.stderr || "").trim() || "no stderr"}`,
		);

	return r.stdout;
}

/**
 * Fails DIGEST-DRIFT and quotes the first differing lines.
 *
 * @param {Ctx} ctx
 * @param {{ committed: string, rendered: string, digestPath: string, genPath: string, htmlPath: string }} pair
 */
function reportDrift(
	ctx,
	{ committed, rendered, digestPath, genPath, htmlPath },
) {
	/* Line-by-line, not a byte offset: the digest is one line per card, so a
	 * line number sends the reader to the card that differs. */
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
