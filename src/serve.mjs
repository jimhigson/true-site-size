import { createHash, createPublicKey } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
// zstd lives behind a namespace import on purpose: zlib.zstdCompressSync only
// exists on Node >= 22.15 / 23.8, and a static `import { zstdCompressSync }`
// from a built-in throws at load time on older Node - which would crash the
// action for everyone, including gzip/br users. A namespace access is undefined
// (not a load error) when absent, so we can detect it and report it cleanly.
import * as zlib from "node:zlib";
import { readFileSync } from "node:fs";

// production sites serve h2, whose compressed headers make per-request
// overhead far smaller than http/1.1 - measuring over h2 keeps wire bytes
// honest. Browsers only speak h2 over TLS, so a throwaway self-signed
// localhost cert ships with the action (deliberately public: it exists only
// so headless chrome can ALPN to h2 on loopback during measurement)
const certDir = fileURLToPath(new URL("./cert/", import.meta.url));

/**
 * chrome must treat the cert as properly TRUSTED, not merely have its error
 * ignored: with a blanket --ignore-certificate-errors, chrome disables the
 * http cache for the origin, which fakes duplicate-download bugs (a repeat
 * request that should be a cache hit re-downloads in full). Pinning the
 * cert's public key via --ignore-certificate-errors-spki-list makes the
 * origin trusted-equivalent, so caching behaves like production
 */
export const certSpkiHash = createHash("sha256")
  .update(
    createPublicKey(
      readFileSync(join(certDir, "localhost-cert.pem")),
    ).export({ type: "spki", format: "der" }),
  )
  .digest("base64");

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

/**
 * the content encodings the host can simulate: a human-readable name, the
 * valid compression-level range, and the default level when none is given.
 * The defaults are moderate per-codec levels - gzip 8, brotli 4, zstd 6
 * (between the other two) - rather than each codec's build-time maximum, so
 * the measured bytes reflect a server compressing on the fly rather than a
 * fully pre-compressed asset. Pass "max" as the level to use the maximum.
 */
const encodings = {
  gzip: { name: "gzip", min: 0, max: 9, default: 8 },
  br: { name: "brotli", min: 0, max: 11, default: 4 },
  zstd: { name: "zstd", min: 1, max: 22, default: 6 },
  none: { name: "uncompressed", min: 0, max: 0, default: 0 },
};

/**
 * resolve a compression-level input - a number, the string "max", or null
 * (use the encoding's default) - to a concrete numeric level.
 */
const levelFor = (compression, level) => {
  const enc = encodings[compression];
  if (level === null || level === undefined || level === "") return enc.default;
  if (level === "max") return enc.max;
  return Number(level);
};

/**
 * Validate the compression input before any building happens, so a typo, an
 * out-of-range level or an unsupported runtime fails fast with a clear message
 * rather than silently serving the wrong bytes. zstd needs Node >= 22.15
 * (or >= 23.8), where zlib.zstdCompressSync landed; older runtimes still serve
 * gzip/br/none. level may be a number, "max", or null (use the default).
 */
export const assertCompressionSupported = (compression, level = null) => {
  const enc = encodings[compression];
  if (!enc) {
    throw new Error(
      `unknown compression "${compression}" - use one of: ${Object.keys(encodings).join(", ")}`,
    );
  }
  if (compression === "zstd" && typeof zlib.zstdCompressSync !== "function") {
    throw new Error(
      `compression "zstd" needs Node >= 22.15 (or >= 23.8) for zlib.zstdCompressSync, ` +
        `but this runner has ${process.version}. Upgrade Node (eg actions/setup-node ` +
        `with node-version: 22) or choose gzip, br or none.`,
    );
  }
  // a level on "none" is meaningless - ignore it rather than erroring, so a
  // templated config that always sets compression-level still works. "max" is
  // always valid - it resolves to the encoding's maximum.
  if (level !== null && level !== "max" && compression !== "none") {
    const n = Number(level);
    if (!Number.isInteger(n) || n < enc.min || n > enc.max) {
      throw new Error(
        `compression-level must be an integer ${enc.min}-${enc.max} or "max" for ${enc.name}, got "${level}"`,
      );
    }
  }
};

/**
 * compress a body the way the named production encoding would, at the given
 * level (a number, "max", or null for the encoding's default).
 */
const compress = (raw, encoding, level) => {
  const lvl = levelFor(encoding, level);
  if (encoding === "br") {
    return brotliCompressSync(raw, {
      params: { [constants.BROTLI_PARAM_QUALITY]: lvl },
    });
  }
  if (encoding === "zstd") {
    return zlib.zstdCompressSync(raw, {
      params: { [constants.ZSTD_c_compressionLevel]: lvl },
    });
  }
  return gzipSync(raw, { level: lvl });
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
  /** "gzip" | "br" | "zstd" | "none" */
  compression,
  /** compression level for the chosen encoding; null uses its default */
  level = null,
) =>
  new Promise((resolve) => {
    // track what the measuring browser advertises it can decode: if it never
    // offers the requested encoding it cannot decode it, the responses fall
    // back to uncompressed, and the measured bytes are meaningless. Surfaced
    // after the run via assertBrowserDecodes so the job fails rather than
    // silently reporting the wrong numbers
    let encodingSeen = false;
    let acceptEncodingSample = null;
    const server = createSecureServer(
      {
        cert: readFileSync(join(certDir, "localhost-cert.pem")),
        key: readFileSync(join(certDir, "localhost-key.pem")),
        allowHTTP1: true,
      },
      (req, res) => {
      const url = new URL(req.url, "https://localhost");
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
      if (acceptEncodingSample === null) acceptEncodingSample = acceptsEncoding;
      if (acceptsEncoding.includes(compression)) encodingSeen = true;
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
      const body = compress(raw, compression, level);
      res.setHeader("Content-Encoding", compression);
      res.end(body);
      },
    );
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `https://localhost:${port}`,
        close: () => new Promise((r) => server.close(r)),
        /**
         * throw if the measuring browser never advertised the requested
         * encoding - it cannot decode it, so the run silently fell back to
         * uncompressed bytes and the measurement is invalid. No-op for
         * compression "none", and for a run that made no requests (whose own
         * errors are the real story).
         */
        assertBrowserDecodes: () => {
          if (
            compression === "none" ||
            acceptEncodingSample === null ||
            encodingSeen
          ) {
            return;
          }
          throw new Error(
            `the measuring browser never advertised "${compression}" in its ` +
              `Accept-Encoding (it sent "${acceptEncodingSample}"), so it cannot ` +
              `decode ${encodings[compression].name} responses - the measured bytes ` +
              `would be the uncompressed fallback, not real. Use a browser that ` +
              `supports it (zstd needs Chrome >= 123) or set compression to one ` +
              `it advertises.`,
          );
        },
      });
    });
  });
