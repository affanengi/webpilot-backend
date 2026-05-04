const axios = require("axios");
const crypto = require("crypto");

const PROVIDERS = {
    google: {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
        profileUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
        envPrefix: "GOOGLE"
    },
    gmail: {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
        profileUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
        envPrefix: "GOOGLE" // Reuses existing Google OAuth credentials
    },
    google_drive: {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
        profileUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
        envPrefix: "GOOGLE" // Reusing standard Google credentials
    },
    google_sheets: {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
        profileUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
        envPrefix: "GOOGLE" // Reusing standard Google credentials
    },
    youtube: {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
        profileUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
        envPrefix: "GOOGLE"
    },
    google_docs: {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
        profileUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
        envPrefix: "GOOGLE"
    },
    linkedin: {
        authUrl: "https://www.linkedin.com/oauth/v2/authorization",
        tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
        scope: "openid profile email w_member_social",
        profileUrl: "https://api.linkedin.com/v2/userinfo",
        envPrefix: "LINKEDIN"
    },
    notion: {
        authUrl: "https://api.notion.com/v1/oauth/authorize",
        tokenUrl: "https://api.notion.com/v1/oauth/token",
        scope: "", // Notion manages scope implicitly via integration settings
        // API doesn't have a simple userinfo endpoint, but we can query bot info
        profileUrl: "https://api.notion.com/v1/users/me",
        envPrefix: "NOTION",
        useBasicAuthForToken: true, // Notion requires Basic Auth for token exchange
        useJsonPayload: true, // Notion requires token exchange payload to be JSON
        customHeaders: {
            "Notion-Version": "2022-06-28" 
        }
    },
    instagram: {
        // We use Facebook OAuth for Instagram Graph API (Professional Accounts)
        authUrl: "https://www.facebook.com/v20.0/dialog/oauth",
        tokenUrl: "https://graph.facebook.com/v20.0/oauth/access_token",
        // Scopes necessary to list pages, linked IG accounts, and publish
        scope: "instagram_basic instagram_content_publish pages_show_list pages_read_engagement",
        profileUrl: "https://graph.facebook.com/me?fields=id,name,email,picture",
        envPrefix: "INSTAGRAM"
    }
};

/**
 * Generates the OAuth2 Authorization URL
 * @param {string} provider - 'google' or 'linkedin'
 * @param {string} returnUrl - URL to redirect back to after success
 * @param {object} metadata - Optional metadata to include in the state parameter
 * @returns {string} - The authorization URL
 */
exports.generateAuthUrl = (provider, returnUrl = "/settings", metadata = {}) => {
    if (!PROVIDERS[provider]) {
        console.error(`Error: generateAuthUrl called with invalid provider: '${provider}'`);
        throw new Error("Invalid provider");
    }

    const config = PROVIDERS[provider];

    // Create a secure state object
    const stateData = {
        nonce: crypto.randomBytes(16).toString("hex"),
        returnUrl,
        ...metadata
    };
    const state = Buffer.from(JSON.stringify(stateData)).toString("base64");

    const baseUrl = process.env.REDIRECT_URI || process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
    const envPrefix = config.envPrefix || provider.toUpperCase();

    const params = new URLSearchParams({
        client_id: process.env[`${envPrefix}_CLIENT_ID`],
        redirect_uri: `${baseUrl}/auth/${provider}/callback`, // Flexible fallbacks
        response_type: "code",
        scope: config.scope,
        state: state,
        access_type: "offline", // For Google refresh tokens
        prompt: "consent", // Force consent for refresh token
    });

    if (envPrefix === "GOOGLE") {
        params.append("include_granted_scopes", "true");
    }

    return `${config.authUrl}?${params.toString()}`;
};

/**
 * Exchanges auth code for tokens
 * @param {string} provider 
 * @param {string} code 
 * @returns {Promise<object>} tokens
 */
