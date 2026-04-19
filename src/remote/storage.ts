import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import type {
  NodeSavedSession,
  NodeSavedSessionStore,
  NodeSavedState,
  NodeSavedStateStore,
} from "@atproto/oauth-client-node";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Shape we persist for an MCP authorization request that's been delegated to
 * Bluesky OAuth. The caller (Claude) hit our /authorize endpoint, we stashed
 * this row, started Bluesky OAuth, and the ATProto `state` value points back
 * at this row so the callback can finish Claude's flow.
 */
export interface PendingAuthorization {
  state_key: string;
  mcp_client_id: string;
  mcp_redirect_uri: string;
  mcp_state: string | null;
  code_challenge: string;
  code_challenge_method: string;
  scopes: string | null;
  resource: string | null;
  expires_at: number;
}

/**
 * An MCP authorization code issued by us to Claude after Bluesky OAuth
 * completes. Exchanged at /token for an MCP access token.
 */
export interface McpAuthCode {
  code: string;
  client_id: string;
  did: string;
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  scopes: string | null;
  resource: string | null;
  expires_at: number;
}

/**
 * An MCP access/refresh token pair, bound to a Bluesky DID. Access and
 * refresh halves have independent expiries — if they shared one, Claude's
 * connector would never be able to refresh a stale access token, because
 * the matching refresh token would have died at the same moment.
 */
export interface McpToken {
  access_token: string;
  refresh_token: string | null;
  client_id: string;
  did: string;
  scopes: string | null;
  resource: string | null;
  /** Access-token expiry (seconds-since-epoch × 1000). */
  expires_at: number;
  /** Refresh-token expiry (seconds-since-epoch × 1000). Much longer than
   *  `expires_at` — this is what clients rely on to survive idle periods. */
  refresh_expires_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS atproto_oauth_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS atproto_oauth_session (
  did        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id  TEXT PRIMARY KEY,
  info       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_pending_authorizations (
  state_key             TEXT PRIMARY KEY,
  mcp_client_id         TEXT NOT NULL,
  mcp_redirect_uri      TEXT NOT NULL,
  mcp_state             TEXT,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scopes                TEXT,
  resource              TEXT,
  expires_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_auth_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  did                   TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  scopes                TEXT,
  resource              TEXT,
  expires_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  access_token       TEXT PRIMARY KEY,
  refresh_token      TEXT UNIQUE,
  client_id          TEXT NOT NULL,
  did                TEXT NOT NULL,
  scopes             TEXT,
  resource           TEXT,
  expires_at         INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_refresh ON mcp_tokens(refresh_token);
`;

export class Storage {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Idempotent, crash-safe schema migrations for data inherited from older
   * deployments. Each step catches "duplicate column" etc. so re-running on
   * an already-migrated DB is a no-op.
   */
  private migrate(): void {
    try {
      this.db.exec(`ALTER TABLE mcp_tokens ADD COLUMN refresh_expires_at INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists.
    }
    // Existing rows from before this column existed used `expires_at` as a
    // shared deadline for both halves. Preserve that behavior for pre-existing
    // tokens so we don't retroactively extend their lifetime.
    this.db.prepare(
      `UPDATE mcp_tokens SET refresh_expires_at = expires_at WHERE refresh_expires_at = 0`
    ).run();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Delete expired rows from every table that carries an expires_at column.
   * Cheap; safe to call at startup and periodically from a timer.
   */
  gc(now: number = Date.now()): void {
    const stmts = [
      this.db.prepare(`DELETE FROM mcp_pending_authorizations WHERE expires_at < ?`),
      this.db.prepare(`DELETE FROM mcp_auth_codes WHERE expires_at < ?`),
      // Only drop token rows once BOTH the access and refresh halves are
      // dead — otherwise we'd delete valid refresh tokens whose access
      // halves have naturally rotated out.
      this.db.prepare(`DELETE FROM mcp_tokens WHERE refresh_expires_at < ? AND expires_at < ?`),
    ];
    const tokenStmt = stmts[2];
    const auxStmts = stmts.slice(0, 2);
    const tx = this.db.transaction((cutoff: number) => {
      for (const s of auxStmts) s.run(cutoff);
      tokenStmt.run(cutoff, cutoff);
    });
    tx(now);
  }

  // ------------------------------------------------------------------ ATProto state

  atprotoStateStore(): NodeSavedStateStore {
    const getStmt = this.db.prepare(`SELECT value FROM atproto_oauth_state WHERE key = ?`);
    const setStmt = this.db.prepare(
      `INSERT OR REPLACE INTO atproto_oauth_state(key, value, created_at) VALUES (?, ?, ?)`
    );
    const delStmt = this.db.prepare(`DELETE FROM atproto_oauth_state WHERE key = ?`);

    return {
      get: (key) => {
        const row = getStmt.get(key) as { value: string } | undefined;
        return row ? (JSON.parse(row.value) as NodeSavedState) : undefined;
      },
      set: (key, value) => {
        setStmt.run(key, JSON.stringify(value), Date.now());
      },
      del: (key) => {
        delStmt.run(key);
      },
    };
  }

  // ------------------------------------------------------------------ ATProto session

  atprotoSessionStore(): NodeSavedSessionStore {
    const getStmt = this.db.prepare(`SELECT value FROM atproto_oauth_session WHERE did = ?`);
    const setStmt = this.db.prepare(
      `INSERT OR REPLACE INTO atproto_oauth_session(did, value, updated_at) VALUES (?, ?, ?)`
    );
    const delStmt = this.db.prepare(`DELETE FROM atproto_oauth_session WHERE did = ?`);

    return {
      get: (did) => {
        const row = getStmt.get(did) as { value: string } | undefined;
        return row ? (JSON.parse(row.value) as NodeSavedSession) : undefined;
      },
      set: (did, value) => {
        setStmt.run(did, JSON.stringify(value), Date.now());
      },
      del: (did) => {
        delStmt.run(did);
      },
    };
  }

  // ------------------------------------------------------------------ MCP DCR clients

  /**
   * Store of clients registered via RFC 7591 Dynamic Client Registration.
   * The MCP SDK's auth router expects this shape; `registerClient` generates
   * the client_id and client_id_issued_at fields here before persisting.
   */
  mcpClientsStore(): OAuthRegisteredClientsStore {
    const getStmt = this.db.prepare(`SELECT info FROM mcp_oauth_clients WHERE client_id = ?`);
    const insertStmt = this.db.prepare(
      `INSERT INTO mcp_oauth_clients(client_id, info, created_at) VALUES (?, ?, ?)`
    );

    return {
      getClient: (clientId) => {
        const row = getStmt.get(clientId) as { info: string } | undefined;
        return row ? (JSON.parse(row.info) as OAuthClientInformationFull) : undefined;
      },
      registerClient: (client) => {
        const clientId = randomBytes(16).toString("base64url");
        const now = Math.floor(Date.now() / 1000);
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: clientId,
          client_id_issued_at: now,
        };
        insertStmt.run(clientId, JSON.stringify(full), Date.now());
        return full;
      },
    };
  }

