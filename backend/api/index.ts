import { app } from "../src/app.js";

export const config = { runtime: "nodejs" };

// Named per-method exports, not a default export, Vercel's Node runtime
// only recognizes the Web fetch-style (Request) => Response signature via
// named HTTP-method exports (GET/POST/...). A default export, even a
// literal function declaration, is invoked with the legacy Node
// (req, res) => void signature instead, where `req` isn't a real Request
// (Hono's c.req.raw.headers.get then breaks) and the real Response gets
// silently dropped. The app only ever routes GET and POST.
function handler(request: Request): Response | Promise<Response> {
  return app.fetch(request);
}

export const GET = handler;
export const POST = handler;
