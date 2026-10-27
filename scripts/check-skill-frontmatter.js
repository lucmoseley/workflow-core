#!/usr/bin/env node
/*
 * check-skill-frontmatter.js — refuses an own skill whose frontmatter a strict
 * YAML parser rejects (workflow-core#887).
 *
 * Usage:
 *   node check-skill-frontmatter.js [--root <dir>] [--against <rev>] [--json] [--warn]
 *
 * Claude Code tolerates a `description:` holding an unquoted `: `; js-yaml, and
 * so `npx skills` discovery and any strict-YAML reader, rejects it and drops
 * the skill silently.
 *
 * SHIPS, AND READS js-yaml FROM THE ADOPTER'S OWN INSTALL through
 * lib/host-package.js (workflow-core#1380). Where it is absent the run is BROKEN, naming
 * the install, and the commit is refused: lacking the parser is no reason to
 * stop checking.
 *
 * SCOPE is the own skills only: a symlinked `.claude/skills/<name>` is
 * vendored, and an edit there is lost on the next vendor pull.
 *
 * IMPLICIT:  on every commit staging an own .claude/skills/<name>/SKILL.md, refuses one whose frontmatter js-yaml rejects, naming the file and the line:column.
 * JUSTIFIED: fail-safe — a skill a strict reader drops is invisible to it, and nothing reports the loss; the fix is quoting one value.
 * DEFEAT:    --warn caps findings below the gating line.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostPackage } = require("./lib/host-package.js");
const { hostRoot } = require("./lib/host-root.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");

const SKILLS_DIR = path.join(".claude", "skills");

/**
 * The frontmatter's text, or null where the body opens with no `---` line.
 * `unclosed` where it opens and never closes, which a strict reader drops as
 * surely as a parse error. A BOM and trailing blanks on a fence are ignored,
 * as gray-matter-style readers ignore them.
 *
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
 * Where js-yaml (or the fence) rejects one body, and what to do about it, or
 * null where it parses. A body with no frontmatter is no parse failure: a
 * strict reader takes it as empty data, and a missing name or description is
 * not this checker's subject.
 *
 * @param {string} body
 * @param {any} yaml js-yaml, untyped
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
		/* Narrowed by the line above: js-yaml ships no types to narrow it with. */
		const { mark, reason } =
			/** @type {{ mark: { line: number, column: number }, reason: string }} */ (
				e
			);
		return {
			/* js-yaml counts from 0 within the frontmatter; the file's own line is
			 * two further on, past the opening `---`. */
			at: `${mark.line + 2}:${mark.column + 1}`,
			reason: `js-yaml: ${reason}`,
			/* workflow-core#885's shape: an unquoted `: ` inside a value. */
			fix: /bad indentation of a mapping entry/.test(reason)
				? "double-quote that value (as workflow-core#885 did)"
				: "correct the YAML at that position",
		};
	}
}

/**
 * js-yaml from the repo's own install, resolved from the repo root and never
 * --root: --against and the post-commit reporter point --root at a temp copy,
 * which has no install.
 *
 * @param {Ctx} ctx
 * @returns {any} js-yaml, untyped
 */
function loadYaml(ctx) {
	const loaded = hostPackage("js-yaml", __dirname);
	if (!loaded.ok) ctx.broken(loaded.message);
	return loaded.module;
}

runCheck({
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
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		if (!fs.existsSync(root))
			ctx.broken(`the host root ${root} does not exist — nothing was parsed`);
		const dir = path.join(root, SKILLS_DIR);
		/* No skills directory is zero skills, not SKIP: a SKIP on the HEAD side
		 * of --against is BROKEN, which would refuse the first skill ever added. */
		const names = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];

		/* Loaded at the first own skill, so a repo with none never needs it. */
		/** @type {any} */
		let yaml;
		let parsed = 0;
		for (const name of names) {
			const rel = path.join(SKILLS_DIR, name, "SKILL.md");
			const at = path.join(root, rel);
			/* A symlink at either level is vendored, and under --against it lands
			 * dangling, so skipping it here keeps both modes reading one set. */
			const skillDir = fs.lstatSync(path.join(dir, name));
			if (skillDir.isSymbolicLink() || !skillDir.isDirectory()) continue;
			if (!fs.existsSync(at) || fs.lstatSync(at).isSymbolicLink()) continue;
			parsed++;
			yaml ??= loadYaml(ctx);
			const found = rejection(fs.readFileSync(at, "utf8"), yaml);
			if (found === null) continue;
			const message = `${rel}:${found.at} — ${found.reason}. Fix: ${found.fix}. A strict YAML reader drops this skill (workflow-core#887).`;
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
});
