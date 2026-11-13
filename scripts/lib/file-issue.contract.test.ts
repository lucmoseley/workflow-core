// @vitest-environment node
/*
 * Holds lib/file-issue-fake.ts to the real file-issue.js (§G7, #5148): one
 * script filing, the morning review's, sent through lib/file-through.js under
 * the morning review fixture's served gh, then through the fake under the same
 * handler answering in-process. Each case checks the verdict and what landed,
 * never a value either side computes for itself. Loosened, every module case
 * of lib/morning-review-filing.test.ts stays green on a fake that files a
 * body, a label set or an exit the real filer would not.
 *
 * Red after a change to file-issue.js: run this file, read which side
 * filed what, then fix the fake or narrow its header's "does not model".
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { fileIssueFake } from "./file-issue-fake";
import { morningReviewFixture } from "./morning-review-fixture";

const { fileThrough } = require("./file-through.js");
const { buildScriptFilerArgv } = require("./script-filer-argv.js");
const { buildStandaloneLine } = require("./standalone-line.js");
const { REVIEW_LABEL } = require("./review-issues.js");
const { STANDALONE_REASON } = require("./morning-review.js");

const sb = freshSandbox();
const { ghPort, readCreated, runEnv, seed, stub, wfc } = morningReviewFixture(
	sb,
	path.resolve(__dirname, "..", "file-morning-review.js"),
);

const argv = buildScriptFilerArgv({
	title: "Morning review — 2026-10-10",
	labels: [REVIEW_LABEL],
	placement: { standalone: STANDALONE_REASON },
	origin: "morning-review-script",
	distinctFrom: [],
});
const body = `## Question\n\nWhat stands?\n\n${buildStandaloneLine(STANDALONE_REASON)}\n`;

beforeEach(() => {
	const env = runEnv();
	for (const key of ["WFC_GH", "STUB_DIR", "HOME", "WFC_REFILL_DIR"] as const)
		vi.stubEnv(key, env[key]);
});
afterEach(() => vi.unstubAllEnvs());

const freshTracker = (prepare?: () => void) => {
	fs.rmSync(path.dirname(stub("x")), { recursive: true, force: true });
	seed([]);
	prepare?.();
};

function fileBoth(prepare?: () => void) {
	freshTracker(prepare);
	const real = fileThrough(argv, body, wfc());
	const realCreated = readCreated();
	freshTracker(prepare);
	const fake = fileIssueFake(ghPort(), "acme/wfc")(argv, body);
	return { real, realCreated, fake, fakeCreated: readCreated() };
}

it("files the same issue, exit 0, naming it on a line of its own", () => {
	const { real, realCreated, fake, fakeCreated } = fileBoth();
	expect(real.stderr).toBe("");
	expect([real.status, fake.status]).toEqual([0, 0]);
	expect(realCreated).toHaveLength(1);
	expect(fakeCreated).toEqual(realCreated);
	const filedLine =
		/^Filed #\d+: https:\/\/github\.com\/acme\/wfc\/issues\/\d+$/m;
	expect(real.stdout).toMatch(filedLine);
	expect(fake.stdout).toMatch(filedLine);
});

it("exits 1 naming gh's reason where the create fails", () => {
	const failCreate = () => fs.writeFileSync(stub("fail-review-create"), "");
	const { real, fake } = fileBoth(failCreate);
	expect([real.status, fake.status]).toEqual([1, 1]);
	const reason = "GraphQL: Could not resolve";
	expect(real.stderr).toContain(reason);
	expect(fake.stderr).toContain(reason);
});
