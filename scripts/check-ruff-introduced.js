#!/usr/bin/env node
const { runCheck } = require("./lib/check");
const { RUFF, readRuffExcludeArgs } = require("./lib/formatters");
const {
	readBlob,
	readRenameSources,
	spawn,
	readStagedDiff,
} = require("./lib/staged");
const { caught } = require("./lib/caught.js");
const { scriptPath } = require("./lib/script-path.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {{ code: string | null, message: string, location?: { row: number, column: number } }} Diagnostic */

const codeOf = (/** @type {Diagnostic} */ d) => d.code ?? "syntax";

/**
 * @param {Diagnostic[]} ds
 */
function byKey(ds) {
	/** @type {Map<string, Diagnostic[]>} */
	const groups = new Map();
	for (const d of ds) {
		const k = `${codeOf(d)}\t${d.message.replace(/\bline \d+/g, "line N")}`;
		groups.set(k, [...(groups.get(k) ?? []), d]);
	}
	return groups;
}

/**
 * @param {Ctx} ctx
 * @param {string} p
 * @param {Diagnostic[]} now
 * @param {Map<string, Diagnostic[]>} had
 */
function chargeIntroduced(ctx, p, now, had) {
	let introduced = 0;
	for (const [k, ds] of byKey(now)) {
		const old = had.get(k)?.length ?? 0;
		const [first] = ds;
		if (first === undefined || ds.length <= old) continue;
		introduced += ds.length - old;
		ctx.fail("INTRODUCED", `${p}: ${ds.length - old} new ${k}`, {
			path: p,
			code: first.code,
			message: first.message,
			introduced: ds.length - old,
		});
		const note =
			old > 0 ? ` (${old} of these ${ds.length} were already in HEAD)` : "";
		ctx.say(`${p}: ${codeOf(first)} ${first.message}${note}`);
		for (const d of ds)
			ctx.say(`  ${p}:${d.location?.row}:${d.location?.column}`);
	}
	return introduced;
}

runCheck({
	name: "ruff-introduced",
	usage: `node ${scriptPath("check-ruff-introduced.js")} [--config <ruff.toml>]`,
	valueFlags: ["--config"],
	run(/** @type {Ctx} */ ctx) {
		const paths = readStagedDiff(ctx, [
			"--name-only",
			"--diff-filter=ACMR",
		]).filter((p) => p.endsWith(".py"));
		if (paths.length === 0) return { okLine: "no staged Python path" };

		const base = ["check", "--output-format", "json", "--exit-zero"];
		const config = ctx.value("--config");
		if (config) base.push("--config", config);
		base.push(...readRuffExcludeArgs((line) => ctx.say(line)));

		/**
		 * @param {string} name
		 * @param {string} source
		 * @returns {Diagnostic[]}
		 */
		const lint = (name, source) => {
			const r = spawn(RUFF, [...base, "--stdin-filename", name, "-"], source);
			if (r.error) ctx.broken(`cannot run ${RUFF}: ${r.error.message}`);
			if (r.status !== 0)
				ctx.broken(`${RUFF} exited ${r.status} on ${name}: ${r.stderr}`);
			try {
				return JSON.parse(r.stdout);
			} catch (e) {
				ctx.broken(`${RUFF} printed no JSON for ${name}: ${caught(e).message}`);
			}
		};

		const sources = readRenameSources(ctx);
		let introduced = 0;

		for (const p of paths) {
			const staged = readBlob(`:${p}`);
			if (staged === null) ctx.broken(`${p} has no staged blob`);
			const now = lint(p, staged);
			if (now.length === 0) continue;

			const before = readBlob(`HEAD:${sources.get(p) ?? p}`);
			const had = byKey(before === null ? [] : lint(p, before));

			introduced += chargeIntroduced(ctx, p, now, had);
		}

		if (introduced > 0)
			return { noun: "ruff finding(s) introduced", count: introduced };
		return {
			okLine: `no ruff finding introduced across ${paths.length} Python path(s)`,
		};
	},
});
