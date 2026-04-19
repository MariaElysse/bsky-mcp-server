import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { NodeOAuthClient } from "@atproto/oauth-client-node";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import type { Storage } from "./storage.js";
import { BLUESKY_SCOPES } from "./oauth-bluesky.js";

export interface ProviderConfig {
  /** Lifetime of MCP access tokens in seconds. */
  accessTokenTtlSec: number;
  /** Lifetime of MCP refresh tokens in seconds. Must be longer than
   *  accessTokenTtlSec — otherwise clients can never refresh a stale
   *  access token because the matching refresh token has died too. */
  refreshTokenTtlSec: number;
  /** Lifetime of MCP authorization codes in seconds. */
  authCodeTtlSec: number;
  /** Lifetime of a pending authorization (login page timeout). */
  pendingAuthTtlSec: number;
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  accessTokenTtlSec: 60 * 60,             // 1h
  refreshTokenTtlSec: 30 * 24 * 60 * 60,  // 30 days — long enough that an
                                          // idle connector can still refresh.
  authCodeTtlSec: 60,                     // 60s — code must be exchanged quickly
  pendingAuthTtlSec: 15 * 60,             // 15m — user has 15min to complete login
};

/**
 * Implements the MCP SDK's OAuthServerProvider by federating to Bluesky
 * OAuth. When Claude's client hits /authorize, we serve a handle-entry form;
 * on submit, we start ATProto OAuth and let the user's PDS do the actual
 * identity check. The PDS redirects to /oauth/callback, at which point we
 * complete ATProto OAuth and finish Claude's flow by issuing an MCP
 * authorization code bound to the resolved DID.
 */
export class BlueskyFederatedProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = false;

  constructor(
    private readonly storage: Storage,
    private readonly bsky: NodeOAuthClient,
    private readonly config: ProviderConfig = DEFAULT_PROVIDER_CONFIG,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.storage.mcpClientsStore();
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const stateKey = randomBytes(24).toString("base64url");
    this.storage.putPendingAuthorization({
      state_key: stateKey,
      mcp_client_id: client.client_id,
      mcp_redirect_uri: params.redirectUri,
      mcp_state: params.state ?? null,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
      scopes: params.scopes?.join(" ") ?? null,
      resource: params.resource?.toString() ?? null,
      expires_at: Date.now() + this.config.pendingAuthTtlSec * 1000,
    });
    res.type("html").send(renderLoginPage(stateKey, client.client_name));
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = this.storage.getAuthCode(authorizationCode);
    if (!row) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.storage.consumeAuthCode(authorizationCode);
    if (!row) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (row.client_id !== client.client_id) {
      throw new InvalidClientError("Authorization code was issued to a different client");
    }
    if (redirectUri && redirectUri !== row.redirect_uri) {
      throw new InvalidRequestError("redirect_uri does not match the one used during authorization");
    }
    return this.issueTokens(client.client_id, row.did, row.scopes, row.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const existing = this.storage.getTokenByRefresh(refreshToken);
    if (!existing) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (existing.client_id !== client.client_id) {
      throw new InvalidClientError("Refresh token was issued to a different client");
    }
    // Rotate: discard the old pair so an intercepted refresh token can't be
    // replayed after we've already used it.
    this.storage.revokeToken(existing.access_token);
    return this.issueTokens(existing.client_id, existing.did, existing.scopes, existing.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.storage.getTokenByAccess(token);
    if (!row) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes?.split(" ").filter(Boolean) ?? [],
      expiresAt: Math.floor(row.expires_at / 1000),
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { did: row.did },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.storage.revokeToken(request.token);
  }

  private issueTokens(
    clientId: string,
    did: string,
    scopes: string | null,
    resource: string | null,
  ): OAuthTokens {
    const access = randomBytes(32).toString("base64url");
    const refresh = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.storage.putToken({
      access_token: access,
      refresh_token: refresh,
      client_id: clientId,
      did,
      scopes,
      resource,
      expires_at: now + this.config.accessTokenTtlSec * 1000,
      refresh_expires_at: now + this.config.refreshTokenTtlSec * 1000,
    });
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSec,
      scope: scopes ?? undefined,
    };
  }
}

/**
 * POST /oauth/login — user submitted a handle on the login page.
 * We start Bluesky OAuth, using the MCP state key as the ATProto state so
 * the callback can pair the PDS redirect back to the pending MCP auth row.
 */
