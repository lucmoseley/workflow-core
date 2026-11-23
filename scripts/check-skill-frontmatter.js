#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { hostPackage } = require("./lib/host-package.js");
const { worktreeRoot } = require("./lib/host-root.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
const { runCheck } = require("./lib/check");

const SKILLS_DIR = path.join(".claude", "skills");

/**
 * @param {string} body
 * @returns {{ text: string, unclosed: boolean } | null}
 */
function parseFrontmatter(body) {
	const lines = body.replace(/^\uFEFF/, "").split(/\r?\n/);
	const fence = (/** @type {string} */ line) => line.trimEnd() === "---";
	const [first] = lines;
	if (first === undefined || !fence(first)) return null;
	const end = lines.findIndex((line, i) => i > 0 && fence(line));
	if (end === -1) return { text: "", unclosed: true };
	return { text: lines.slice(1, end).join("\n"), unclosed: false };
}

/**
 * @param {string} body
 * @param {any} yaml
 * @returns {{ at: string, reason: string, fix: string } | null}
 */
function rejection(body, yaml) {
	const fm = parseFrontmatter(body);
	if (fm === null) return null;
	if (fm.unclosed)
		return {
			at: "1:1",
			reason: "the frontmatter opens with --- and never closes",
			fix: "close it with a --- line",
		};
	try {
		yaml.load(fm.text);
		return null;
	} catch (e) {
		if (!(e instanceof yaml.YAMLException)) throw e;
		const { mark, reason } =
			/** @type {{ mark: { line: number, column: number }, reason: string }} */ (
				e
			);
		return {
			at: `${mark.line + 2}:${mark.column + 1}`,
			reason: `js-yaml: ${reason}`,
			fix: /bad indentation of a mapping entry/.test(reason)
				? "double-quote that value (as #885 did)"
				: "correct the YAML at that position",
		};
	}
}

/**
 * @param {Ctx} ctx
 * @returns {any}
 */
function loadYaml(ctx) {
	const loaded = hostPackage("js-yaml", __dirname);
	if (!loaded.ok) ctx.broken(loaded.message);
	return loaded.module;
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "skill-frontmatter",
	usage:
		"node check-skill-frontmatter.js [--root <dir>] [--against <rev>] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "skill-frontmatter",
		materialise: "blobs",
		pathspecs: () => [".claude/skills"],
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? worktreeRoot());
		if (!fs.existsSync(root))
			ctx.broken(`the root ${root} does not exist — nothing was parsed`);
		const dir = path.join(root, SKILLS_DIR);
		const names = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];

		/** @type {any} */
		let yaml;
		let parsed = 0;
		for (const name of names) {
			const rel = path.join(SKILLS_DIR, name, "SKILL.md");
			const at = path.join(root, rel);
			const skillDir = fs.lstatSync(path.join(dir, name));
			if (skillDir.isSymbolicLink() || !skillDir.isDirectory()) continue;
			if (!fs.existsSync(at) || fs.lstatSync(at).isSymbolicLink()) continue;
			parsed++;
			yaml ??= loadYaml(ctx);
			const found = rejection(fs.readFileSync(at, "utf8"), yaml);
			if (found === null) continue;
			const message = `${rel}:${found.at} — ${found.reason}. Fix: ${found.fix}. A strict YAML reader drops this skill (#887).`;
			ctx.fail("SKILL-FRONTMATTER", message, { file: rel, at: found.at });
			ctx.say(`  ${message}`);
		}
		return {
			okLine: `${parsed} own skill(s), every frontmatter parsing under js-yaml.`,
			noun: "skill frontmatter block(s) js-yaml rejects",
			count: ctx.findings.length,
			data: { parsed },
		};
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
