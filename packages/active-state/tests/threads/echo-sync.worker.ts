// Same as echo.worker.ts, reading the SAB ring with sliced Atomics.wait.
import { startEcho } from "./echo";

startEcho({ wait: "sync" });
