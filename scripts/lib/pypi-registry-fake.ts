import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

export interface Http {
	code: number | null;
	body: string;
}
export type Get = { missing: true } | Http;

export interface PyPI {
	created: string;
	latest?: string;
	downloads: number | "404" | "FAIL" | "MISSING";
	status?: string;
	pypiOut?: Http;
	statusOut?: Get;
	statsFirstCode?: number;
}

export const buildPassingPyPI = (now: number): PyPI => ({
	created: new Date(now - 4000 * 86_400_000).toISOString(),
	latest: new Date(now - 30 * 86_400_000).toISOString(),
	downloads: 9_000_000,
	status: "active",
});

export const pypiBody = (created: string, latest = created) =>
	JSON.stringify({
		info: { name: "the-package", version: "2.0.0" },
		releases: {
			"0.0.1": [],
			"1.0.0": [
				{
					filename: "the_package-1.0.0-py3-none-any.whl",
					upload_time: created.slice(0, 19),
					upload_time_iso_8601: created,
				},
			],
			"2.0.0": [
				{
					filename: "the_package-2.0.0-py3-none-any.whl",
					upload_time: latest.slice(0, 19),
					upload_time_iso_8601: latest,
				},
			],
		},
		urls: [],
	});

const NOT_FOUND: Http = { code: 404, body: '{"message": "Not Found"}' };

export function pypiAnswer(reg: PyPI): Get {
	if (reg.pypiOut) return reg.pypiOut;
	if (reg.created === "MISSING") return { missing: true };
	if (reg.created === "FAIL") return { code: null, body: "" };
	if (reg.created === "404") return NOT_FOUND;
	return { code: 200, body: pypiBody(reg.created, reg.latest) };
}

export function statusAnswer(reg: PyPI): Get {
	if (reg.statusOut) return reg.statusOut;
	if (reg.created === "MISSING") return { missing: true };
	if (reg.created === "FAIL") return { code: null, body: "" };
	if (reg.created === "404") return NOT_FOUND;
	return {
		code: 200,
		body: JSON.stringify({
			meta: { "_last-serial": 1, "api-version": "1.4" },
			name: "the-package",
			...(reg.status === undefined
				? {}
				: { "project-status": { status: reg.status } }),
			files: [],
			versions: [],
		}),
	};
}

export function statsAnswer(reg: PyPI): Get {
	if (reg.downloads === "MISSING") return { missing: true };
	if (reg.downloads === "FAIL") return { code: null, body: "" };
	if (reg.downloads === "404") return { code: 404, body: "404" };
	return {
		code: 200,
		body: JSON.stringify({
			data: {
				last_day: 1,
				last_month: reg.downloads,
				last_week: 1,
			},
			package: "the-package",
			type: "recent_downloads",
		}),
	};
}

export function writePyPIStub(dir: string) {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "curl");
	fs.writeFileSync(
		file,
		`#!/usr/bin/env bash
echo ${shellQuote("curl ")}"$*" >> "$STUB_CALLS"
case "$*" in
  *pypistats.org*) side=STATS ;;
  *pypi.org/simple/*) side=STATUS ;;
  *) side=PYPI ;;
esac
out="STUB_\${side}_OUT"; code="STUB_\${side}_CODE"
if [ "$side" = STATS ] && [ -n "$STUB_STATS_FIRST" ] && [ ! -e "$STUB_CALLS.first" ]; then
  : > "$STUB_CALLS.first"
  printf '\n%s' "$STUB_STATS_FIRST"
  exit 0
fi
[ -n "\${!code}" ] || exit 7
printf '%s\\n%s' "\${!out}" "\${!code}"
`,
	);
	fs.chmodSync(file, 0o755);
	const served = (side: string, got: Get): NodeJS.ProcessEnv =>
		"missing" in got
			? {}
			: {
					[`STUB_${side}_OUT`]: got.body,
					[`STUB_${side}_CODE`]: got.code === null ? "" : String(got.code),
				};
	return (reg: PyPI): NodeJS.ProcessEnv => {
		const pypi = pypiAnswer(reg);
		const status = statusAnswer(reg);
		const stats = statsAnswer(reg);
		return {
			WFC_CURL: [pypi, status, stats].some((got) => "missing" in got)
				? path.join(dir, "no-such-curl")
				: file,
			...served("PYPI", pypi),
			...served("STATUS", status),
			...served("STATS", stats),
			STUB_STATS_FIRST:
				reg.statsFirstCode === undefined ? "" : String(reg.statsFirstCode),
		};
	};
}
