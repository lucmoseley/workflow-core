/*
 * founder-wording.js — hand a session the text a pattern names when the
 * founder's prompt matches that pattern's wording, or when the agent loads
 * the pattern's skill itself — spec #628, widening spec #496's recurrence
 * hook (ruled at #482). A dispatcher core on the Skill route (#2792), and the
 * core scripts/inject-founder-wording.js runs on the prompt route.
 *
 * Patterns: recurrence — the four recurrence checks, fired by a fault the
 * founder believed fixed coming back (#514) or a `diagnosing-bugs` load
 * (#516); re-pitch — the `/wait-what` skill's body, fired by a founder asking
 * for a simpler re-pitch of the last reply (#642).
 *
 * Why: the prompt is the nearest event to the reply the text governs, so the
 * text lands there rather than in an always-loaded file.
 *
 * INJECTION ONLY — it never denies. Recurrence's text is the rules fragment
 * named after it, its `@CORPUS@` replaced by the trackers the host's corpus
 * resolves (`ctx.corpus`), since those vary by host. Where that resolves none,
 * cannot read the config, or has lost the host's own tracker, the text says
 * so and still fires. Re-pitch's text is the skill file's body, read at fire
 * time beside the plugin's scripts (`ctx.skillFile`), so the typed and the
 * fired repair cannot drift (#628).
 *
 * IMPLICIT:  injects the four recurrence checks and this host's tracker corpus into a session whose prompt names a fault coming back, or starts with `/diagnosing-bugs`, at UserPromptSubmit, and into one loading the `diagnosing-bugs` skill, at PreToolUse; and the `/wait-what` re-pitch into a session whose prompt asks for a simpler re-pitch, at UserPromptSubmit — without the session asking.
 * JUSTIFIED: fail-safe — a recurrence diagnosed from scratch repeats the earlier fix's blind spot, and the founder pays for the fault a second time; a reply that missed is otherwise re-pitched from the agent's own defaults, since the founder never types `/wait-what` (#628).
 * DEFEAT:    the host's `disabled` list naming `inject-founder-wording`, on both routes and for every pattern. Otherwise none on the prompt route — keyed to the prompt's wording. The Skill route's latch: `scripts/clear-rule-latch.sh` clears it and the text is said again.
 *
 * LIMITS
 *  - Recurrence: `again?`, `perpetual(ly)`, `still not` and `still broken`
 *    are absent because their hits were mostly not recurrences (#496).
 *  - Re-pitch: bare `jargon`, bare `long-winded` and `simple steps` are
 *    absent — their hits were notes on drafts for someone else, or
 *    step-by-step hand-over asks (#628). Its phrases were fitted to the sample
 *    they were measured on, so ~98% precision is an upper bound and recall is
 *    unmeasured.
 *  - Re-pitch is silent on a prompt starting with `/wait-what`, which already
 *    delivers the text, and has no Skill route: `disable-model-invocation`
 *    keeps the Skill tool from loading it.
 *  - A prompt lib/founder-typing.js's `isMachineWrittenPrompt` marks — a
 *    background-task notification, a subagent's hand-back, a mod's delivery,
 *    the refill loop's resume — never fires, whatever it quotes (#652,
 *    #3378). So a founder paste opening with one is silent too, and any other
 *    pasted transcript quoting the phrases fires.
 *  - The prompt route is not latched: every matching prompt fires, since each
 *    may name a different fault or follow a different reply that missed. The
 *    Skill route is, once per session, agent and pattern, through the kit's
 *    `warn.` latch (`latchAfter`), since its text never changes.
 *  - A skill command the founder types expands without a Skill call, so only
 *    the prompt route sees it.
 *  - It never searches a tracker itself: the search terms need the agent's
 *    reading of the fault, and a `gh` call here would sit on every prompt.
 *  - It FAILS OPEN on anything it cannot read, and the fail-open is RECORDED
 *    (mantahostels#147), naming the pattern it dropped.
 *  - Disabling is whole-guard: no host can silence one pattern alone.
 */

const { isMachineWrittenPrompt } = require("./founder-typing.js");

/**
 * @typedef {{ trackers: string[], ownMissing: boolean }} Corpus
 * @typedef {{
 *   log: (what: string, detail?: string) => void,
 *   ruleText: (id: string) => string,
 *   corpus: () => Corpus,
 *   skillFile: (name: string) => string | null,
 * }} WordingPorts the rule store, throwing where it cannot give the
 *   fragment; the host's corpus, throwing on a config that will not read;
 *   and a plugin skill file's text, null where it is unreadable
 * @typedef {import("./guard-dispatch.js").CoreContext & WordingPorts} SkillContext
 * @typedef {WordingPorts} PromptContext
 * @typedef {{ label: string, families: string[], skill?: string,
 *   skillPrefix?: string, quietOn?: string,
 *   text: (ctx: WordingPorts) => string | null }} Pattern
 */

const REPITCH_SKILL = "wait-what";

/* Each is its name — its latch key — plus its label on the record, its phrase
 * families, the skill whose load or typed command fires it (or none), the line
 * a Skill load puts above its text, the command that silences it (or none),
 * and its text. Order is the order texts join in one envelope. */
/** @type {Record<string, Pattern>} */
const PATTERNS = {
	"recurrence-checks": {
		label: "recurrence checks",
		skill: "diagnosing-bugs",
		skillPrefix:
			"Applies only if this fault, or one like it, was fixed or ticketed before; otherwise ignore.",
		/* `’` is the apostrophe a phone keyboard types. */
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

/* Each pattern with its phrase, whose leading class keeps a match from
 * starting mid-word. */
/** @type {[string, Pattern, RegExp][]} */
const PHRASED = Object.entries(PATTERNS).map(([name, p]) => [
	name,
	p,
	new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${p.families.join("|")})`, "iu"),
]);

/**
 * A prompt starting with `/<name>`, bare or plugin-qualified.
 * @param {string} name
 */
const slash = (name) =>
	new RegExp(`^\\s*/(?:[a-z0-9-]+:)?${name}(?:\\s|$)`, "i");

/**
 * The recurrence fragment, its `@CORPUS@` replaced; null where the fragment
 * will not read, logged.
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
	/* A function, so a `$&` in a tracker list is never read as the match. */
	return text.replace("@CORPUS@", () => corpus);
}

/**
 * The `/wait-what` skill's body under its framing line; null where the file
 * is unreadable or its body empty, logged.
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
 * What follows a skill file's frontmatter — every line after its second
 * `---` line — trimmed at the start and of trailing newlines; "" where there
 * is none or it is blank.
 * @param {string | null} file
 */
function skillBody(file) {
	if (file === null) return "";
	const lines = file.split("\n");
	const fences = lines.flatMap((l, i) => (l === "---" ? [i] : []));
	const second = fences[1];
	if (second === undefined) return "";
	return lines
		.slice(second + 1)
		.join("\n")
		.replace(/\n+$/, "")
		.trimStart();
}

/**
 * The texts of `patterns`, in pattern order, each through `shape`, joined
 * into one envelope; the names whose text was read ride beside it.
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
 * The Skill route: a load of a pattern's skill, bare or namespaced (#201),
 * hands its text under its prefix, once per session and agent.
 * @param {string} skill the Skill call's `skill`
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
 * The prompt route: every pattern whose wording, or typed skill command, the
 * prompt holds, unlatched; silent on a prompt `isMachineWrittenPrompt` marks
 * (#652, #3378) and, per pattern,
 * on its own command.
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
