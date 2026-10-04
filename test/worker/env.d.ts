// Types for `env` and `exports` from "cloudflare:workers" in tests
type TimerEnv = import("../../src/types").Env;

declare namespace Cloudflare {
  interface Env extends TimerEnv {}
  interface GlobalProps {
    mainModule: typeof import("../../src/index");
  }
}
