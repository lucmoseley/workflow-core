#!/usr/bin/env node
/*
 * check-ruff-introduced.js — the pre-commit Python gate's judge: it refuses
 * the ruff findings a commit INTRODUCES, never the ones it inherits (#122).
 *
 * Usage:
 *   node scripts/check-ruff-introduced.js [--config <ruff.toml>]
 *
 * Each staged .py path is linted twice — its STAGED blob and its HEAD blob (a
 * staged rename's source, for a renamed path) — and only the excess is charged. The staged blob, not the worktree copy, because it is
 * what the commit carries. The paths are read here, NUL-separated, rather than
 * handed over by the hook, where word-splitting broke a path holding a space.
 *
 * A FINDING IS KEYED BY RULE CODE AND MESSAGE, NEVER BY LINE: any edit above a
 * finding moves it, and a keyed-by-line diff would charge that move. For the
 * same reason a `line <n>` inside a message — F811's `from line 1` — is
 * blanked before keying. A key the staged blob holds more of than HEAD's is
 * introduced. The residual is the count: a commit that removes one
 * `Undefined name \`x\`` and adds another elsewhere is charged nothing.
 *
 * Both blobs go to ruff on stdin under the path's own name, so config
 * discovery, per-file-ignores and exclusion all see the real path — so long
 * as ruff runs from the repo root, as the hook does: from elsewhere, stdin
 * discovery diverged from path discovery.
 *
 * EXCLUSIONS. `ruffExclude` in .claude/workflow-core.json — ruff glob
 * patterns, handed over as --extend-exclude — lets an adopter take vendored
 * code, which is not its own to fix (#1463), out of the gate without a root
 * ruff.toml, which would switch off the
 * plugin's --config and have to copy its select (#122). --force-exclude is
 * passed always, so a host's own `exclude` binds the gate as it binds
 * `ruff check .`.
 *
 * ruff is `WFC_RUFF` where set, else `ruff` on PATH (§N7).
 */

const { runCheck } = require("./lib/check");
const { RUFF, ruffExcludeArgs } = require("./lib/formatters");
const { blob, renameSources, spawn, stagedDiff } = require("./lib/staged");
const { caught } = require("./lib/caught.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
/** @typedef {{ code: string | null, message: string, location?: { row: number, column: number } }} Diagnostic */

const codeOf = (/** @type {Diagnostic} */ d) => d.code ?? "syntax";

/**
 * Diagnostics grouped by their line-free key.
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
 * Charge each key the staged blob holds more of than HEAD's, listing every
 * diagnostic under it; returns how many were introduced.
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
		// Which of the n is new cannot be told apart, so every one is listed.
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
	usage: "node scripts/check-ruff-introduced.js [--config <ruff.toml>]",
	valueFlags: ["--config"],
	run(/** @type {Ctx} */ ctx) {
		const paths = stagedDiff(ctx, ["--name-only", "--diff-filter=ACMR"]).filter(
			(p) => p.endsWith(".py"),
		);
		if (paths.length === 0) return { okLine: "no staged Python path" };

		const base = ["check", "--output-format", "json", "--exit-zero"];
		const config = ctx.value("--config");
		if (config) base.push("--config", config);
		base.push(...ruffExcludeArgs((line) => ctx.say(line)));

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

		const sources = renameSources(ctx);
		let introduced = 0;

		for (const p of paths) {
			const staged = blob(`:${p}`);
			if (staged === null) ctx.broken(`${p} has no staged blob`);
			const now = lint(p, staged);
			if (now.length === 0) continue;

			const before = blob(`HEAD:${sources.get(p) ?? p}`);
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
