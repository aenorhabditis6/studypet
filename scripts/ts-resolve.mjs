// Lets Node run the app's TypeScript modules directly: Vite-style extensionless relative
// imports ("./bridge") resolve to ".ts" files. Use with: node --import ./scripts/ts-resolve.mjs
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        // not a .ts module; fall through
      }
    }
    return next(specifier, context);
  },
});