  // ------------------------------------------------------------------ Pending authorizations

  putPendingAuthorization(row: PendingAuthorization): void {
    this.db.prepare(
      `INSERT INTO mcp_pending_authorizations
       (state_key, mcp_client_id, mcp_redirect_uri, mcp_state, code_challenge, code_challenge_method, scopes, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.state_key,
      row.mcp_client_id,
      row.mcp_redirect_uri,
      row.mcp_state,
      row.code_challenge,
      row.code_challenge_method,
      row.scopes,
      row.resource,
      row.expires_at,
    );
  }

  consumePendingAuthorization(stateKey: string): PendingAuthorization | undefined {
    const tx = this.db.transaction((key: string) => {
      const row = this.db
        .prepare(`SELECT * FROM mcp_pending_authorizations WHERE state_key = ?`)
        .get(key) as PendingAuthorization | undefined;
      if (row) this.db.prepare(`DELETE FROM mcp_pending_authorizations WHERE state_key = ?`).run(key);
      return row;
    });
    const row = tx(stateKey);
    if (!row) return undefined;
    if (row.expires_at < Date.now()) return undefined;
    return row;
  }

  // ------------------------------------------------------------------ MCP auth codes

  putAuthCode(code: McpAuthCode): void {
    this.db.prepare(
      `INSERT INTO mcp_auth_codes
       (code, client_id, did, code_challenge, code_challenge_method, redirect_uri, scopes, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      code.code,
      code.client_id,
      code.did,
      code.code_challenge,
      code.code_challenge_method,
      code.redirect_uri,
      code.scopes,
      code.resource,
      code.expires_at,
    );
  }

  getAuthCode(code: string): McpAuthCode | undefined {
    const row = this.db.prepare(`SELECT * FROM mcp_auth_codes WHERE code = ?`).get(code) as
      | McpAuthCode
      | undefined;
    if (!row) return undefined;
    if (row.expires_at < Date.now()) return undefined;
    return row;
  }

  consumeAuthCode(code: string): McpAuthCode | undefined {
    const tx = this.db.transaction((c: string) => {
      const row = this.db.prepare(`SELECT * FROM mcp_auth_codes WHERE code = ?`).get(c) as
        | McpAuthCode
        | undefined;
      if (row) this.db.prepare(`DELETE FROM mcp_auth_codes WHERE code = ?`).run(c);
      return row;
    });
    const row = tx(code);
    if (!row) return undefined;
    if (row.expires_at < Date.now()) return undefined;
    return row;
  }

  // ------------------------------------------------------------------ MCP access/refresh tokens

  putToken(token: McpToken): void {
    this.db.prepare(
      `INSERT INTO mcp_tokens
       (access_token, refresh_token, client_id, did, scopes, resource, expires_at, refresh_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      token.access_token,
      token.refresh_token,
      token.client_id,
      token.did,
      token.scopes,
      token.resource,
      token.expires_at,
      token.refresh_expires_at,
    );
  }

  getTokenByAccess(accessToken: string): McpToken | undefined {
    const row = this.db.prepare(`SELECT * FROM mcp_tokens WHERE access_token = ?`).get(accessToken) as
      | McpToken
      | undefined;
    if (!row) return undefined;
    if (row.expires_at < Date.now()) return undefined;
    return row;
  }

  getTokenByRefresh(refreshToken: string): McpToken | undefined {
    const row = this.db.prepare(`SELECT * FROM mcp_tokens WHERE refresh_token = ?`).get(refreshToken) as
      | McpToken
      | undefined;
    if (!row) return undefined;
    if (row.refresh_expires_at < Date.now()) return undefined;
    return row;
  }

  revokeToken(accessOrRefresh: string): void {
    this.db
      .prepare(`DELETE FROM mcp_tokens WHERE access_token = ? OR refresh_token = ?`)
      .run(accessOrRefresh, accessOrRefresh);
  }
}
