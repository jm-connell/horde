// Starts the POT server and exits when standard input closes, so the helper
// never outlives the desktop app that started it.
import "./src/main.ts";

(async () => {
  for await (const _chunk of Deno.stdin.readable) {
    // Nothing is sent; only the end of the stream matters.
  }
  Deno.exit(0);
})();
