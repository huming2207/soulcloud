// The only place that knows which runtime we're on. Everything else is plain
// Web-standard fetch handlers.

export interface FetchApp {
  fetch: (request: Request) => Response | Promise<Response>;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export async function serve(app: FetchApp, hostname: string, port: number): Promise<RunningServer> {
  if (isBun) {
    const server = Bun.serve({
      fetch: app.fetch,
      hostname,
      port,
      // Long enough for `?wait=` command calls; SSE streams send keep-alives.
      idleTimeout: 120,
    });
    return { port: server.port ?? port, close: () => server.stop(true) };
  }

  const { serve: nodeServe } = await import("@hono/node-server");
  return new Promise((resolve) => {
    const server = nodeServe({ fetch: app.fetch, hostname, port }, (info) =>
      resolve({
        port: info.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      }),
    );
  });
}
