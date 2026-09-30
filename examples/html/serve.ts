import { serveExample } from "../shared/serve-static";

serveExample({
  root: import.meta.dir,
  port: 5177,
  label: "HTML kanban",
});