export function loginHandler(bsky: NodeOAuthClient, storage: Storage) {
  return async (req: Request, res: Response): Promise<void> => {
    const stateKey = String(req.body?.state ?? req.query?.state ?? "");
    const handle = String(req.body?.handle ?? "").trim();

    if (!stateKey) {
      res.status(400).type("html").send(renderErrorPage("Missing state", "The login link is incomplete."));
      return;
    }
    if (!handle) {
      res.status(400).type("html").send(renderLoginPage(stateKey, undefined, "Please enter your Bluesky handle."));
      return;
    }

    // Sanity-check the pending row still exists (and hasn't expired) before
    // we bother bouncing through the PDS.
    const pending = storage.db
      .prepare(`SELECT expires_at FROM mcp_pending_authorizations WHERE state_key = ?`)
      .get(stateKey) as { expires_at: number } | undefined;
    if (!pending) {
      res.status(400).type("html").send(renderErrorPage("Session expired", "Please start the login flow again from your client."));
      return;
    }

    try {
      const url = await bsky.authorize(handle, { state: stateKey });
      res.redirect(url.toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).type("html").send(renderLoginPage(stateKey, undefined, `Could not start Bluesky sign-in: ${message}`));
    }
  };
}

/**
 * GET /oauth/callback — PDS redirected back here after the user approved
 * (or denied) the OAuth request. We complete ATProto OAuth, look up the
 * pending MCP authorization, mint an MCP auth code, and redirect to Claude.
 */
export function callbackHandler(bsky: NodeOAuthClient, storage: Storage, config: ProviderConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    const params = new URLSearchParams(req.url.split("?")[1] ?? "");

    try {
      const { session, state } = await bsky.callback(params);
      if (!state) {
        res.status(400).type("html").send(renderErrorPage("Missing state", "The PDS callback did not carry a state parameter."));
        return;
      }

      const pending = storage.consumePendingAuthorization(state);
      if (!pending) {
        res.status(400).type("html").send(renderErrorPage("Session expired", "Your login session expired before Bluesky redirected back. Please try again from your client."));
        return;
      }

      const code = randomBytes(32).toString("base64url");
      storage.putAuthCode({
        code,
        client_id: pending.mcp_client_id,
        did: session.did,
        code_challenge: pending.code_challenge,
        code_challenge_method: pending.code_challenge_method,
        redirect_uri: pending.mcp_redirect_uri,
        scopes: pending.scopes,
        resource: pending.resource,
        expires_at: Date.now() + config.authCodeTtlSec * 1000,
      });

      // Encode query params via encodeURIComponent rather than
      // URLSearchParams. URLSearchParams follows the HTML form-encoding rule
      // that turns spaces into `+`, which is fine per RFC 6749 but trips up
      // OAuth clients whose state/PKCE values contain characters they
      // themselves mis-encoded on the way in (e.g. one that URL-encoded the
      // base64 `+` as `%20` rather than `%2B`). encodeURIComponent emits
      // `%20` for space and round-trips symmetrically for every byte, so
      // whatever bytes they sent land back in their callback unchanged.
      const parts = [`code=${encodeURIComponent(code)}`];
      if (pending.mcp_state) {
        parts.push(`state=${encodeURIComponent(pending.mcp_state)}`);
      }
      const sep = pending.mcp_redirect_uri.includes("?") ? "&" : "?";
      res.redirect(pending.mcp_redirect_uri + sep + parts.join("&"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).type("html").send(renderErrorPage("Bluesky sign-in failed", message));
    }
  };
}

// -----------------------------------------------------------------------------
// Minimal HTML for the login + error pages. Intentionally plain — nobody
// should be pointing a mobile browser at this for long.

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]!));
}

function renderLoginPage(stateKey: string, clientName?: string, errorMessage?: string): string {
  const who = clientName ? `<p>${escapeHtml(clientName)} is requesting access to your Bluesky account.</p>` : "";
  const err = errorMessage
    ? `<p style="color:#b00020">${escapeHtml(errorMessage)}</p>`
    : "";
  const scopes = BLUESKY_SCOPES.join(" ");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in with Bluesky</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
  input[type=text]{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box;margin:.3rem 0}
  button{padding:.6rem 1rem;font-size:1rem;cursor:pointer}
  code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px;font-size:.9rem}
</style></head>
<body>
<h1>Sign in with Bluesky</h1>
${who}
${err}
<form method="POST" action="/oauth/login">
  <input type="hidden" name="state" value="${escapeHtml(stateKey)}">
  <label>Your Bluesky handle<br>
    <input type="text" name="handle" placeholder="alice.bsky.social" autocomplete="username" required autofocus>
  </label>
  <button type="submit">Continue</button>
</form>
<p style="font-size:.9rem;color:#666">Requested scopes: <code>${escapeHtml(scopes)}</code>. You'll be redirected to your PDS to approve.</p>
</body></html>`;
}

function renderErrorPage(title: string, detail: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p>
</body></html>`;
}
