/*
 * vendored-notices.js — every upstream `skills-lock.json` vendors from has its
 * licence notice in NOTICES, under a `## <source>` heading whose `Skills:` line
 * names exactly the skills the lock gives that source (#1939).
 *
 * NOTICES sits in .claude/skills/, so the plugin tree ships it with the
 * skills, and outside .agents/skills/, where the vendor installer writes, so a
 * re-pull never removes it. The lock does not ship, so the `Skills:` line is what tells an
 * adopter which licence covers which skill. Two readers refuse a mismatch:
 * check-vendored-skills.js at commit, and the release render.
 *
 * `readNoticeLicences` hands each section's licence text to
 * check-vendored-skills.js --upstream, which compares it with upstream's (#1951).
 */

const fs = require("node:fs");
const path = require("node:path");

const NOTICES = ".claude/skills/THIRD-PARTY-NOTICES.md";
const LOCK = "skills-lock.json";

/**
 * Skill names by source, from the lock. Null where the lock is absent.
 *
 * @param {string} root
 * @returns {Map<string, string[]> | null}
 * @throws {Error} where the lock exists and will not parse
 */
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
 * Each `## <source>` section's `Skills:` names, or an empty list where the
 * section has no such line, and its licence: the text after that line, or
 * empty where there is none. A section ends only at the next heading naming a
 * lock source, so a licence holding a `## ` heading of its own keeps its
 * tail (#2378).
 *
 * @param {string} text
 * @param {Map<string, string[]>} sources the lock's skill names by source
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

/**
 * The `## <owner>/<repo>` headings naming no lock source.
 *
 * @param {string} text
 * @param {Map<string, string[]>} sources
 */
const staleHeadings = (text, sources) =>
	[...text.matchAll(/^## ([^\s/]+\/[^\s/]+)[ \t\r]*$/gm)]
		.map((m) => m[1] ?? "")
		.filter((h) => !sources.has(h));

/**
 * The licence text NOTICES holds for each lock source it has a section for. A
 * source with none is NOTICE-MISSING's, so it is absent here.
 *
 * @param {string} root
 * @returns {Map<string, string>}
 * @throws {Error} where the lock exists and will not parse
 */
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

/**
 * One line per lock source NOTICES fails, each naming its way out. None where
 * the lock is absent.
 *
 * @param {string} root
 * @returns {string[]}
 * @throws {Error} where the lock exists and will not parse
 */
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
