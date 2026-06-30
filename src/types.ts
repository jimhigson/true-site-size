/**
 * Shared data shapes for true-site-size. These describe the values that flow
 * between measure -> main -> comment, designed from how the data is actually
 * read (esbuild strips these at build time, so they are documentation the
 * compiler enforces).
 */

/** one entry in a row's per-request network log */
export interface RequestLogEntry {
  /** the requested url */
  url: string;
  /** transferred (on-the-wire) bytes for this request */
  bytes: number;
  /** ms after the segment start at which the request completed */
  atMs: number;
  /** present (true) when the url matched an ignore pattern - logged, not counted */
  ignored?: boolean;
  /** an explanatory note (eg a zombie request drained without loadingFinished) */
  note?: string;
}

/**
 * one measured row (a `row` step's result), or an error placeholder when the
 * row could not be measured. When error is set the measurement fields are
 * absent; otherwise they are all present.
 */
export interface RowResult {
  /** the row name (the `row` step's value) */
  name: string;
  /** counted wire bytes loaded-to-ready */
  bytes?: number;
  /** number of counted requests */
  requests?: number;
  /** number of requests that failed */
  failedRequests?: number;
  /** bytes from ignore-pattern-matched requests (logged, not counted) */
  ignoredBytes?: number;
  /** ms from segment start to the row's mark + settle */
  timeToMarkMs?: number;
  /** the per-request log for this row */
  requestLog?: RequestLogEntry[];
  /** byte spread across repeat runs (max - min); a determinism self-check */
  bytesSpread?: number;
  /** set when the row could not be measured (may be assigned undefined) */
  error?: string | undefined;
}

/**
 * a journey step. Exactly one action key is set per step (goto | click |
 * waitFor | waitForGone | keys | script | row), and a row carries either a
 * single `mark` or several `marks`. Any step may also wait on `afterMark`
 * before running.
 */
export interface JourneyStep {
  /** navigate to this url */
  goto?: string;
  /** wait for, scroll to and click this css selector */
  click?: string;
  /** wait until this css selector is present */
  waitFor?: string;
  /** wait until this css selector is absent */
  waitForGone?: string;
  /** space-separated trusted key presses */
  keys?: string;
  /** evaluate this expression in the page (awaited) */
  script?: string;
  /** close a measurement segment as a result row of this name */
  row?: string;
  /** the performance mark a row waits on (when a single mark); the scenario
   *  sugar may set this to undefined */
  mark?: string | undefined;
  /** the performance marks a row waits on (all must fire) */
  marks?: string[];
  /** wait for this app-readiness mark before the step runs */
  afterMark?: string;
}

/** the whole-site-on-disk size result (every file, compressed as served) */
export interface DiskSizes {
  /** total transferred bytes across every file */
  total: number;
  /** POSIX-relative path -> transferred bytes (JSON-serialisable for caching) */
  files: Record<string, number>;
}

/** what one base ref contributes: a built result plus its disk size */
export interface BuiltResult {
  results: RowResult[];
  disk: DiskSizes | null;
}

/** a measured base ref column (never throws; errors mark just this column) */
export interface BaseRef {
  /** the ref name as given */
  ref: string;
  /** the resolved commit sha, or null if the ref could not be fetched */
  sha: string | null;
  /** `git describe` output naming the ref, or null */
  describe: string | null;
  /** a link to the commit, or null outside a known server/repo */
  url: string | null;
  /** set when the base could not be fetched or measured */
  error?: string;
  /** the base's measured rows, or null when unmeasured */
  results?: RowResult[] | null;
  /** the base's whole-site disk size, or null */
  disk?: DiskSizes | null;
}

/** a parsed compression level: a number, the literal "max", or null (default) */
export type CompressionLevel = string | null;

/** the config object assembled in main from the action inputs */
export interface Config {
  steps: JourneyStep[];
  installCommand: string;
  buildCommand: string;
  cleanCommand: string;
  serveDir: string;
  compression: string;
  compressionLevel: CompressionLevel;
  runs: number;
  stepTimeoutMs: number;
  settleTimeoutMs: number;
  timeoutMs: number;
  ignorePatterns: string[];
  settleMs: number;
  markTimeoutMs: number;
  baseRefs: string[];
  commentKey: string;
  spreadToleranceBytes: number;
  minimumChangeThreshold: number;
  stripHash: string;
  comment: boolean;
  collapsibleBreakdown: boolean;
  measureDisk: boolean;
  token: string;
}

/** the options object passed to formatComment */
export interface CommentOptions {
  runUrl?: string | undefined;
  commentKey: string;
  stripHash: string;
  spreadToleranceBytes?: number;
  minimumChangeThreshold?: number;
  collapsibleBreakdown?: boolean;
  headDisk?: DiskSizes | null;
  measureDisk?: boolean;
}

/** the options object passed to postComment */
export interface PostCommentOptions {
  token: string;
  repo: string;
  issueNumber: number;
  commentKey: string;
  apiUrl?: string;
}

/** the running measurement server handle returned by serve */
export interface ServeHandle {
  /** the https origin to point the browser at */
  origin: string;
  /** stop the server */
  close: () => Promise<void>;
  /** throw if the browser never advertised the requested encoding */
  assertBrowserDecodes: () => void;
}
