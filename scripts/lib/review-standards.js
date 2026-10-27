/*
 * review-standards.js — which of the two standards files a review's Standards
 * axis can be handed: the base at the core root, and the host's own local file
 * (workflow-core#886, workflow-core#965) — plus the host's GLOSSARY.md, where it has one (workflow-core#1373).
 *
 * lib/review-standards.sh is the bash twin, still sourced by
 * inject-tracker-docs.sh and concision-backstop.sh until workflow-core#2802 deletes it;
 * keep the two in step.
 * review-standards.test.ts runs both on one host and holds them to one
 * answer.
 *
 * The caller hands both roots in: the core root as lib/script-path.js's
 * coreRoot() reads it, physical as Node's __dirname is, so in an adopter the
 * path handed over is the plugin-cache path workflow-core#711's machine-local Read rule
 * names, never a ~/.claude2 or ~/.claude3 symlink spelling; and the host root,
 * symlinks dereferenced, as lib/host-root.js resolves it. Neither is ever
 * unresolved here, so the bash twin's unresolved-root fall-backs have no twin.
 */

const fs = require("node:fs");

/** @param {string} p a regular file, symlinks followed, as `[[ -f ]]` reads */
const isFile = (p) =>
	fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * The base's absolute path, whether or not it exists. Concatenated, as the
 * bash twin's printf is.
 * @param {string} coreRoot
 */
const standardsBase = (coreRoot) => `${coreRoot}/docs/code-standards-base.md`;

/**
 * The host's GLOSSARY.md, whose terms base §G8 binds names to; null where the
 * host has none.
 * @param {string} hostRoot
 * @returns {string | null}
 */
function standardsGlossary(hostRoot) {
	const glossary = `${hostRoot}/GLOSSARY.md`;
	return isFile(glossary) ? glossary : null;
}

/**
 * `p` as a session is handed it: relative to the host root where it sits
 * under it, so the checkout's path costs no bytes against RULE_CAP
 * (workflow-core#1729), and whole where it does not, as an adopter's base in its plugin
 * cache.
 * @param {string} p
 * @param {string} hostRoot
 */
const standardsShown = (p, hostRoot) =>
	p.startsWith(`${hostRoot}/`) ? p.slice(hostRoot.length + 1) : p;

/**
 * The sentence handing the Standards axis the host's glossary, with a leading
 * space, or "" where the host has none.
 * @param {string} hostRoot
 */
function standardsGlossaryLine(hostRoot) {
	const glossary = standardsGlossary(hostRoot);
	return glossary === null
		? ""
		: ` Hand the Standards axis \`${standardsShown(glossary, hostRoot)}\` too, for base §G8.`;
}

/**
 * Which files exist.
 * @param {string} coreRoot
 * @param {string} hostRoot
 * @returns {"both" | "base" | "local" | "neither"}
 */
function standardsState(coreRoot, hostRoot) {
	const base = isFile(standardsBase(coreRoot));
	const local = isFile(`${hostRoot}/docs/code-standards.md`);
	if (base) return local ? "both" : "base";
	return local ? "local" : "neither";
}

/**
 * The record of a review run without the base, null where it is present:
 * review_standards_log_missing_base's, handed back for the caller to log.
 * @param {string} coreRoot
 * @returns {{ what: string, detail: string } | null}
 */
function missingBase(coreRoot) {
	const base = standardsBase(coreRoot);
	return isFile(base)
		? null
		: {
				what: "standards base absent — Standards axis reviewed without it",
				detail: base,
			};
}

module.exports = {
	missingBase,
	standardsBase,
	standardsGlossary,
	standardsGlossaryLine,
	standardsShown,
	standardsState,
};
