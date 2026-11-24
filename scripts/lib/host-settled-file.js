const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught");
const { hostRoot } = require("./host-root");

/**
 * @param {import("./check").Ctx} ctx
 * @param {{ file: string, keyedBy: string, entryFault: (key: string, entry: unknown) => string | null }} spec
 * @returns {Record<string, unknown>}
 */
function loadSettledFile(ctx, { file, keyedBy, entryFault }) {
	let data;
	try {
		data = JSON.parse(fs.readFileSync(path.join(hostRoot(), file), "utf8"));
	} catch (e) {
		const err = caught(e);
		if (err.code === "ENOENT") return {};
		ctx.broken(
			`${file} unparseable — ${err.message}. Fix its JSON, or delete it to accept nothing.`,
		);
	}
	if (data === null || typeof data !== "object" || Array.isArray(data))
		ctx.broken(`${file} malformed — not an object keyed by ${keyedBy}`);
	for (const [key, entry] of Object.entries(data)) {
		const fault = entryFault(key, entry);
		if (fault) ctx.broken(`${file} malformed — ${fault}`);
	}
	return data;
}

module.exports = { loadSettledFile };
