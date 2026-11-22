import fs from "node:fs";
import path from "node:path";

const { projectSlug } = require("./project-slug.js");

export const claimStoreOf = (configDir: string, checkout: string) =>
	path.join(configDir, "projects", projectSlug(checkout), "issue-claims");

export function writeIssueClaim(
	configDir: string,
	checkout: string,
	issue: number,
	sessionId: string,
) {
	const dir = claimStoreOf(configDir, checkout);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${issue}-${sessionId}.json`),
		JSON.stringify({ issue, sessionId, claimedAt: new Date().toISOString() }),
	);
}

export function writeTornClaim(configDir: string, checkout: string) {
	const dir = claimStoreOf(configDir, checkout);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "9-torn.json"), "");
}

export function writeAdopterCheckout(at: string, tracker: string) {
	fs.mkdirSync(path.join(at, ".git"), { recursive: true });
	fs.mkdirSync(path.join(at, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(at, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker }),
	);
}
