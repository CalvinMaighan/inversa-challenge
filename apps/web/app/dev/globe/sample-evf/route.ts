import { readFile } from "node:fs/promises";
import path from "node:path";

/** Dev-only: serves `spec/frames/sample.evf` to the globe's dev fixture. 404 in production builds. */
export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response("not found", { status: 404 });
  try {
    const bytes = await readFile(path.join(process.cwd(), "..", "..", "spec", "frames", "sample.evf"));
    return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/x-evf", "cache-control": "no-store" } });
  } catch {
    return new Response("sample.evf not found", { status: 404 });
  }
}
