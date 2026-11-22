// @vitest-environment node
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
