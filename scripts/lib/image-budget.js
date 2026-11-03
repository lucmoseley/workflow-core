/*
 * image-budget.js — the PostToolUse dispatcher core on Read that tells an
 * agent when the images it has read stop reaching it (workflow-core#1784).
 *
 * THE FAULT. Claude Code sends at most ~17.5 M base64 characters of images
 * and documents in one request (~13 MB decoded). Past that, as it builds each
 * request, it swaps the OLDEST for the text `[media removed: request limit]`,
 * retroactively — an image the agent saw a few Reads ago goes too. The Read
 * result in the transcript still holds the image, so nothing marks the swap.
 *
 * WHY A COUNTER, NOT A MATCH ON THE STRING. The string is added at request
 * build, after this hook has run, so no PostToolUse payload carries it. The
 * measure is the binary's own, `source.data.length` summed over image and
 * document blocks. A count cap is ruled out: 300 small images in one Haiku
 * subagent and 130 in one Opus subagent lost none (workflow-core#1784).
 *
 * WHAT IT SAYS. Per (session, agent) it appends each Read
 * result's base64 length and path to a store, and:
 *  - once, as the running total crosses WFC_IMAGE_WARN_CHARS: the budget is
 *    nearly spent, and what to do before it runs out;
 *  - on every Read that pushes more images past WFC_IMAGE_BUDGET_CHARS: which
 *    files are now gone, by name, each named once.
 * Silent on every other Read.
 *
 * LIMITS
 *  - Only Read is counted. An image pasted in, a screenshot from an MCP tool or
 *    any other media route adds to the real total unseen, so the warning comes
 *    late there.
 *  - A compaction drops images the store still counts, so after one the
 *    warning comes early.
 *  - A store idle for two days is deleted, so a session resumed after that
 *    with its images still in context starts counting from zero.
 *  - The cap is bracketed, not pinned: 17.51 M to 18.14 M on CLI 2.1.301
 *    (workflow-core#1784). BUDGET takes the low end, erring toward naming an image at the
 *    edge a Read early over leaving a gone one unnamed. A release that moves
 *    the cap makes every figure here wrong until re-measured.
 *  - Two parallel Reads that miss the store's lock race on it, so a notice may
 *    repeat or a file be named twice; none is lost.
 *
 * FAILS OPEN (mantahostels#103 §6), logged: no session id or an unwritable
 * store says nothing.
 *
 * IMPLICIT: after an image Read, tells the agent when its images near or pass
 *   the per-request budget, naming the files that no longer reach it.
 * JUSTIFIED: fail-safe — it adds context and refuses nothing; the judgement it
 *   heads off is made on an image the agent never saw.
 * DEFEAT: WFC_NO_IMAGE_BUDGET=1 — nothing is recorded or said.
 */

const BUDGET = 17_500_000;
/* A judgement: 4.5 M short of the budget leaves the mmm-infra scorers' median
 * image (~160 K characters) about 28 more Reads to act on the warning. */
const WARN = 13_000_000;
/* A judgement: ten names fit a screen; older ones are summarised by count. */
const NAME_MAX = 10;

/**
 * @typedef {{ size: number, path: string }} Entry one Read, oldest first
 * @typedef {{ warned: boolean, named: number }} Told what has been said: the
 *   warning, and how many of the oldest have been named gone
 * @typedef {(name: string, entry: Entry,
 *   update: (entries: Entry[], told: Told) => { told: Told, message: string })
 *   => string | null} ImageStore appends `entry` to the store `name` and runs
 *   `update` on the whole store under its lock, writing the told it returns;
 *   null where the store could not be written
 */

/** @param {number} n */
const millions = (n) => (n / 1_000_000).toFixed(1);

/**
 * A positive integer setting, else its default.
 * @param {string | undefined} raw
 * @param {number} fallback
 */
const setting = (raw, fallback) => {
	const n = Number(raw);
	return raw && Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * What the store now says, and what has then been said.
 * @param {Entry[]} entries
 * @param {Told} told
 * @param {{ budget: number, warn: number }} limits
 * @returns {{ told: Told, message: string }}
 */
function account(entries, told, { budget, warn }) {
	const total = entries.reduce((t, e) => t + e.size, 0);
	/* Everything older than the newest run of images that fits in the budget. */
	let gone = entries.length;
	for (let kept = 0; gone > 0; gone--) {
		const size = entries[gone - 1]?.size ?? 0;
		if (kept + size > budget) break;
		kept += size;
	}
	const count = entries.length;
	const replaces =
		"replaces the OLDEST images, silently, with the text `[media removed: request limit]` — the Read result still says it returned an image.";
	if (gone > told.named) {
		const fresh = entries.slice(told.named, gone);
		const names = fresh
			.slice(0, NAME_MAX)
			.map(
				(e, i) => `  - ${e.path} (image ${told.named + i + 1} of this context)`,
			);
		if (fresh.length > NAME_MAX)
			names.push(`  - and ${fresh.length - NAME_MAX} more, older than these`);
		return {
			told: { warned: true, named: gone },
			message: `IMAGE BUDGET (workflow-core#1784): this context has now read ${count} images, ${millions(total)} M characters of image data, past the ${millions(budget)} M Claude Code sends in one request. It now ${replaces} By this hook's count these no longer reach you:
${names.join("\n")}
Do not judge, compare against or describe any of them from memory. Re-reading one pushes out the next oldest. If your task still needs them, stop and report which images you could not see; a job this size belongs split across agents.`,
		};
	}
	if (!told.warned && total >= warn)
		return {
			told: { warned: true, named: told.named },
			message: `IMAGE BUDGET (workflow-core#1784): this context has read ${count} images, ${millions(total)} M characters of image data. Past ${millions(budget)} M, Claude Code ${replaces} Finish judging the early images before reading many more. Before using an earlier image again, check it still shows; where one shows \`[media removed: request limit]\`, do not judge it — stop and report which images never reached you.`,
		};
	return { told, message: "" };
}

/**
 * @param {string} filePath
 * @param {import("./guard-dispatch.js").CoreContext & { imageStore: ImageStore }} ctx
 */
function decide(filePath, ctx) {
	if (ctx.env.WFC_NO_IMAGE_BUDGET === "1") return null;
	/* Any response carrying base64 — an image, or a PDF's document block —
	 * counts, as both count against the same budget. */
	const file = /** @type {{ file?: { base64?: unknown } } | undefined} */ (
		ctx.response
	)?.file;
	const size = typeof file?.base64 === "string" ? file.base64.length : 0;
	if (size === 0) return null;
	if (!ctx.key) {
		ctx.log("no session id in payload — an image Read went uncounted");
		return null;
	}
	const limits = {
		budget: setting(ctx.env.WFC_IMAGE_BUDGET_CHARS, BUDGET),
		warn: setting(ctx.env.WFC_IMAGE_WARN_CHARS, WARN),
	};
	const message = ctx.imageStore(
		`${ctx.key.sid}.${ctx.key.agent}`,
		{ size, path: filePath.replace(/[\t\r\n]/g, " ") },
		(entries, told) => account(entries, told, limits),
	);
	return message ? { context: ctx.corePaths(message) } : null;
}

module.exports = { field: "file_path", noun: "image Read", decide };
