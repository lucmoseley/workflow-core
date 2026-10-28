/*
 * migration-note.js — parses and validates a major release's migration note
 * (#6; spec §Releases and migration, mantahostels#3527).
 *
 * A note is Markdown with five fixed `##` sections, in order: *What changed*,
 * *Ruling*, *Residue*, *Manual steps*, *Verify*. *Residue* is a fenced ```json
 * block — the machine-readable shape `upgrade` applies — and *Verify* a
 * fenced ```sh block holding one shell command whose exit code proves the
 * bump. Every top-level *Manual steps* bullet carries a leading `[act]`,
 * `[choice]` or `[notice]` type (#246), and its continuation lines are
 * indented with no blank line among them (#2972); `Verify` stays the sole gate
 * on a note regardless of type. Any of these faults, or a missing/out-of-order/
 * duplicate section, is "malformed":
 * `release` refuses it and `upgrade` refuses to walk it.
 */

const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");

const SECTIONS = /** @type {const} */ ([
	"What changed",
	"Ruling",
	"Residue",
	"Manual steps",
	"Verify",
]);

/** Residue keys `upgrade` knows how to apply; its `EVERY_RUN` names the four
 * now done on every run, which apply nothing more (#1501). */
const RESIDUE_KEYS = /** @type {const} */ ([
	"contract",
	"settingsKeys",
	"hookPaths",
	"labels",
	"ignoreBlock",
	"roadmapMajorPin",
]);

/** What a reader does with a "## Manual steps" bullet (#246). */
const STEP_TYPES = /** @type {const} */ (["act", "choice", "notice"]);

/** @typedef {{type: (typeof STEP_TYPES)[number], text: string}} Step */

/** A top-level bullet, typed or not. */
const BULLET_START = /^[-*]\s/;

/** A top-level bullet naming a known step type; group 2 is its text. */
const TYPED_BULLET = new RegExp(
	`^[-*]\\s+\\[(${STEP_TYPES.join("|")})\\]\\s*(.*)$`,
);

/**
 * A fenced code block in the named language.
 * @param {string} lang
 * @returns {RegExp}
 */
const fence = (lang) => new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, "m");

/* A name runs from its first non-blank to its last; the second limb is a
 * heading of blanks alone at the end of the text, named by its last blank. */
const HEADING_RE =
	/^##(?:\s+(\S(?:.*\S)?)\s*|\s\s*([^\S\n\r\u2028\u2029])[\n\r\u2028\u2029]*)$/gm;
const BRACKETED_RE = /^[-*]\s+\[([^\]]*)\]/;
const TAG_RE = /^#\s+(v\d+\.\d+\.\d+)\s*$/m;

/**
 * The fenced block's body, or null where the section carries none.
 * @param {string} section
 * @param {string} lang
 * @returns {string | null}
 */
function parseFencedBody(section, lang) {
	const re = fence(lang);
	const m = section.match(re);
	return m ? requiredGroup(m, 1, re) : null;
}

/** @typedef {{name: string, index: number}} Heading */

/**
 * @param {string} text a migration note's full body
 * @returns {{tag: string|null, sections: Record<string, string>, residue: object|null, verify: string|null, faults: string[]}}
 */
function parseNote(text) {
	const headings = [...text.matchAll(HEADING_RE)].map((m) => ({
		name: m[1] ?? requiredGroup(m, 2, HEADING_RE),
		index: m.index ?? 0,
	}));
	const faults = structureFaults(headings.map((h) => h.name));
	const sections = sectionBodies(text, headings);

	let residue = null;
	const residueSection = sections.Residue;
	if (residueSection !== undefined)
		residue = parseResidue(residueSection, faults);

	const stepsSection = sections["Manual steps"];
	if (stepsSection !== undefined) faults.push(...stepFaults(stepsSection));

	let verify = null;
	const verifySection = sections.Verify;
	if (verifySection !== undefined) verify = parseVerify(verifySection, faults);

	const tagMatch = text.match(TAG_RE);

	return {
		tag: tagMatch ? requiredGroup(tagMatch, 1, TAG_RE) : null,
		sections,
		residue,
		verify,
		faults,
	};
}

/**
 * Missing, unknown, duplicate and out-of-order sections, in that order.
 * @param {string[]} names the note's `##` headings, in source order
 * @returns {string[]}
 */
function structureFaults(names) {
	/** @type {string[]} */
	const faults = [];
	for (const name of SECTIONS) {
		if (!names.includes(name)) faults.push(`missing section "## ${name}"`);
	}
	for (const name of names) {
		if (!SECTIONS.includes(/** @type {any} */ (name)))
			faults.push(`unknown section "## ${name}"`);
	}
	const seen = new Set();
	for (const name of names) {
		if (seen.has(name)) faults.push(`duplicate section "## ${name}"`);
		seen.add(name);
	}
	const order = names.filter((n) => SECTIONS.includes(/** @type {any} */ (n)));
	const wantOrder = SECTIONS.filter((s) => order.includes(s));
	if (order.join("\t") !== wantOrder.join("\t")) {
		faults.push(
			`sections out of order: got ${order.join(", ") || "(none)"}, want ${SECTIONS.join(", ")}`,
		);
	}
	return faults;
}

/**
 * Each section's trimmed body by heading name; a duplicate heading keeps its
 * first body.
 * @param {string} text
 * @param {Heading[]} headings
 * @returns {Record<string, string>}
 */
function sectionBodies(text, headings) {
	/** @type {Record<string, string>} */
	const sections = {};
	for (const [i, h] of headings.entries()) {
		const start = text.indexOf("\n", h.index) + 1;
		const end = headings[i + 1]?.index ?? text.length;
		const body = text.slice(start, end).trim();
		if (!(h.name in sections)) sections[h.name] = body;
	}
	return sections;
}

