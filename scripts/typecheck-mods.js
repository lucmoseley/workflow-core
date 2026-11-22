#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { compareVersions } = require("./lib/compare-versions.js");
const { writeFd } = require("./lib/write-fd.js");

const ROOT = process.cwd();
const DELIVERY = ".claude/skills/wfc-delivery";
const LIVENESS = ".claude/skills/wfc-liveness";
const ENGINE_TYPES = ".claude-plugin/types/claude-code/index.d.ts";
const PASSES = [
	{ project: DELIVERY, mod: DELIVERY },
	{ project: LIVENESS, mod: LIVENESS },
	{ project: "hooks", mod: LIVENESS },
];
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const WRITTEN_BY = /^\/\/ Written by Claude Code (\d+\.\d+\.\d+)\./;

/**
 * @param {string} a
 * @param {string} b
 */
function compareVersionText(a, b) {
	const parts = (/** @type {string} */ v) =>
		(VERSION.exec(v) ?? []).slice(1).map(Number);
	return compareVersions(parts(a), parts(b));
}

/** @param {string} dir */
function readEntries(dir) {
	try {
		return fs.readdirSync(dir);
	} catch (e) {
		if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return [];
		throw e;
	}
}

/**
 * @param {string} skillsDir
 * @returns {{ file: string, version: string } | null}
 */
function newestSkillTypes(skillsDir) {
	/** @type {{ file: string, version: string } | null} */
	let best = null;
	for (const version of readEntries(skillsDir)) {
		if (!VERSION.test(version)) continue;
		if (best && compareVersionText(version, best.version) <= 0) continue;
		const file = readEntries(path.join(skillsDir, version))
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
 * @param {string} mod
 * @param {{ file: string, version: string } | null} source
 */
function syncEngineTypes(mod, source) {
	const dest = path.join(ROOT, mod, ENGINE_TYPES);
	if (fs.existsSync(dest)) {
		const have = WRITTEN_BY.exec(fs.readFileSync(dest, "utf8"))?.[1];
		if (!source || (have && compareVersionText(have, source.version) >= 0))
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
	const tsc = path.join(
		path.dirname(require.resolve("@typescript/native/package.json")),
		"bin",
		"tsc",
	);
	const checkers = process.env.npm_package_config_tscCheckers;
	let failed = false;
	for (const { project, mod } of PASSES) {
		if (!ready.get(mod)) {
			writeFd(
				2,
				`typecheck-mods: SKIPPED ${project} — no ${mod}/${ENGINE_TYPES} and no unpacked plugin-authoring skill to copy it from (#1960)\n`,
			);
			continue;
		}
		const r = spawnSync(
			process.execPath,
			[tsc, "-p", project, ...(checkers ? ["--checkers", checkers] : [])],
			{
				encoding: "utf8",
				maxBuffer: CHILD_MAX_BUFFER,
			},
		);
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
