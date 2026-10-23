// The UES runtime is implemented in JavaScript (.mjs) and intentionally has no
// hand-maintained declaration files. This ambient wildcard keeps the semantic
// TypeScript gate focused on the TypeScript extension surface (Pi SDK and
// typebox contracts, local TS types, control flow) instead of pretending that
// inferred JavaScript shapes are stable public types.
//
// If a .mjs module later publishes real declarations, replace this wildcard
// with a precise module declaration rather than weakening the gate globally.
declare module "*.mjs";
