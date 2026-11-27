/** @typedef {import("./workflow-core-config.js").Module} Module */

/**
 * @param {{ moduleOn: (module: Module) => boolean }} ctx
 * @param {Module} module
 * @param {string[]} ids
 */
const ruleModule = (ctx, module, ids) => (ctx.moduleOn(module) ? [] : ids);

module.exports = { ruleModule };
