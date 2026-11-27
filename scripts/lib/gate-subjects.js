const { sectionBEntryCount } = require("./doc-map.js");
const { brandSheetPath } = require("./workflow-core-config.js");
const { COLLECTED_TEST } = require("./test-kind.js");
const { spawnGitSync } = require("./git.js");

const ROADMAP = "docs/reference-roadmap.html";
const MANUAL = "docs/operating-manual.md";
const DOC_MAP = "docs/doc-map.md";
const SITE_DIR = "app/";

/**
 * @typedef {"tests"|"roadmap"|"governance"|"site"} Subject
 * @typedef {{subject: "tests", command: "test", found: string[]}} CommandFound
 * @typedef {{subject: Exclude<Subject, "tests">,
 *   module: import("./workflow-core-config.js").Module, found: string[]}} ModuleFound
 * @typedef {CommandFound | ModuleFound} Found
 */

/**
 * @param {string} root
 * @param {string[]} args
 */
function git(root, args) {
	const r = spawnGitSync(args, {
		cwd: root,
		encoding: "utf8",
	});
	if (r.error || r.status !== 0)
		throw new Error(
			`git ${args.join(" ")} failed in ${root}: ${r.error?.message ?? r.stderr.trim()}`,
		);
	return r.stdout;
}

/**
 * @param {string} root
 * @returns {Found[]}
 */
function readIndexSubjects(root) {
	const files = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
	const tracked = new Set(files);
	const brandSheet = brandSheetPath({ root });
	/** @type {Found[]} */
	const out = [];
	const tests = files.filter((f) => COLLECTED_TEST.test(f));
	if (tests.length > 0)
		out.push({ subject: "tests", command: "test", found: tests });
	if (tracked.has(ROADMAP))
		out.push({ subject: "roadmap", module: "roadmap", found: [ROADMAP] });
	const governance = [
		...(tracked.has(MANUAL) ? [MANUAL] : []),
		...(tracked.has(DOC_MAP) &&
		sectionBEntryCount(git(root, ["cat-file", "blob", `:${DOC_MAP}`])) > 0
			? [`${DOC_MAP} §B`]
			: []),
	];
	if (governance.length > 0)
		out.push({
			subject: "governance",
			module: "governance",
			found: governance,
		});
	const pages = files.filter((f) => f.startsWith(SITE_DIR));
	if (tracked.has(brandSheet) && pages.length > 0)
		out.push({
			subject: "site",
			module: "site",
			found: [brandSheet, ...pages],
		});
	return out;
}

/** @param {string} root */
const readSubjectModules = (root) =>
	readIndexSubjects(root).flatMap((s) => ("module" in s ? [s.module] : []));

module.exports = { readIndexSubjects, readSubjectModules };
