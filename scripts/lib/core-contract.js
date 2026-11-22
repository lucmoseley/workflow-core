/**
 * @typedef {import("./kit-context.js").KitContext} KitContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {import("./guard-cores.js").CoreRow} CoreRow
 * @typedef {import("./guard-host-ports.js").TreePorts} TreePorts
 * @typedef {import("./guard-host-ports.js").CorePorts} CorePorts
 * @typedef {(NonNullable<Decision> & { updatedInput?: Record<string, unknown> }) | null} CoreDecision
 * @typedef {KitContext & CorePorts & { session: string,
 * tree: () => TreePorts }} CoreContext
 * @typedef {CoreRow & { field: string | string[], noun: string, top?: boolean,
 * decide: (subject: string, ctx: CoreContext) => CoreDecision }} LoadedCore
 * @typedef {CoreRow & { loadFault: string }} UnloadedCore
 * @typedef {LoadedCore | UnloadedCore} Core
 * @typedef {Omit<import("./kit-context.js").PortEnv, "payload">} HostEnv
 * @typedef {(env: HostEnv) => object} HostBuilder
 */

module.exports = {};
