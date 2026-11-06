/*
 * systemctl-fake.ts — a stub `systemctl` for tests of its callers, injected at
 * WFC_SYSTEMCTL (lib/systemd-bins.js) and held to the real one by
 * systemctl.contract.test.ts (§G7, #3970).
 *
 * FOR TESTS ONLY.
 */
import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

export interface FakeUnit {
	/** `is-enabled`'s state; a unit without one reads not-found. */
	enabled?: string;
	/** `is-active`'s state; a unit without one reads inactive. */
	active?: string;
	/** `show`'s properties by name. */
	properties?: Record<string, string>;
}

export interface SystemctlAnswers {
	units?: Record<string, FakeUnit>;
	/** A verb that fails, with its exit code and stderr. */
	fails?: Record<string, { exit: number; says?: string }>;
	/** The cgroup root a unit's ControlGroup property sits under, as
	 * WFC_CGROUP_ROOT: `kill` empties that cgroup's `cgroup.procs`, as the
	 * killed processes leaving it would. */
	cgroupRoot?: string;
}

/* systemctl(1): is-enabled exits 0 on these states, 4 on not-found, else 1. */
const ENABLED_STATES = [
	"enabled",
	"enabled-runtime",
	"static",
	"alias",
	"indirect",
	"generated",
	"transient",
];

const arms = (entries: [string, string][]) =>
	entries
		.map(([match, body]) => `  ${shellQuote(match)}) ${body};;`)
		.join("\n");

/* The real one prints a state unless --quiet; and exits 0 only on active, 3 for
 * a loaded unit otherwise, 4 for one not loaded. */
const say = (state: string) => `[ -n "$quiet" ] || echo ${shellQuote(state)}`;

function buildScript(
	log: string,
	{ units = {}, fails = {}, cgroupRoot }: SystemctlAnswers,
): string {
	const list = Object.entries(units);
	const enabled = arms(
		list.flatMap(([unit, u]): [string, string][] =>
			u.enabled === undefined
				? []
				: [
						[
							unit,
							`${say(u.enabled)}; exit ${ENABLED_STATES.includes(u.enabled) ? 0 : 1}`,
						],
					],
		),
	);
	const active = arms(
		list.map(([unit, u]): [string, string] => [
			unit,
			`${say(u.active ?? "inactive")}; exit ${u.active === "active" ? 0 : 3}`,
		]),
	);
	const shown = arms(
		list.flatMap(([unit, u]): [string, string][] =>
			Object.entries(u.properties ?? {}).map(
				([name, value]): [string, string] => [
					`${unit} ${name}`,
					`if [ -n "$value" ]; then printf '%s\\n' ${shellQuote(value)}; else printf '%s\\n' ${shellQuote(`${name}=${value}`)}; fi`,
				],
			),
		),
	);
	const killed = arms(
		cgroupRoot === undefined
			? []
			: list.flatMap(([unit, u]): [string, string][] => {
					const cg = u.properties?.ControlGroup;
					return cg === undefined
						? []
						: [
								[
									unit,
									`: > ${shellQuote(path.join(cgroupRoot, cg, "cgroup.procs"))}`,
								],
							];
				}),
	);
	const failing = arms(
		Object.entries(fails).map(
			([verb, { exit, says = "" }]): [string, string] => [
				verb,
				`${says ? `echo ${shellQuote(says)} >&2; ` : ""}exit ${exit}`,
			],
		),
	);
	return `#!/bin/sh
echo systemctl "$*" >> ${shellQuote(log)}
verb= unit= props= value= quiet= next=
for a in "$@"; do
  if [ -n "$next" ]; then props="$props,$a"; next=; continue; fi
  case "$a" in
  -p|--property) next=1;;
  --property=*) props="$props,\${a#--property=}";;
  --value) value=1;;
  --quiet|-q) quiet=1;;
  -*) ;;
  *) if [ -z "$verb" ]; then verb=$a; else unit=$a; fi;;
  esac
done
case "$verb" in
${failing}
esac
case "$verb" in
is-enabled)
  case "$unit" in
${enabled}
  *) ${say("not-found")}; exit 4;;
  esac;;
is-active)
  case "$unit" in
${active}
  *) ${say("inactive")}; exit 4;;
  esac;;
show)
  IFS=,
  for p in $props; do
    case "$unit $p" in
${shown}
    esac
  done;;
kill)
  case "$unit" in
${killed}
  esac;;
esac
exit 0
`;
}

/**
 * A systemctl in `dir`, appending each call's `systemctl <args>` to
 * `dir/calls`. A verb neither failed nor modelled prints nothing and exits 0.
 * Its path, for WFC_SYSTEMCTL.
 */
export function writeSystemctl(
	dir: string,
	answers: SystemctlAnswers = {},
): string {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, "systemctl");
	fs.writeFileSync(bin, buildScript(path.join(dir, "calls"), answers), {
		mode: 0o755,
	});
	return bin;
}

/** The calls the systemctl in `dir` took, oldest first. */
export function systemctlCalls(dir: string): string[] {
	const log = path.join(dir, "calls");
	return fs.existsSync(log)
		? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
		: [];
}
