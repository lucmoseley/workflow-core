/*
 * hand-off.js — the `**Hand-off:**` block a background session parking at
 * `needs input:` writes into a comment on its ticket — the round it posts, or
 * its own comment where it points at a standing round or hands the founder an
 * act — so a fresh session picks up from the ticket rather than the stalled
 * conversation (workflow-core#2391).
 *
 * THE BLOCK. The header `**Hand-off:**`, then one line per field
 * (`HAND_OFF_SHAPE`), each optionally a list item, its name optionally bold.
 * The block runs from the header to the comment's end. Its diff fence closes
 * only on an unindented fence line, which no diff line can be: each opens
 * with a space, `+`, `-`, `@`, `\` or a header word.
 *
 * `buildHandOffComment` writes one for a session that could not: the refill
 * loop's hand-off of a resumed-idle session (workflow-core#2659), through
 * `rescue-sessions.js hand-off`.
 */

const HEADER = "**Hand-off:**";
/* GitHub refuses a comment body longer than this (GitHub docs, workflow-core#2391). */
const COMMENT_LIMIT = 65_536;
const FIELDS = /** @type {const} */ ([
	"Base",
	"Done",
	"Left",
	"Blocked on",
	"Uncommitted",
]);
/** @typedef {typeof FIELDS[number]} Field */
/* An abbreviated sha at git's default 7 characters, up to a full SHA-1's 40. */
const SHA = "[0-9a-f]{7,40}";
const SHA_RE = new RegExp(`^${SHA}$`, "i");
const FIELD_RE = new RegExp(
	String.raw`^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?(${FIELDS.join("|")}):(?:\*\*)?[ \t]*(.*)$`,
);
/* The header opening a line: one quoted mid-sentence opens no block. */
const HEADER_LINE_RE = /^[ \t]*\*\*Hand-off:\*\*/gm;
const DIFF_OPEN_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*diff[ \t]*$/;

const HAND_OFF_SHAPE = [
	HEADER,
	"- Base: <the HEAD sha you park at>",
	"- Done: <commits landed (shas) and steps finished, or none>",
	"- Left: <the remaining steps, in order>",
	"- Blocked on: <the round's Q numbers, or what the park waits on>",
	"- Uncommitted: none — or the files, their `git diff HEAD` following in a ```diff fence inside <details> (`git add -N` a new file first)",
	`A comment past ${String(COMMENT_LIMIT)} characters cannot post: commit a standalone part first, then diff the rest.`,
].join("\n");

/**
 * @typedef {{ fields: Record<Field, string>, uncommitted: string[],
 *   diff: string|null, block: string }} HandOff
 */

/**
 * The fenced `diff` block opening at `lines[at]`, and the index of its closing
 * fence — the last line where none closes it.
 * @param {string[]} lines
 * @param {number} at
 * @param {string} fence
 */
function diffAt(lines, at, fence) {
	const close = lines.findIndex((l, j) => j > at && l.trimEnd() === fence);
	const end = close < 0 ? lines.length : close;
	return { diff: `${lines.slice(at + 1, end).join("\n")}\n`, end };
}

/**
 * The block's field lines, each field's first, and its first `diff` fence.
 * @param {string[]} lines
 */
function scan(lines) {
	const fields = /** @type {Record<Field, string>} */ (
		Object.fromEntries(FIELDS.map((f) => [f, ""]))
	);
	/** @type {string|null} */
	let diff = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const open = diff === null ? DIFF_OPEN_RE.exec(line) : null;
		if (open) {
			const found = diffAt(lines, i, open[1] ?? "```");
			diff = found.diff;
			i = found.end;
			continue;
		}
		const m = FIELD_RE.exec(line);
		const name = /** @type {Field|undefined} */ (m?.[1]);
		if (name && !fields[name]) fields[name] = (m?.[2] ?? "").trim();
	}
	return { fields, diff };
}

/**
 * The block in `body`, parsed — the last line-opening `**Hand-off:**`
 * header's — or null where the body carries none. A field absent reads "".
 * @param {string} body
 * @returns {HandOff|null}
 */
