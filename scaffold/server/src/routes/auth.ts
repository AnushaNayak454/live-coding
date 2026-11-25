/**
 * Auth routes: OIDC authorization code flow with PKCE S256.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import * as jose from 'jose';

const router = Router();

// OIDC discovery cache
let oidcConfig: any = null;
let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

async function getOidcConfig() {
  if (oidcConfig) return oidcConfig;
  const res = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`);
  oidcConfig = await res.json();
  return oidcConfig;
}

async function getJwks() {
  if (jwks) return jwks;
  const cfg = await getOidcConfig();
  jwks = jose.createRemoteJWKSet(new URL(cfg.jwks_uri));
  return jwks;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * GET /auth/login
 * Redirect to IdP with PKCE S256.
 */
router.get('/login', async (req: Request, res: Response) => {
  try {
    const cfg = await getOidcConfig();

    const codeVerifier = base64url(randomBytes(32));
    const codeChallenge = base64url(
      createHash('sha256').update(codeVerifier).digest()
    );
    const state = base64url(randomBytes(16));
    const nonce = base64url(randomBytes(16));

    // Store in session
    (req as any).session.oidc = { codeVerifier, state, nonce };
    await new Promise<void>((resolve, reject) =>
      (req as any).session.save((err: any) => (err ? reject(err) : resolve()))
    );

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.oidc.clientId,
      redirect_uri: config.oidc.redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return res.redirect(`${cfg.authorization_endpoint}?${params}`);
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).send('Login failed');
  }
});

/**
 * GET /auth/callback
 * Exchange code for tokens, verify ID token, set session.
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query as Record<string, string>;

    if (error) {
      return res.status(400).send(`IdP error: ${error}`);
    }

    const session = (req as any).session;
    const oidcSession = session.oidc;

    if (!oidcSession || oidcSession.state !== state) {
      return res.status(400).send('Invalid state parameter');
    }

    const cfg = await getOidcConfig();

    // Exchange code for tokens
    const tokenRes = await fetch(cfg.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.oidc.redirectUri,
        client_id: config.oidc.clientId,
        client_secret: config.oidc.clientSecret,
        code_verifier: oidcSession.codeVerifier,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error('Token exchange failed:', body);
      return res.status(400).send('Token exchange failed');
    }

    const tokens = await tokenRes.json() as { id_token: string; access_token: string };

    // Verify ID token
    const jwtKeySet = await getJwks();
    const { payload } = await jose.jwtVerify(tokens.id_token, jwtKeySet, {
      issuer: config.oidc.issuer,
      audience: config.oidc.clientId,
    });

    // Validate nonce
    if (payload.nonce !== oidcSession.nonce) {
      return res.status(400).send('Nonce mismatch');
    }

    // Extract user info from claims
    const workspacesClaim = (payload.workspaces as any[]) ?? [];
    const user = {
      sub: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
      workspaces: workspacesClaim.map((w: any) => ({
        id: w.id,
        role: w.role,
      })),
    };

    // Set session
    session.oidc = null;
    session.user = user;
    await new Promise<void>((resolve, reject) =>
      session.save((err: any) => (err ? reject(err) : resolve()))
    );

    // Redirect to frontend
    return res.redirect(config.webOrigin);
  } catch (err) {
    console.error('Callback error:', err);
    return res.status(500).send('Authentication failed');
  }
});

/**
 * GET /auth/logout
 */
router.get('/logout', (req: Request, res: Response) => {
  (req as any).session.destroy(() => {
    res.redirect(config.webOrigin);
  });
});

export default router;
