const fs = require("node:fs");
const path = require("node:path");

const NOTICES = ".claude/skills/THIRD-PARTY-NOTICES.md";
const LOCK = "skills-lock.json";

/** @param {string} root @returns {Map<string, string[]> | null} */
function readLockedSources(root) {
	const file = path.join(root, LOCK);
	if (!fs.existsSync(file)) return null;
	const skills = JSON.parse(fs.readFileSync(file, "utf8")).skills ?? {};
	/** @type {Map<string, string[]>} */
	const bySource = new Map();
	for (const [name, e] of Object.entries(skills)) {
		const source = /** @type {{ source?: unknown }} */ (e)?.source;
		if (typeof source !== "string") continue;
		bySource.set(source, [...(bySource.get(source) ?? []), name]);
	}
	return bySource;
}

/**
 * @param {string} text
 * @param {Map<string, string[]>} sources
 * @returns {Map<string, { names: string[], licence: string }>}
 */
function noticeSections(text, sources) {
	/** @type {Map<string, string[]>} */
	const bodies = new Map();
	/** @type {string[] | null} */
	let body = null;
	for (const l of text.split("\n")) {
		const heading = l.startsWith("## ") ? l.slice(3).trim() : null;
		if (heading !== null && sources.has(heading)) {
			body = [];
			bodies.set(heading, body);
		} else body?.push(l);
	}
	/** @type {Map<string, { names: string[], licence: string }>} */
	const sections = new Map();
	for (const [heading, lines] of bodies) {
		const at = lines.findIndex((l) => l.startsWith("Skills:"));
		const line = lines[at];
		const names = line
			? line
					.slice("Skills:".length)
					.split(",")
					.map((s) => s.trim().replace(/^`|`$/g, ""))
					.filter(Boolean)
			: [];
		sections.set(heading, {
			names,
			licence: at < 0 ? "" : lines.slice(at + 1).join("\n"),
		});
	}
	return sections;
}

/** @param {string} root */
function readNoticesText(root) {
	const file = path.join(root, NOTICES);
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/** @param {string} text @param {Map<string, string[]>} sources */
const staleHeadings = (text, sources) =>
	[...text.matchAll(/^## ([^\s/]+\/[^\s/]+)[ \t\r]*$/gm)]
		.map((m) => m[1] ?? "")
		.filter((h) => !sources.has(h));

/** @param {string} root @returns {Map<string, string>} */
function readNoticeLicences(root) {
	const bySource = readLockedSources(root) ?? new Map();
	const sections = noticeSections(readNoticesText(root), bySource);
	/** @type {Map<string, string>} */
	const out = new Map();
	for (const source of bySource.keys()) {
		const section = sections.get(source);
		if (section) out.set(source, section.licence);
	}
	return out;
}

/** @param {string} root @returns {string[]} */
function noticeFaults(root) {
	const bySource = readLockedSources(root);
	if (!bySource) return [];
	const text = readNoticesText(root);
	const sections = noticeSections(text, bySource);
	/** @type {string[]} */
	const faults = [];
	for (const [source, names] of [...bySource].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const listed = sections.get(source)?.names;
		const want = [...names].sort().join(", ");
		if (!listed)
			faults.push(
				`${LOCK} vendors from ${source}, but ${NOTICES} has no \`## ${source}\` section, so its skills ship without their licence notice. Add the section: a \`Skills: ${want}\` line, then upstream's licence text verbatim (#1939).`,
			);
		else if ([...listed].sort().join(", ") !== want)
			faults.push(
				`${NOTICES}'s \`## ${source}\` section lists skills other than the ${LOCK} entries from that source, so an adopter reads the wrong licence for some. Set its line to \`Skills: ${want}\` (#1939).`,
			);
	}
	for (const heading of staleHeadings(text, bySource))
		faults.push(
			`${NOTICES} has a \`## ${heading}\` section, but ${LOCK} vendors nothing from ${heading}, so its text is read as part of the licence above it. Remove the section (#2378).`,
		);
	return faults;
}

module.exports = { LOCK, NOTICES, noticeFaults, readNoticeLicences };
