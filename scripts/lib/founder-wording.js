const { isMachineWrittenPrompt } = require("./founder-typing.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {{ trackers: string[], ownMissing: boolean }} Corpus
 * @typedef {{
 *   log: (what: string, detail?: string) => void,
 *   ruleText: (id: string) => string,
 *   corpus: () => Corpus,
 *   skillFile: (name: string) => string | null,
 * }} WordingPorts
 * @typedef {import("./core-contract.js").CoreContext & WordingPorts} SkillContext
 * @typedef {WordingPorts} PromptContext
 * @typedef {{ label: string, families: string[], skill?: string,
 *   skillPrefix?: string, quietOn?: string,
 *   text: (ctx: WordingPorts) => string | null }} Pattern
 */

const REPITCH_SKILL = "wait-what";

/** @type {Record<string, Pattern>} */
const PATTERNS = {
	"recurrence-checks": {
		label: "recurrence checks",
		skill: "diagnosing-bugs",
		skillPrefix:
			"Applies only if this fault, or one like it, was fixed or ticketed before; otherwise ignore.",
		families: [
			"thought we(['’]d| had| have)? (already |just )?(fixed|solved|built|did|resolved|discussed|improved|wired|encoded)",
			"(second|third) time",
			"keeps? happening",
			"same (very dangerous )?mistake",
			"how many times",
			"i (swear i )?(previously|already) (asked|told|raised)",
			"going in circles",
			"still (seeing|approving|taking|failing|happening)",
		],
		text: recurrenceText,
	},
	repitch: {
		label: "re-pitch",
		quietOn: REPITCH_SKILL,
		families: [
			"simple and concise",
			"simpler",
			"simple (english|terms|language)",
			"concise (terms|language)",
			"no jargon",
			"plain (and simple )?english",
			"(response|answer|output|options?|questions?|wording|reply) (is|are) (still )?(very |incredibly |way |far )?(too[ -])?(confusing|unclear|long|long-?winded)",
			"not sure what you('|’)?re asking",
			"don('|’)?t understand (the question|what you('|’)?re asking)",
			"what are (we|you) (actually )?(deciding|asking)",
			"what (exactly )?(do you need|you want) (me|from me)",
			"explain (again|better|from here)",
			"you('|’)?re not making (any )?sense",
			"you('|’)?ve lost me",
			"expand the question",
			"still not explained",
		],
		text: repitchText,
	},
};

/** @type {[string, Pattern, RegExp][]} */
const PHRASED = Object.entries(PATTERNS).map(([name, p]) => [
	name,
	p,
	new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${p.families.join("|")})`, "iu"),
]);

/**
 * @param {string} name
 */
const slash = (name) =>
	new RegExp(`^\\s*/(?:[a-z0-9-]+:)?${name}(?:\\s|$)`, "i");

/**
 * @param {WordingPorts} ctx
 */
function recurrenceText(ctx) {
	let text;
	try {
		text = ctx.ruleText("recurrence-checks");
	} catch {
		ctx.log(
			"recurrence-checks fragment unreadable — recurrence checks not injected",
		);
		return null;
	}
	const key = "declare `corpus` in `.claude/workflow-core.json`";
	let corpus;
	try {
		const { trackers, ownMissing } = ctx.corpus();
		const named = trackers.map((t) => `\`${t}\``).join(", ");
		if (!named) corpus = `none resolves here — ${key}`;
		else if (ownMissing)
			corpus = `${named}; this repo's own is missing — ${key}`;
		else corpus = named;
	} catch {
		ctx.log(
			"corpus route could not read the config — recurrence checks name no tracker",
		);
		corpus =
			"none: `.claude/workflow-core.json` does not read — fix it so `corpus` resolves";
	}
	return text.replace("@CORPUS@", () => corpus);
}

/**
 * @param {WordingPorts} ctx
 */
function repitchText(ctx) {
	const body = skillBody(ctx.skillFile(REPITCH_SKILL));
	if (!body) {
		ctx.log("wait-what skill file unreadable or empty — re-pitch not injected");
		return null;
	}
	return `The founder's message asks for a simpler re-pitch of your last reply (\`/${REPITCH_SKILL}\`, fired by their wording). Apply this before anything else:\n${body}`;
}

/**
 * @param {string | null} file
 */
function skillBody(file) {
	if (file === null) return "";
	const lines = file.split("\n");
	const fences = lines.flatMap((l, i) => (l === "---" ? [i] : []));
	const second = fences[1];
	if (second === undefined) return "";
	return trimEndRun(lines.slice(second + 1).join("\n"), "\n").trimStart();
}

/**
 * @param {[string, Pattern][]} patterns
 * @param {WordingPorts} ctx
 * @param {(text: string, p: Pattern) => string} shape
 */
function envelope(patterns, ctx, shape) {
	/** @type {string[]} */
	const texts = [];
	/** @type {string[]} */
	const told = [];
	for (const [name, p] of patterns) {
		const t = p.text(ctx);
		if (t === null) continue;
		texts.push(shape(t, p));
		told.push(name);
	}
	return { text: texts.join("\n\n"), told };
}

/**
 * @param {string} skill
 * @param {SkillContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(skill, ctx) {
	const fresh = Object.entries(PATTERNS).filter(
		([name, p]) =>
			p.skill &&
			(skill === p.skill || skill.endsWith(`:${p.skill}`)) &&
			!ctx.told(name),
	);
	const { text, told } = envelope(fresh, ctx, (t, p) =>
		p.skillPrefix ? `${p.skillPrefix}\n${t}` : t,
	);
	if (!text) return null;
	return { injectRules: [], prelude: text, latchAfter: told[0] };
}

/**
 * @param {string} prompt
 * @param {PromptContext} ctx
 * @returns {{ context: string } | null}
 */
function decidePrompt(prompt, ctx) {
	if (isMachineWrittenPrompt(prompt)) return null;
	/** @type {[string, Pattern][]} */
	const matched = [];
	for (const [name, p, phrase] of PHRASED) {
		if (p.quietOn && slash(p.quietOn).test(prompt)) continue;
		if (
			phrase.test(prompt) ||
			(p.skill !== undefined && slash(p.skill).test(prompt))
		)
			matched.push([name, p]);
	}
	const { text } = envelope(matched, ctx, (t) => t);
	return text ? { context: text } : null;
}

module.exports = {
	field: "skill",
	noun: "skill call",
	decide,
	decidePrompt,
};
