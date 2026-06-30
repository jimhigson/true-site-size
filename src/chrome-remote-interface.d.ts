/**
 * Minimal ambient declaration for chrome-remote-interface (no @types package
 * exists). Types only the surface this action uses: the default export is a
 * factory returning a connected client whose CDP domains and raw send/on are
 * loosely typed - the Chrome DevTools Protocol payloads are dynamic, so `any`
 * is accepted here (and only here) for the CDP wire shapes.
 */
declare module "chrome-remote-interface" {
  /** a single CDP domain (Network, Page, Runtime, Input, Target, ...) whose
   *  commands and `.on(event, handler)` subscriptions are protocol-dynamic */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type CDPDomain = any;

  /** a connected Chrome DevTools Protocol client */
  interface CDPClient {
    Network: CDPDomain;
    Page: CDPDomain;
    Runtime: CDPDomain;
    Input: CDPDomain;
    Target: CDPDomain;
    /** raw protocol event subscription ("event" for the firehose, or a
     *  specific "Domain.event"); handler payloads are protocol-dynamic */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, handler: (params: any) => void): void;
    /** send a raw protocol command, optionally to a specific session */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send(method: string, params?: any, sessionId?: string): Promise<any>;
    close(): Promise<void>;
    // allow any other domain / member the protocol exposes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }

  interface CDPOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    target?: string | ((targets: unknown[]) => unknown);
    [key: string]: unknown;
  }

  /** connect to a Chrome instance and resolve a ready CDP client */
  function CDP(options?: CDPOptions): Promise<CDPClient>;

  export default CDP;
}
