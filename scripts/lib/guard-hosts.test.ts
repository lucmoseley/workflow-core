// @vitest-environment node
import { describe, expect, expectTypeOf, it } from "vitest";

import type { HostBuilder } from "./core-contract.js";
import { readManifestRows } from "./guard-cores.js";

const HOSTS = {
	"agent-poll-host.js": (m: typeof import("./agent-poll-host.js")) =>
		m.buildHostPorts,
	"anthropic-report-host.js": (
		m: typeof import("./anthropic-report-host.js"),
	) => m.buildHostPorts,
	"branch-move-host.js": (m: typeof import("./branch-move-host.js")) =>
		m.buildHostPorts,
	"branch-publish-host.js": (m: typeof import("./branch-publish-host.js")) =>
		m.buildHostPorts,
	"claimed-bash-write-host.js": (
		m: typeof import("./claimed-bash-write-host.js"),
	) => m.buildHostPorts,
	"claims-refresh-host.js": (m: typeof import("./claims-refresh-host.js")) =>
		m.buildHostPorts,
	"commit-form-host.js": (m: typeof import("./commit-form-host.js")) =>
		m.buildHostPorts,
	"cpu-load-host.js": (m: typeof import("./cpu-load-host.js")) =>
		m.buildHostPorts,
	"dispatch-rewrite-host.js": (
		m: typeof import("./dispatch-rewrite-host.js"),
	) => m.buildHostPorts,
	"echo-call-host.js": (m: typeof import("./echo-call-host.js")) =>
		m.buildHostPorts,
	"echo-record-host.js": (m: typeof import("./echo-record-host.js")) =>
		m.buildHostPorts,
	"file-claim-host.js": (m: typeof import("./file-claim-host.js")) =>
		m.buildHostPorts,
	"find-start-host.js": (m: typeof import("./find-start-host.js")) =>
		m.buildHostPorts,
	"founder-wording-host.js": (m: typeof import("./founder-wording-host.js")) =>
		m.buildHostPorts,
	"image-budget-host.js": (m: typeof import("./image-budget-host.js")) =>
		m.buildHostPorts,
	"issue-close-host.js": (m: typeof import("./issue-close-host.js")) =>
		m.buildHostPorts,
	"issue-create-label-host.js": (
		m: typeof import("./issue-create-label-host.js"),
	) => m.buildHostPorts,
	"npm-install-host.js": (m: typeof import("./npm-install-host.js")) =>
		m.buildHostPorts,
	"pip-install-host.js": (m: typeof import("./pip-install-host.js")) =>
		m.buildHostPorts,
	"post-write-host.js": (m: typeof import("./post-write-host.js")) =>
		m.buildHostPorts,
	"pull-form-host.js": (m: typeof import("./pull-form-host.js")) =>
		m.buildHostPorts,
	"push-rules-host.js": (m: typeof import("./push-rules-host.js")) =>
		m.buildHostPorts,
	"recursive-dot-read-host.js": (
		m: typeof import("./recursive-dot-read-host.js"),
	) => m.buildHostPorts,
	"registry-atomicity-host.js": (
		m: typeof import("./registry-atomicity-host.js"),
	) => m.buildHostPorts,
	"review-comment-host.js": (m: typeof import("./review-comment-host.js")) =>
		m.buildHostPorts,
	"review-rules-host.js": (m: typeof import("./review-rules-host.js")) =>
		m.buildHostPorts,
	"review-tier-host.js": (m: typeof import("./review-tier-host.js")) =>
		m.buildHostPorts,
	"round-holds-host.js": (m: typeof import("./round-holds-host.js")) =>
		m.buildHostPorts,
	"scratch-git-host.js": (m: typeof import("./scratch-git-host.js")) =>
		m.buildHostPorts,
	"scratch-overwrite-host.js": (
		m: typeof import("./scratch-overwrite-host.js"),
	) => m.buildHostPorts,
	"shell-guard-host.js": (m: typeof import("./shell-guard-host.js")) =>
		m.buildHostPorts,
	"suite-background-host.js": (
		m: typeof import("./suite-background-host.js"),
	) => m.buildHostPorts,
	"suite-concurrency-hook-host.js": (
		m: typeof import("./suite-concurrency-hook-host.js"),
	) => m.buildHostPorts,
	"sweep-fire-host.js": (m: typeof import("./sweep-fire-host.js")) =>
		m.buildHostPorts,
	"tracker-rules-host.js": (m: typeof import("./tracker-rules-host.js")) =>
		m.buildHostPorts,
	"typecheck-red-host.js": (m: typeof import("./typecheck-red-host.js")) =>
		m.buildHostPorts,
	"unasked-rerun-guard-host.js": (
		m: typeof import("./unasked-rerun-guard-host.js"),
	) => m.buildHostPorts,
	"unchecked-rm-host.js": (m: typeof import("./unchecked-rm-host.js")) =>
		m.buildHostPorts,
	"wide-read-host.js": (m: typeof import("./wide-read-host.js")) =>
		m.buildHostPorts,
} satisfies Record<string, (m: never) => HostBuilder>;

describe("the typed host table", () => {
	it("names every host a guard-cores.json row builds, and no other", () => {
		const hosts = readManifestRows().flatMap((row) => row.host ?? []);
		expect(Object.keys(HOSTS).sort()).toEqual([...new Set(hosts)].sort());
	});

	it("refuses a builder whose first parameter is a string (#5425)", () => {
		expectTypeOf<(scripts?: string) => object>().not.toExtend<HostBuilder>();
	});
});
