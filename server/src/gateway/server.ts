// The admin listener. Same Express app as the public port; the gate tells the
// two apart by which port the request arrived on.
//
// It is started WITHOUT upstream's onReady callback: that callback starts the
// background schedulers (health checks, catalog sync, backups…) and several of
// them are not safe to start twice.
import type { Server } from 'node:http';
import type { Express } from 'express';

export function startAdminListener(
  app: Express,
  port: number,
  host: string,
  tune: (server: Server) => void,
): Server {
  const server = app.listen(port, host);
  tune(server);
  server.on('listening', () => {
    const display = host.includes(':') ? `[${host}]` : host;
    console.log(`[gateway] admin listener on http://${display}:${port} (reach it only through Tailscale)`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`\n[gateway] admin listener failed to start on port ${port}:\n  ${err?.message ?? err}\n`);
    process.exit(1);
  });
  return server;
}
