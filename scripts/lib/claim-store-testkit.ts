/*
 * Fixtures for the arbiter's issue-claim store and the adopter checkouts that
 * own one, for the tests of a reader that looks in another repo's store
 * (#2310).
 */

import fs from "node:fs";
import path from "node:path";

const { projectSlug } = require("./project-slug.js");

/** `checkout`'s issue-claim store under `configDir`, as the arbiter keys it. */
export const claimStoreOf = (configDir: string, checkout: string) =>
	path.join(configDir, "projects", projectSlug(checkout), "issue-claims");

/** An arbiter claim by `sessionId` on `issue`, in `checkout`'s store. */
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

/** A record in `checkout`'s store that will not parse. */
export function writeTornClaim(configDir: string, checkout: string) {
	const dir = claimStoreOf(configDir, checkout);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "9-torn.json"), "");
}

/** A main checkout at `at` tracking `tracker`, as lib/refill-repos.js finds one. */
export function writeAdopterCheckout(at: string, tracker: string) {
	fs.mkdirSync(path.join(at, ".git"), { recursive: true });
	fs.mkdirSync(path.join(at, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(at, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker }),
	);
}
