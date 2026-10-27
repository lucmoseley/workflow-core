/*
 * gate-subjects.js — what each switchable gate guards, found in a repo's
 * tracked tree (#1506). One predicate for every reader: check-gate-switches.js
 * refuses a commit while a subject is tracked and its switch is off, and
 * init-adopter.js and /new-repo switch on the module of each subject a
 * copied repo already holds.
 *
 * The tree is the INDEX — `git ls-files`, and the doc-map read as its staged
 * blob — so a commit is judged on its own bytes, never on a neighbour's
 * half-written working copy.
 */

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
 * @typedef {{subject: Subject, module: import("./workflow-core-config.js").Module,
 *   found: string[]}} Found `found` is the tracked paths that make the
 *   subject, for the refusal to name
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
 * Every subject `root`'s index tracks, in the order above. Throws where git
 * cannot list the index or read the doc-map's blob.
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
		out.push({ subject: "tests", module: "suites", found: tests });
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
	readIndexSubjects(root).map((s) => s.module);

module.exports = { readIndexSubjects, readSubjectModules };
