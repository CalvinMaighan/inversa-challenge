// Worker entry. The runtime treats every named export of the main module as a handler,
// so the logic and its constants live in ./signal and only the handler is exported here.
import { handle, type Env } from "./signal";

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
};
