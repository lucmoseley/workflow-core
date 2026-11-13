// @vitest-environment node
/*
 * §G7's contract for file-issue's link fake (#5150): file-issue-testkit's
 * answerLink, which the module cases in file-issue-core.test.ts take as the
 * core's `link` port, answers exactly what the production adapter —
 * lib/link-writer.js's runLinkSync, mapped as scripts/file-issue.js maps it —
 * answers on the same gh stub, for a link that lands and for each refusal the
 * module cases serve. A drift in link-writer's wording fails here, not as a
 * module case passing on text the real link no longer prints.
 */

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { answerLink, fileIssueKit, NEW } from "./file-issue-testkit";
import { runLinkSync } from "./link-writer.js";

const kit = fileIssueKit();

/** The production adapter, as scripts/file-issue.js wires it. */
const realLink = (parent: number, child: number) => {
	vi.stubEnv("WFC_GH", kit.ghStub().gh);
	vi.stubEnv("WFC_LINK_SLEEP", "0");
	vi.stubEnv("WFC_LINK_RETRIES", "2");
	const r = runLinkSync("sub-issue", [String(parent), String(child)], {
		repo: "acme/widgets",
	});
	if (r.code === 0) return { ok: r.out.trim(), warning: r.warning };
	return { error: r.err || "no output" };
};

describe("file-issue's link fake, against runLinkSync on the gh stub", () => {
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
