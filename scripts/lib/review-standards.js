const fs = require("node:fs");
const path = require("node:path");
const { relativeUnder } = require("./is-under.js");

const BASE_REL = path.posix.join("docs", "code-standards-base.md");
const LOCAL_REL = "docs/code-standards.md";
const GLOSSARY_REL = "GLOSSARY.md";

/** @param {string} p */
const isFile = (p) =>
	fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/** @param {string} coreRoot */
const standardsBase = (coreRoot) => `${coreRoot}/${BASE_REL}`;

/**
 * @param {string} hostRoot
 * @returns {string | null}
 */
function standardsGlossary(hostRoot) {
	const glossary = `${hostRoot}/${GLOSSARY_REL}`;
	return isFile(glossary) ? glossary : null;
}

/**
 * @param {string} p
 * @param {string} hostRoot
 */
const standardsShown = (p, hostRoot) => relativeUnder(hostRoot, p) || p;

/** @param {string} hostRoot */
function standardsGlossaryLine(hostRoot) {
	const glossary = standardsGlossary(hostRoot);
	return glossary === null
		? ""
		: ` Hand the Standards axis \`${standardsShown(glossary, hostRoot)}\` too, for base §G8.`;
}

/**
 * @param {string} coreRoot
 * @param {string} hostRoot
 * @returns {"both" | "base" | "local" | "neither"}
 */
function standardsState(coreRoot, hostRoot) {
	const base = isFile(standardsBase(coreRoot));
	const local = isFile(`${hostRoot}/${LOCAL_REL}`);
	if (base) return local ? "both" : "base";
	return local ? "local" : "neither";
}

/**
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
	BASE_REL,
	LOCAL_REL,
	GLOSSARY_REL,
	missingBase,
	standardsBase,
	standardsGlossary,
	standardsGlossaryLine,
	standardsShown,
	standardsState,
};
