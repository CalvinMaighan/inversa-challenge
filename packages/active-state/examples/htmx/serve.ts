import { serveExample } from "../shared/serve-static";

const suggestions = [
  "Draft release notes",
  "Add Astro island demo",
  "Benchmark brotli sizes",
  "Record a 30s walkthrough",
  "Wire eslint in CI",
];

serveExample({
  root: import.meta.dir,
  port: 5178,
  label: "HTMX kanban",
  extra(url) {
    if (url.pathname !== "/api/suggest") return null;
    const title =
      suggestions[Math.floor(Math.random() * suggestions.length)] ?? "New card";
    return new Response(
      `<div data-suggest-title="${title}">Suggested: ${title}</div>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
});
