// Stands in for cloudflared in tests (CLOUDFLARED_BIN): prints a quick tunnel's address the way cloudflared does,
// then stays up until killed. FAKE_TUNNEL_NAME sets the address's name.
const name = process.env.FAKE_TUNNEL_NAME || "test-tunnel";
process.stderr.write("INF Requesting new quick Tunnel on trycloudflare.com...\n");
process.stderr.write(`INF |  https://${name}.trycloudflare.com                                  |\n`);
setInterval(() => {}, 1000);
