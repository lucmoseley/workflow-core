// measured 17.51 M to 18.14 M on CLI 2.1.301, the low end rounded down, workflow-core#1784
const BUDGET = 17_500_000;
// guess, ~28 median Reads before BUDGET, workflow-core#1784
const WARN = 13_000_000;
// guess, ten names fit a screen, workflow-core#1784
const NAME_MAX = 10;

/**
 * @typedef {{ size: number, path: string }} Entry
 * @typedef {{ warned: boolean, named: number }} Told
 * @typedef {(name: string, entry: Entry, update: (entries: Entry[], told: Told) => { told: Told, message: string }) => string | null} ImageStore
 */

/** @param {number} n */
const millions = (n) => (n / 1_000_000).toFixed(1);

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 */
const setting = (raw, fallback) => {
	const n = Number(raw);
	return raw && Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * @param {Entry[]} entries
 * @param {Told} told
 * @param {{ budget: number, warn: number }} limits
 * @returns {{ told: Told, message: string }}
 */
function account(entries, told, { budget, warn }) {
	const total = entries.reduce((t, e) => t + e.size, 0);
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
 * @param {import("./core-contract.js").CoreContext & { imageStore: ImageStore }} ctx
 */
function decide(filePath, ctx) {
	if (ctx.env.WFC_NO_IMAGE_BUDGET === "1") return null;
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