exports.getTokens = async (provider, code) => {
    if (!PROVIDERS[provider]) {
        console.error(`Error: getTokens called with invalid provider: '${provider}'`);
        throw new Error("Invalid provider");
    }

    const config = PROVIDERS[provider];
    const baseUrl = process.env.REDIRECT_URI || process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
    const redirectUri = `${baseUrl}/auth/${provider}/callback`;
    const envPrefix = config.envPrefix || provider.toUpperCase();

    let payload;
    let headers = { ...config.customHeaders }; // Start with any custom headers

    if (config.useJsonPayload) {
        payload = {
            grant_type: "authorization_code",
            code: code,
            redirect_uri: redirectUri
        };
        headers["Content-Type"] = "application/json";
    } else {
        payload = new URLSearchParams();
        payload.append("code", code);
        payload.append("grant_type", "authorization_code");
        payload.append("redirect_uri", redirectUri);
        headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    if (config.useBasicAuthForToken) {
        // e.g. Notion requires basic auth for token exchange
        const clientId = process.env[`${envPrefix}_CLIENT_ID`];
        const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`];
        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        headers["Authorization"] = `Basic ${credentials}`;
    } else {
        if (config.useJsonPayload) {
            // For JSON payloads, if it doesn't use Basic Auth, it expects them in the body
            payload.client_id = process.env[`${envPrefix}_CLIENT_ID`];
            payload.client_secret = process.env[`${envPrefix}_CLIENT_SECRET`];
        } else {
            payload.append("client_id", process.env[`${envPrefix}_CLIENT_ID`]);
            payload.append("client_secret", process.env[`${envPrefix}_CLIENT_SECRET`]);
        }
    }

    const response = await axios.post(config.tokenUrl, payload, { headers });

    return response.data;
};

/**
 * Fetches user profile from provider
 * @param {string} provider 
 * @param {string} accessToken 
 * @returns {Promise<object>} { id, email, name, picture }
 */
exports.getUserProfile = async (provider, accessToken) => {
    if (!PROVIDERS[provider]) throw new Error("Invalid provider");

    const config = PROVIDERS[provider];

    const headers = { 
        Authorization: `Bearer ${accessToken}`,
        ...config.customHeaders
    };

    const response = await axios.get(config.profileUrl, { headers });

    const data = response.data;

    // Normalize data
    if (provider === "google" || provider === "gmail" || provider === "youtube" || provider === "google_drive" || provider === "google_sheets" || provider === "google_docs") {
        return {
            providerUserId: data.id,
            email: data.email,
            name: data.name,
            picture: data.picture
        };
    } else if (provider === "linkedin") {
        return {
            providerUserId: data.sub,
            email: data.email,
            name: data.name,
            picture: data.picture
        };
    } else if (provider === "instagram") {
        return {
            providerUserId: data.id, // Facebook ID
            email: data.email,
            name: data.name,
            picture: data.picture?.data?.url || null
        };
    } else if (provider === "notion") {
        return {
            // Notion API for "users/me" returns bot information when using an integration token
            providerUserId: data.bot?.owner?.user?.id || data.id,
            email: data.bot?.owner?.user?.person?.email || null,
            name: data.bot?.owner?.user?.name || data.name || "Notion Integration",
            picture: data.bot?.owner?.user?.avatar_url || data.avatar_url || null
        };
    }
};

/**
 * Decodes and validates state
 * @param {string} state - Base64 encoded JSON
 * @returns {string} - The returnUrl
 */
exports.decodeState = (state) => {
    try {
        if (!state) return { returnUrl: "/settings" };
        const json = Buffer.from(state, "base64").toString("utf-8");
        const data = JSON.parse(json);
        return { returnUrl: "/settings", ...data };
    } catch (e) {
        console.error("State decode error:", e);
        return "/settings";
    }
};

/**
 * Refreshes the access token using the refresh token
 * @param {string} provider 
 * @param {string} refreshToken 
 * @returns {Promise<object>} new tokens
 */
exports.refreshAccessToken = async (provider, refreshToken) => {
    if (!PROVIDERS[provider]) {
        throw new Error("Invalid provider");
    }

    const config = PROVIDERS[provider];
    const envPrefix = config.envPrefix || provider.toUpperCase();

    let payload;
    let headers = { ...config.customHeaders };

    if (config.useJsonPayload) {
        payload = {
            grant_type: "refresh_token",
            refresh_token: refreshToken
        };
        headers["Content-Type"] = "application/json";
    } else {
        payload = new URLSearchParams();
        payload.append("refresh_token", refreshToken);
        payload.append("grant_type", "refresh_token");
        headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    if (config.useBasicAuthForToken) {
        const clientId = process.env[`${envPrefix}_CLIENT_ID`];
        const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`];
        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        headers["Authorization"] = `Basic ${credentials}`;
    } else {
        if (config.useJsonPayload) {
            payload.client_id = process.env[`${envPrefix}_CLIENT_ID`];
            payload.client_secret = process.env[`${envPrefix}_CLIENT_SECRET`];
        } else {
            payload.append("client_id", process.env[`${envPrefix}_CLIENT_ID`]);
            payload.append("client_secret", process.env[`${envPrefix}_CLIENT_SECRET`]);
        }
    }

    const response = await axios.post(config.tokenUrl, payload, { headers });
    return response.data;
};
