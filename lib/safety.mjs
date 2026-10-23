// The shell-safety classifier has ONE owner: the self-contained module shipped
// with the UES router plugin. The plugin is installed as a standalone directory
// (it cannot import `lib/`), so making the plugin file canonical is what keeps
// the installed gate and the Pi extension from drifting into two different
// definitions of "destructive". This shim preserves the historical `lib/safety`
// import path for the extension and the core runtime.
export {
  SHELL_SAFETY_POLICY,
  SHELL_SAFETY_RULES,
  destructiveShellAnalysis,
  destructiveShellRisk,
  shellCommandSegments,
} from "../global-config/plugins/ues-router/safety.js"
