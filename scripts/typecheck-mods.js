#!/usr/bin/env node
/*
 * typecheck-mods.js — `npm run typecheck`'s mod passes (#854, #865, #946):
 * `tsc -p` over the delivery and liveness mods and the plugin's entry module,
 * each against Claude Code's own type declarations.
 *
 * THOSE DECLARATIONS ARE NEVER TRACKED (#1960). Claude Code is proprietary and
 * the file carries no grant to redistribute it, so each mod's
 * `.claude-plugin/types/claude-code/index.d.ts` is gitignored and copied here,
 * before the passes, from the newest `plugin-authoring` skill Claude Code has
 * unpacked on this machine — `<temp root>/claude-<uid>/bundled-skills/
 * <version>/<hash>/plugin-authoring/types/claude-code.d.ts`, the temp root
 * being CLAUDE_CODE_TMPDIR, else os.tmpdir(), as Claude Code 2.1.302 resolves
 * its own. A copy older than that skill is replaced. The engine writes no such
 * file for a `@skills-dir` mod (#851).
 *
 * WARNS AND SKIPS a pass whose declarations exist neither in the mod nor in any
 * unpacked skill — CI's runner, and a machine whose Claude Code has not yet
 * unpacked `plugin-authoring` (a session invoking that skill unpacks it). The
 * passes are then unrun, said so on stderr, and the exit is 0.
 *
 * IN NO `scripts/` FAMILY (§N3): it gates, which no `generate-*` does, on
 * tsc's own verdict and output, which runCheck's alphabet would only rename.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { writeFd } = require("./lib/write-fd.js");

/* npm runs a script from the package root; a pre-commit run there is the
 * commit's own worktree, which CLAUDE_PROJECT_DIR would name wrongly. */
const ROOT = process.cwd();
const DELIVERY = ".claude/skills/wfc-delivery";
const LIVENESS = ".claude/skills/wfc-liveness";
const ENGINE_TYPES = ".claude-plugin/types/claude-code/index.d.ts";
/* Each tsconfig, and the mod whose engine types it reads: hooks/tsconfig.json
 * includes the liveness mod's. */
const PASSES = [
	{ project: DELIVERY, mod: DELIVERY },
	{ project: LIVENESS, mod: LIVENESS },
	{ project: "hooks", mod: LIVENESS },
];
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
/* The declarations' first line, as every build since 2.1.289 writes it. */
const WRITTEN_BY = /^\/\/ Written by Claude Code (\d+\.\d+\.\d+)\./;

/** @param {string} a @param {string} b both matching VERSION */
function compareVersions(a, b) {
	const [, ...x] = VERSION.exec(a) ?? [];
	const [, ...y] = VERSION.exec(b) ?? [];
	const d = x.map((n, i) => Number(n) - Number(y[i])).find((n) => n !== 0);
	return d ?? 0;
}

/** @param {string} dir a directory's entries; none where it does not exist */
function entries(dir) {
	try {
		return fs.readdirSync(dir);
	} catch (e) {
		if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return [];
		throw e;
	}
}

/**
 * The newest unpacked `plugin-authoring` declarations under `skillsDir`, or
 * null where none is unpacked.
 * @param {string} skillsDir
 * @returns {{ file: string, version: string } | null}
 */
function newestSkillTypes(skillsDir) {
	/** @type {{ file: string, version: string } | null} */
	let best = null;
	for (const version of entries(skillsDir)) {
		if (!VERSION.test(version)) continue;
		if (best && compareVersions(version, best.version) <= 0) continue;
		const file = entries(path.join(skillsDir, version))
			.map((hash) =>
				path.join(
					skillsDir,
					version,
					hash,
					"plugin-authoring/types/claude-code.d.ts",
				),
			)
			.find((f) => fs.existsSync(f));
		if (file) best = { file, version };
	}
	return best;
}

/**
 * Brings `mod`'s engine types up to `source`, where it holds none or an older
 * copy. True where the mod then holds declarations.
 * @param {string} mod
 * @param {{ file: string, version: string } | null} source
 */
function syncEngineTypes(mod, source) {
	const dest = path.join(ROOT, mod, ENGINE_TYPES);
	if (fs.existsSync(dest)) {
		const have = WRITTEN_BY.exec(fs.readFileSync(dest, "utf8"))?.[1];
		if (!source || (have && compareVersions(have, source.version) >= 0))
			return true;
	} else if (!source) return false;
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(source.file, dest);
	return true;
}

function main() {
	const tempRoot = process.env.CLAUDE_CODE_TMPDIR || os.tmpdir();
	const source = newestSkillTypes(
		path.join(tempRoot, `claude-${os.userInfo().uid}`, "bundled-skills"),
	);
	/** @type {Map<string, boolean>} */
	const ready = new Map();
	for (const { mod } of PASSES)
		if (!ready.has(mod)) ready.set(mod, syncEngineTypes(mod, source));
	const tsc = require.resolve("typescript/bin/tsc");
	let failed = false;
	for (const { project, mod } of PASSES) {
		if (!ready.get(mod)) {
			writeFd(
				2,
				`typecheck-mods: SKIPPED ${project} — no ${mod}/${ENGINE_TYPES} and no unpacked plugin-authoring skill to copy it from (#1960)\n`,
			);
			continue;
		}
		const r = spawnSync(process.execPath, [tsc, "-p", project], {
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
		});
		if (r.error) {
			writeFd(2, `typecheck-mods: tsc did not run (${r.error.message})\n`);
			failed = true;
			continue;
		}
		writeFd(1, r.stdout);
		writeFd(2, r.stderr);
		if (r.status !== 0) failed = true;
	}
	process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { main };
