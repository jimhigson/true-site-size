import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const mimeTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

/** content types worth compressing - binary formats are already compressed */
const compressible = new Set([
  "text/html",
  "text/javascript",
  "text/css",
  "application/json",
  "image/svg+xml",
  "application/manifest+json",
]);

/**
 * Serve a static directory the way a production host would, simulating the
 * host's compression so measured wire bytes are realistic.
 */
export const serve = (
  /** directory to serve */
  dir,
  /** "gzip" | "br" | "none" */
  compression,
) =>
  new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      let filePath = normalize(join(dir, decodeURIComponent(url.pathname)));
      if (!filePath.startsWith(normalize(dir))) {
        res.writeHead(403).end();
        return;
      }
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        const indexPath = join(filePath, "index.html");
        if (existsSync(indexPath)) {
          filePath = indexPath;
        } else {
          // SPA fallback
          filePath = join(dir, "index.html");
          if (!existsSync(filePath)) {
            res.writeHead(404).end("not found");
            return;
          }
        }
      }
      const type = mimeTypes[extname(filePath)] ?? "application/octet-stream";
      const acceptsEncoding = req.headers["accept-encoding"] ?? "";
      const wantCompression =
        compression !== "none" &&
        compressible.has(type) &&
        acceptsEncoding.includes(compression);

      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "max-age=3600");
      if (!wantCompression) {
        createReadStream(filePath).pipe(res);
        return;
      }
      const raw = readFileSync(filePath);
      const body =
        compression === "br" ?
          brotliCompressSync(raw, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
          })
        : gzipSync(raw, { level: 9 });
      res.setHeader("Content-Encoding", compression);
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://localhost:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
