// @vitest-environment node

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { NEW } from "./file-issue-gh-fake";
import { link } from "./file-issue-host.js";
import { answerLink } from "./file-issue-link-fake";
import { fileIssueKit } from "./file-issue-testkit";

const kit = fileIssueKit();

const realLink = (parent: number, child: number) => {
	vi.stubEnv("WFC_GH", kit.ghStub().gh);
	vi.stubEnv("WFC_LINK_SLEEP", "0");
	vi.stubEnv("WFC_LINK_RETRIES", "2");
	return link("acme/widgets", parent, child);
};

describe("file-issue's link fake, against the real link on the gh fake", () => {
	it("answers a link that lands as the real link does", () => {
		kit.setUp();
		expect(answerLink(528, NEW, null)).toEqual(realLink(528, NEW));
	});

	it.each([
		[
			"the 7-layer cap",
			"gh: You can't add more than 7 layers of sub-issues (HTTP 422)",
		],
		[
			"the 100-child cap",
			"gh: Parent cannot have more than 100 sub-issues (HTTP 422)",
		],
		["any other refusal", "gh: Bad credentials (HTTP 401)"],
	])("answers a POST refused at %s as the real link does", (_, err) => {
		kit.setUp();
		fs.writeFileSync(kit.at("post-err"), err);
		expect(answerLink(528, NEW, err)).toEqual(realLink(528, NEW));
	});
});
