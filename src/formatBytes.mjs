export const formatBytes = (n) => {
  if (n == null) return "\u2014";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

export const formatDuration = (ms) => {
  if (ms == null) return "\u2014";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  // Number() drops trailing zeros: 60000 -> "60s", 1830 -> "1.83s"
  return `${Number((ms / 1000).toFixed(2))}s`;
};
