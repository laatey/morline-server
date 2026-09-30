import crypto from 'node:crypto';
import { GITHUB_APP_ID, GITHUB_PRIVATE_KEY } from '../config.js';

// Cache tokens by installationId or repo to avoid excessive token minting
const tokenCache = new Map();

/**
 * Generate a RS256 JWT for the GitHub App (valid for 10 minutes)
 */
export function generateGitHubAppJwt() {
  if (!GITHUB_APP_ID || !GITHUB_PRIVATE_KEY) {
    return null;
  }

  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // 60 seconds in the past for clock drift
    exp: now + (10 * 60), // 10 minutes
    iss: GITHUB_APP_ID
  };

  const encodeBase64Url = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');

  const unsignedToken = `${encodeBase64Url(header)}.${encodeBase64Url(payload)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedToken);
  const signature = signer.sign(GITHUB_PRIVATE_KEY, 'base64url');

  return `${unsignedToken}.${signature}`;
}

/**
 * Fetch an installation token for a specific installation ID (cached)
 */
export async function getInstallationToken(installationId) {
  if (!installationId) return null;

  const cached = tokenCache.get(`inst_${installationId}`);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const jwt = generateGitHubAppJwt();
  if (!jwt) return null;

  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Morline-App'
    }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error(`[GitHub App] Failed to mint installation token for ${installationId}:`, err);
    return null;
  }

  const data = await res.json();
  const token = data.token;
  const expiresAt = new Date(data.expires_at).getTime();

  tokenCache.set(`inst_${installationId}`, { token, expiresAt });
  return token;
}

/**
 * Look up the installation for a repo (owner/repo) and mint an access token
 */
export async function getRepoInstallationToken(owner, repo) {
  const cacheKey = `repo_${owner}/${repo}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const jwt = generateGitHubAppJwt();
  if (!jwt) return null;

  try {
    const instRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Morline-App'
      }
    });

    if (!instRes.ok) {
      return null;
    }

    const installation = await instRes.json();
    const token = await getInstallationToken(installation.id);
    if (token) {
      tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 50 * 60 * 1000 });
    }
    return token;
  } catch (err) {
    console.error(`[GitHub App] Error retrieving installation for repo ${owner}/${repo}:`, err.message);
    return null;
  }
}

/**
 * List all installations registered for this GitHub App
 */
export async function listAppInstallations() {
  const jwt = generateGitHubAppJwt();
  if (!jwt) return [];

  const res = await fetch('https://api.github.com/app/installations', {
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Morline-App'
    }
  });

  if (!res.ok) return [];
  return res.json();
}

/**
 * List repositories accessible to an installation
 */
export async function listInstallationRepositories(installationId) {
  const token = await getInstallationToken(installationId);
  if (!token) return [];

  const res = await fetch('https://api.github.com/installation/repositories?per_page=100', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Morline-App'
    }
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.repositories || [];
}