function parseHandOff(body) {
	const at = [...body.matchAll(HEADER_LINE_RE)].at(-1)?.index;
	if (at === undefined) return null;
	const block = body.slice(at);
	const { fields, diff } = scan(block.split(/\r?\n/));
	fields.Base = fields.Base.replace(/`/g, "");
	return {
		fields,
		uncommitted: /^none\.?$/i.test(fields.Uncommitted)
			? []
			: fields.Uncommitted.split(/[\s,;]+/)
					.map((p) => p.replace(/^`|`$/g, ""))
					.filter(Boolean),
		diff,
		block,
	};
}

/**
 * The shas a `Done:` line names.
 * @param {HandOff} h
 * @returns {string[]}
 */
const doneShas = (h) =>
	h.fields.Done.match(new RegExp(String.raw`\b${SHA}\b`, "gi")) ?? [];

/**
 * The faults in the `Uncommitted:` files' diff.
 * @param {HandOff} h
 * @returns {string[]}
 */
function diffFaults(h) {
	if (h.uncommitted.length === 0) return [];
	const { diff } = h;
	if (diff === null)
		return [
			"its `Uncommitted:` names files but no fenced `diff` block follows",
		];
	return h.uncommitted
		.filter((p) => !diff.includes(`diff --git a/${p} `))
		.map((p) => `its diff carries no \`diff --git a/${p}\` section`);
}

/**
 * What is wrong with the block in `body`, one clause each — [] where it is
 * well formed.
 * @param {string} body  the comment's body
 * @param {string} [question]  the round's first question number, e.g. "1",
 *   which `Blocked on:` must name; unchecked where absent
 * @returns {string[]}
 */
function handOffFaults(body, question) {
	const h = parseHandOff(body);
	if (!h) return [`the comment carries no \`${HEADER}\` block`];
	const { Base, "Blocked on": blockedOn } = h.fields;
	const faults = FIELDS.filter((f) => !h.fields[f]).map(
		(f) => `its \`${f}:\` line is missing or empty`,
	);
	if (Base && !SHA_RE.test(Base))
		faults.push(`its \`Base:\` is \`${Base}\`, not a commit sha`);
	if (
		question &&
		blockedOn &&
		!new RegExp(`\\bQ${question}\\b`).test(blockedOn)
	)
		faults.push(`its \`Blocked on:\` does not name the round's Q${question}`);
	faults.push(...diffFaults(h));
	return faults;
}

/**
 * A fence `text` cannot close: one backtick longer than its longest run.
 * @param {string} text
 */
const fenceFor = (text) =>
	"`".repeat(
		Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1)),
	);

/**
 * A comment ending in a well-formed block, for a session stopped without
 * writing its own: `head`, then the newest lines of `narration` that fit in a
 * `<details>`, then the block. Null where the block alone runs past
 * COMMENT_LIMIT.
 * @param {{head: string, narration: string, base: string, done: string,
 *   left: string, blockedOn: string, files: string[], diff: string}} parts
 *   `files`, the uncommitted ones `diff` (`git diff HEAD` form) carries
 * @returns {string|null}
 */
function buildHandOffComment(parts) {
	/** @type {Record<Field, string>} */
	const values = {
		Base: parts.base,
		Done: parts.done,
		Left: parts.left,
		"Blocked on": parts.blockedOn,
		Uncommitted: parts.files.map((f) => `\`${f}\``).join(", ") || "none",
	};
	const block = [
		HEADER,
		...FIELDS.map((f) => `- ${f}: ${values[f]}`),
		...(parts.files.length > 0
			? [
					"",
					"<details><summary>Uncommitted diff</summary>",
					"",
					"```diff",
					parts.diff.trimEnd(),
					"```",
					"",
					"</details>",
				]
			: []),
	].join("\n");
	if (block.length > COMMENT_LIMIT) return null;
	const fence = fenceFor(parts.narration);
	const open = [
		"<details><summary>Narration, newest lines</summary>",
		"",
		`${fence}text`,
	];
	const close = [fence, "", "</details>", "", ""];
	let room =
		COMMENT_LIMIT -
		block.length -
		parts.head.length -
		2 -
		[...open, ...close].join("\n").length;
	/** @type {string[]} */
	const kept = [];
	for (const line of parts.narration.split("\n").filter(Boolean).reverse()) {
		room -= line.length + 1;
		if (room < 0) break;
		kept.push(line);
	}
	const narration =
		kept.length > 0 ? [...open, ...kept.reverse(), ...close].join("\n") : "";
	return `${parts.head}\n\n${narration}${block}`;
}

module.exports = {
	HAND_OFF_SHAPE,
	HEADER,
	doneShas,
	buildHandOffComment,
	handOffFaults,
	parseHandOff,
};
