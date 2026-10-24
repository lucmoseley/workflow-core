// @vitest-environment node
/*
 * Pins issue-tree.js's pure half (#778): a parent counts only in its own repo,
 * and only an open issue, never a pull request, counts as an open child.
 * subIssuesOf is exercised through a stub gh in both callers' suites.
 *
 * retire-stale-containers.js runs this at session start and
 * check-issue-labels.js in the daily repo-checks run, so a loosened case lets
 * another repo's #N count as a child here, or retags a container whose open
 * children live elsewhere.
 */
import { describe, expect, it } from "vitest";

const { isOpenChild, localParentOf } = require("./issue-tree");

const REPO = "https://api.github.com/repos/o/here";

describe("localParentOf", () => {
	it("reads a parent in the row's own repo", () => {
		expect(
			localParentOf({
				repository_url: REPO,
				parent_issue_url: `${REPO}/issues/17`,
			}),
		).toBe(17);
	});

	it("never reads another repo's parent as a local number", () => {
		expect(
			localParentOf({
				repository_url: REPO,
				parent_issue_url: "https://api.github.com/repos/o/there/issues/17",
			}),
		).toBeNull();
	});

	it("is null with no parent", () => {
		expect(
			localParentOf({ repository_url: REPO, parent_issue_url: null }),
		).toBeNull();
		expect(localParentOf({ repository_url: REPO })).toBeNull();
	});

	it("counts the parent as local when the row carries no repository_url", () => {
		expect(
			localParentOf({
				parent_issue_url: "https://api.github.com/repos/o/there/issues/17",
			}),
		).toBe(17);
	});
});

describe("isOpenChild", () => {
	it("counts an open issue, and neither a closed one nor a pull request", () => {
		expect(isOpenChild({ state: "open" })).toBe(true);
		expect(isOpenChild({ state: "closed" })).toBe(false);
		expect(isOpenChild({ state: "open", pull_request: {} })).toBe(false);
	});
});
