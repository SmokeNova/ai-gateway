// The admin listener. Same Express app as the public port; the gate tells the
// two apart by which port the request arrived on.
//
// It is started WITHOUT upstream's onReady callback: that callback starts the
// background schedulers (health checks, catalog sync, backups…) and several of
// them are not safe to start twice.
import type { Server } from 'node:http';
import type { Express } from 'express';

export function startAdminListener(options: {
  app: Express;
  port: number;
  host: string;
  tune: (server: Server) => void;
  /** Called with every server that starts listening (for the shutdown list). */
  register: (server: Server) => void;
  /** Allow the IPv4 fallback when binding '::' fails (host not set explicitly). */
  ipv4Fallback: boolean;
}): void {
  const { app, port, tune, register } = options;
  const listen = (host: string, allowFallback: boolean) => {
    const server = app.listen(port, host);
    tune(server);
    register(server);
    server.on('listening', () => {
      const display = host.includes(':') ? `[${host}]` : host;
      console.log(`[gateway] admin listener on http://${display}:${port} (reach it only through Tailscale)`);
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      // Same fallback upstream uses for the main listener (index.ts).
      if (allowFallback && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
        console.warn('[gateway] IPv6 unavailable for the admin listener — falling back to 0.0.0.0');
        listen('0.0.0.0', false);
        return;
      }
      console.error(`\n[gateway] admin listener failed to start on port ${port}:\n  ${err?.message ?? err}\n`);
      process.exit(1);
    });
  };
  listen(options.host, options.ipv4Fallback && options.host === '::');
}
