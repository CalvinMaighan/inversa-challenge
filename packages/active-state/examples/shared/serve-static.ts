/** Tiny static file server with /active-state.min.js + /shared/* mapping. */
export function serveExample(opts: {
  root: string;
  port: number;
  label: string;
  extra?: (url: URL, req: Request) => Response | Promise<Response | null> | null;
}) {
  const { root, port: preferred, label, extra } = opts;
  const shared = `${root}/../shared`;
  const distJs = `${root}/../../dist/active-state.min.js`;

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname.includes("..")) {
      return new Response("Bad path", { status: 400 });
    }

    if (extra) {
      const hit = await extra(url, req);
      if (hit) return hit;
    }

    if (url.pathname === "/active-state.min.js") {
      const file = Bun.file(distJs);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": "application/javascript" },
        });
      }
      return new Response("Build the library first: bun run build", {
        status: 404,
      });
    }

    if (url.pathname.startsWith("/shared/")) {
      const file = Bun.file(`${shared}/${url.pathname.slice("/shared/".length)}`);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            "Content-Type": contentType(url.pathname),
          },
        });
      }
      return new Response("Not found", { status: 404 });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${root}${path}`);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(file, {
      headers: { "Content-Type": contentType(path) },
    });
  };

  for (let i = 0; i < 10; i++) {
    const port = preferred + i;
    try {
      Bun.serve({ port, fetch });
      if (i > 0) {
        console.log(`${label}: port ${preferred} busy, using ${port}`);
      }
      console.log(`${label} → http://localhost:${port}`);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EADDRINUSE") throw err;
    }
  }

  throw new Error(
    `${label}: ports ${preferred}–${preferred + 9} are in use. Free one and retry.`,
  );
}

function contentType(path: string): string {
  if (path.endsWith(".js") || path.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}