/**
 * The *Residue* section's JSON object, or null with its fault pushed.
 * @param {string} section
 * @param {string[]} faults accumulator: each fault is pushed here
 * @returns {object|null}
 */
function parseResidue(section, faults) {
	const json = parseFencedBody(section, "json");
	if (json === null) {
		faults.push('"## Residue" carries no fenced ```json block');
		return null;
	}
	try {
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			faults.push('"## Residue" ```json block is not an object');
			return null;
		}
		for (const key of Object.keys(parsed)) {
			if (!RESIDUE_KEYS.includes(/** @type {any} */ (key)))
				faults.push(`"## Residue" names unknown key "${key}"`);
		}
		return parsed;
	} catch (err) {
		faults.push(
			`"## Residue" \`\`\`json block does not parse: ${caught(err).message}`,
		);
		return null;
	}
}

/**
 * @param {string} section the *Manual steps* body
 * @returns {string[]} one fault per bullet with no known type or no text,
 * then each `continuationFaults` names
 */
function stepFaults(section) {
	/** @type {string[]} */
	const faults = [];
	for (const line of section.split("\n")) {
		if (!BULLET_START.test(line)) continue;
		const typed = line.match(TYPED_BULLET);
		if (typed) {
			if (!requiredGroup(typed, 2, TYPED_BULLET).trim())
				faults.push(
					`"## Manual steps" bullet carries no text after its type: ${line.trim()}`,
				);
			continue;
		}
		const bracketed = line.match(BRACKETED_RE);
		const named = bracketed
			? requiredGroup(bracketed, 1, BRACKETED_RE).trim()
			: null;
		faults.push(
			named
				? `"## Manual steps" bullet names unknown type "${named}" (want ${STEP_TYPES.map((t) => `[${t}]`).join("/")}): ${line.trim()}`
				: `"## Manual steps" bullet carries no type (want ${STEP_TYPES.map((t) => `[${t}]`).join("/")}): ${line.trim()}`,
		);
	}
	return [...faults, ...continuationFaults(section)];
}

const MISREAD_FAULTS = {
	unindented:
		'"## Manual steps" step carries an unindented line, which reads as part of the step',
	orphaned:
		'"## Manual steps" indented line comes after a blank line ended its step, so no step carries it',
};

/** @typedef {"none" | "step" | "gap"} StepState "gap" once a blank line ends a step */

/**
 * One *Manual steps* line classified against the state the lines above it left.
 * @param {string} line
 * @param {StepState} state
 * @returns {{state: StepState, misread: keyof typeof MISREAD_FAULTS | null}}
 */
function classifyStepLine(line, state) {
	if (BULLET_START.test(line)) return { state: "step", misread: null };
	if (!line.trim())
		return { state: state === "step" ? "gap" : state, misread: null };
	if (/^\s/.test(line))
		return { state, misread: state === "gap" ? "orphaned" : null };
	return { state, misread: state === "step" ? "unindented" : null };
}

/**
 * The lines `parseSteps` would misread, the first of each run named:
 * unindented prose inside a step, which it glues on, and an indented line
 * after a blank, which it drops (#2972).
 * @param {string} section the *Manual steps* body
 * @returns {string[]}
 */
function continuationFaults(section) {
	/** @type {string[]} */
	const faults = [];
	/** @type {StepState} */
	let state = "none";
	/** @type {keyof typeof MISREAD_FAULTS | null} */
	let lastMisread = null;
	for (const line of section.split("\n")) {
		const read = classifyStepLine(line, state);
		state = read.state;
		if (read.misread && read.misread !== lastMisread)
			faults.push(`${MISREAD_FAULTS[read.misread]}: ${line.trim()}`);
		lastMisread = read.misread;
	}
	return faults;
}

/**
 * The *Verify* command, or null with its fault pushed.
 * @param {string} section
 * @param {string[]} faults accumulator: each fault is pushed here
 * @returns {string|null}
 */
function parseVerify(section, faults) {
	const fenced = parseFencedBody(section, "sh");
	const line = (fenced === null ? section : fenced).trim();
	if (!line) {
		faults.push('"## Verify" names no command');
		return null;
	}
	if (line.includes("\n")) {
		faults.push('"## Verify" must be one command, not several lines');
		return null;
	}
	return line;
}

/**
 * @param {string} text
 * @returns {string[]} empty where the note is well-formed
 */
function validateNote(text) {
	return parseNote(text).faults;
}

/**
 * Every well-typed bullet in a "## Manual steps" section body, in the
 * source's order (#248). Call only where `parseNote`'s `faults` is empty —
 * an untyped bullet is dropped here. A bullet's continuation lines join its
 * text with a single space, up to a blank line or the next bullet (#425).
 * @param {string} text the "Manual steps" section body
 * @returns {Step[]}
 */
function parseSteps(text) {
	/** @type {Step[]} */
	const steps = [];
	/** @type {Step | null} */
	let current = null;
	/** @type {StepState} */
	let state = "none";
	for (const line of text.split("\n")) {
		state = classifyStepLine(line, state).state;
		const m = line.match(TYPED_BULLET);
		if (m) {
			current = {
				type: /** @type {Step["type"]} */ (requiredGroup(m, 1, TYPED_BULLET)),
				text: requiredGroup(m, 2, TYPED_BULLET).trim(),
			};
			steps.push(current);
		} else if (BULLET_START.test(line)) current = null;
		else if (current && state === "step" && line.trim())
			current.text = `${current.text} ${line.trim()}`;
	}
	return steps;
}

module.exports = { parseNote, validateNote, parseSteps, STEP_TYPES };
