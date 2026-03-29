# IMPL-oauth-n8n-infra: OAuth2 & Automation Infrastructure

## 1. Overview
This plan outlines the backend infrastructure for handling OAuth2 authentication (Google, LinkedIn) and triggering n8n automations. The system will securely manage user tokens, verify automation ownership, and log all execution attempts.

## 2. Architecture

### 2.1 OAuth2 Authentication
We will implement a backend-handled OAuth2 flow to keep client secrets secure.

#### Endpoints

*   **`GET /auth/:provider/login`**
    *   **Input**: `provider` (google, linkedin)
    *   **Logic**:
        *   Accepts query param `returnUrl` (default: `/settings`).
        *   Generates a secure `state` string: `base64(JSON.stringify({ nonce: <random>, returnUrl: <encoded_url> }))`.
        *   Constructs the provider's authorization URL with:
            *   `client_id` (from env)
            *   `redirect_uri` (e.g., `https://api.domain.com/auth/:provider/callback`)
            *   `response_type=code`
            *   `scope` (configured per provider, e.g., `openid email profile`, `w_member_social`)
            *   `state` (for CSRF protection and redirect context)
        *   Redirects the user to this URL.
*   **`GET /auth/:provider/callback`**
    *   **Input**: Query params `code`, `state`
    *   **Logic**:
        *   Exchanges `code` for `access_token` (and `refresh_token` if available) via direct HTTP POST to provider.
        *   Fetches user profile (email, id) using the access token.
        *   **State Validation**: Decodes `state` param, validates nonce (optional if stateless but recommended), and extracts `returnUrl`.
        *   **Storage**: Saves tokens to Firestore: `users/{uid}/connected_accounts/{provider}`.
            *   Fields: `accessToken`, `refreshToken`, `expiresAt`, `providerUserId`, `email`, `lastUpdated`.
        *   Redirects user back to `returnUrl` (e.g., `/dashboard`, `/settings`).

### 2.2 Automation Trigger
A secure endpoint to trigger n8n workflows.

#### Endpoint

*   **`POST /automations/run`**
    *   **Middleware**: `authMiddleware` (Enforces valid Firebase ID Token).
    *   **Input**: JSON body `{ "automationId": "doc-id-123" }`
    *   **Logic**:
        1.  **Fetch Automation**: Get document `automations/{automationId}` from Firestore.
        2.  **Ownership Check**: Verify `automation.uid === req.user.uid`. If mismatch, return 403.
        3.  **Prepare Payload**: Construct payload for n8n.
            *   Include: `userId`, `automationId`, `payload` (input data).
        4.  **Call n8n**: Send POST request to n8n webhook URL.
            *   URL: `https://n8n.affanmohd.online/webhook/{n8nWebhookId}` (webhookId stored in automation doc).
            *   Headers: `X-N8N-API-KEY: <env_var>`
            *   Body: `{ ...payload }`
        5.  **Log Execution**: Save result to Firestore (see 2.3).
        6.  **Response**: Return `{ success: true, executionId: "..." }`.

### 2.3 Logging (Firestore)
Collection: `executions`

*   `uid`: (string) User ID triggering the run.
*   `automationId`: (string) Reference to the automation.
*   `status`: (string) 'SUCCESS' | 'FAILED'.
*   `timestamp`: (timestamp) Server time.
*   `n8nResponse`: (object) The JSON response from n8n or error details.
*   `requestPayload`: (object) Data sent to n8n (sanitized).

## 3. Dependencies
*   `axios`: For making HTTP requests to OAuth providers and n8n.
*   `google-auth-library` (Optional, but `axios` is sufficient for raw REST calls if we want to keep it lightweight).
*   `dotenv`: Already installed.

## 4. Implementation Steps

### Phase 1: OAuth Implementation
1.  Add `CLIENT_ID`, `CLIENT_SECRET`, `REDIRECT_URI` to `.env`.
2.  Create `src/services/oauth.js` to handle token exchange logic.
3.  Create `src/routes/oauth.js` with login and callback routes.
4.  Register routes in `index.js`.

### Phase 2: Automation & n8n
1.  Add `N8N_API_KEY` and `N8N_BASE_URL` to `.env`.
2.  Create `src/services/n8n.js` for API interaction.
3.  Create `src/routes/automations.js`.
4.  Implement `POST /run` with ownership validation.
5.  Implement Firestore logging.

## 5. Verification Plan
*   **Manual**: Test Google/LinkedIn login flow via browser. Check Firestore for saved tokens.
*   **Manual**: Trigger automation via Postman with valid/invalid tokens. Verify n8n receipt and Firestore execution log.
*   **Security**: Verify that user A cannot trigger user B's automation.
