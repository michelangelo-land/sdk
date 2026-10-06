/**
 * Canonical endpoints — single source of truth is the live swagger:
 *   https://api.michelangelo.land/v1/openapi.json
 * (`scripts/sync-openapi.mjs` vendors it to `openapi/openapi.json`,
 *  `scripts/contract-check.mjs` fails if these defaults drift from it.)
 *
 * Values below mirror openapi.json:
 * - servers[0].url            → DEFAULT_API_BASE_URL
 * - components.securitySchemes.oauth2.flows.authorizationCode
 *                             → authorizationUrl / tokenUrl
 */

export const DEFAULT_API_BASE_URL = "https://api.michelangelo.land/v1";

export const DEFAULT_AUTH_BASE_URL = "https://auth.michelangelo.land/auth/v1";

export const AUTHORIZE_URL = `${DEFAULT_AUTH_BASE_URL}/oauth/authorize`;

export const TOKEN_URL = `${DEFAULT_AUTH_BASE_URL}/oauth/token`;

export const DCR_URL = `${DEFAULT_AUTH_BASE_URL}/oauth/clients/register`;

export const DISCOVERY_URL = `${DEFAULT_AUTH_BASE_URL}/.well-known/oauth-authorization-server`;

export const DEFAULT_SCOPES = ["openid", "email", "profile"] as const;
