/*
 * register.ts, the workflow-core plugin's hooks module: loads every mod the release ships,
 * so an adopter runs them from the install cache (#933). The root
 * hooks/hooks.json names it under `modules`; in the core itself the plugin is
 * not enabled, and each mod loads stand-alone from .claude/skills/ instead.
 *
 * Only `on` and `options` cross the import, never a hook body or `$`: the
 * engine refuses `$` followed into another file (#903 F3). Each mod's own
 * `session.start` carries a matcher, without which two in one module fail to
 * load (#903 F2).
 *
 * A new mod is also named in the tests that list each mod
 * (wfc-mods-validate.test.ts, lib/plugin-tree.test.ts).
 */

import type { Register } from "claude-code";
import { register as delivery } from "../.claude/skills/wfc-delivery/hooks/register.ts";
import { register as liveness } from "../.claude/skills/wfc-liveness/hooks/register.tsx";

export const register: Register = (on, options) => {
	delivery(on, options);
	liveness(on, options);
};
