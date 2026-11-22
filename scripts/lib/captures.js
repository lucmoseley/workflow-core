const fs = require("node:fs");
const { markersDir } = require("./marker-root.js");
const nodePath = require("node:path");

const { ghApiSlurp } = require("./gh");
const { hostRoot } = require("./host-root.js");

const MARKER = "**Captured fact:**";

// lucmoseley/mantahostels#640
const DRAIN_REACTION = "rocket";

// guess, lucmoseley/mantahostels#679
const STALE_CAPTURE_DAYS = 7;

/**
 * @typedef {{
 *   id: number,
 *   issue_url?: string,
 *   html_url?: string,
 *   body?: string,
 *   created_at?: string,
 *   reactions?: Record<string, unknown>,
 * }} GhComment
 * @typedef {{
 *   id: number,
 *   issue: number,
 *   url: string | undefined,
 *   fact: string,
 *   createdAt: string,
 *   ageDays: number,
 *   drained: boolean,
 * }} Capture
 */

/** @param {GhComment} c */
const issueNumberOf = (c) =>
	Number(
		String(c.issue_url || "")
			.split("/")
			.pop(),
	);

/** @param {string | null | undefined} body */
function parseCaptureBody(body) {
	const lines = String(body || "").split("\n");
	const first = lines.findIndex((l) => l.trim() !== "");
	const head = lines[first];
	if (head === undefined) return null;
	if (!head.trimStart().startsWith(MARKER)) return null;
	return [head.trimStart().slice(MARKER.length), ...lines.slice(first + 1)]
		.join("\n")
		.trim();
}

const isDrained = (/** @type {Pick<GhComment, "reactions">} */ c) =>
	Number(c?.reactions?.[DRAIN_REACTION] || 0) > 0;

/** @returns {Capture[]} */
function fetchCaptures() {
	const comments = ghApiSlurp([
		"repos/{owner}/{repo}/issues/comments",
		"-X",
		"GET",
		"-f",
		"per_page=100",
	]);

	const now = Date.now();

	const out = [];
	for (const c of comments) {
		const fact = parseCaptureBody(c.body);
		if (fact === null) continue;
		const createdAt = Number.isFinite(Date.parse(c.created_at))
			? c.created_at
			: new Date(0).toISOString();
		out.push({
			id: c.id,
			issue: issueNumberOf(c),
			url: c.html_url,
			fact,
			createdAt,
			ageDays: (now - Date.parse(createdAt)) / 864e5,
			drained: isDrained(c),
		});
	}
	out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
	return out;
}

const STATE_FILE = () =>
	process.env.WFC_CAPTURE_STATE ||
	nodePath.join(markersDir(hostRoot()), ".capture-drain-state.json");

// guess, #5529
const STATE_STALE_HOURS = 24;

// guess, #5529
const REFRESH_MIN_AGE_HOURS = 1;

function readState() {
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
	} catch {
		return null;
	}
	const scannedAt = Date.parse(parsed?.scannedAt);
	if (!Number.isFinite(scannedAt)) return null;
	parsed.ageHours = (Date.now() - scannedAt) / 36e5;
	parsed.stale = parsed.ageHours > STATE_STALE_HOURS;
	return parsed;
}

/**
 * @param {Capture[]} captures
 * @param {number} [now]
 */
function writeState(captures, now = Date.now()) {
	const undrained = captures.filter((c) => !c.drained);
	try {
		fs.writeFileSync(
			STATE_FILE(),
			`${JSON.stringify(
				{
					scannedAt: new Date(now).toISOString(),
					captureCount: captures.length,
					undrainedCount: undrained.length,
					undrained: undrained.map(({ id, issue, url, createdAt }) => ({
						id,
						issue,
						url,
						createdAt,
					})),
				},
				null,
				2,
			)}\n`,
		);
		return true;
	} catch {
		return false;
	}
}

module.exports = {
	DRAIN_REACTION,
	STALE_CAPTURE_DAYS,
	STATE_STALE_HOURS,
	REFRESH_MIN_AGE_HOURS,
	fetchCaptures,
	readState,
	writeState,
};
