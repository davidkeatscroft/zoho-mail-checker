import { REGIONS, SCOPES, regionFromRedirect } from './config.js';

export class AuthExpiredError extends Error {}

function randomState() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function postToken(accountsOrigin, params) {
  const response = await fetch(`${accountsOrigin}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    throw new Error(`Zoho sign-in server returned an unreadable response (HTTP ${response.status})`);
  }
  return { ok: response.ok && !data.error, data };
}

// Opens Zoho's consent window. Must run from a page, since the window can stay open for minutes.
export async function authorize({ clientId, clientSecret, region }) {
  const redirectUri = browser.identity.getRedirectURL();
  const state = randomState();
  const authUrl = new URL(`${REGIONS[region].accounts}/oauth/v2/auth`);
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: redirectUri,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  const redirected = new URL(await browser.identity.launchWebAuthFlow({ url: authUrl.href, interactive: true }));
  const params = redirected.searchParams;
  if (params.get('state') !== state) throw new Error('Sign-in was rejected because the state did not match. Please try again.');
  if (params.get('error')) throw new Error(`Zoho refused sign-in: ${params.get('error')}`);
  if (!params.get('code')) throw new Error('Zoho did not return an authorization code.');

  const userRegion = regionFromRedirect(params.get('accounts-server'), params.get('location'), region);
  const { ok, data } = await postToken(REGIONS[userRegion].accounts, {
    grant_type: 'authorization_code',
    code: params.get('code'),
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    scope: SCOPES,
  });
  if (!ok || !data.access_token) throw new Error(`Zoho refused the token request: ${data.error || 'unknown error'}`);
  if (!data.refresh_token) throw new Error('Zoho did not return a refresh token. Check the client is a "Server-based Application".');

  return {
    region: userRegion,
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

export async function refreshAccessToken(connection, { clientId, clientSecret }) {
  const { ok, data } = await postToken(REGIONS[connection.region].accounts, {
    grant_type: 'refresh_token',
    refresh_token: connection.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (!ok || !data.access_token) {
    if (['invalid_code', 'invalid_client', 'invalid_client_secret', 'unauthorized_client'].includes(data.error)) {
      throw new AuthExpiredError(`Zoho rejected the saved sign-in (${data.error}).`);
    }
    // Anything else, such as Zoho's rate limit on this endpoint, is worth retrying next poll.
    throw new Error(data.error_description || data.error || 'Could not refresh the Zoho sign-in.');
  }
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

export async function revokeRefreshToken(connection) {
  const url = new URL(`${REGIONS[connection.region].accounts}/oauth/v2/token/revoke`);
  url.searchParams.set('token', connection.refreshToken);
  await fetch(url.href, { method: 'POST' });
}
