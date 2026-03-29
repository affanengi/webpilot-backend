const express = require("express");
const router = express.Router();
const oauthService = require("../services/oauth");
const admin = require("../services/firebase");
const db = require("../services/firestore");

// GET /auth/:provider/login
// Expects ?token=<firebase_id_token>&returnUrl=<url>
const authMiddleware = require("../middleware/auth");

router.get("/:provider/login", authMiddleware, async (req, res) => {
    const { provider } = req.params;
    const { returnUrl } = req.query;
    const { uid } = req.user; // Set by authMiddleware

    // Prevent caching of the redirect to ensure fresh parameters (like scope) are always used
    res.set("Cache-Control", "no-store, max-age=0");

    try {
        const authUrl = oauthService.generateAuthUrl(provider, returnUrl, { uid });
        res.redirect(authUrl);

    } catch (error) {
        console.error("Login initialization error:", error);
        res.status(500).send(`Login initialization failed: ${error.message}\n${error.stack}`);
    }
});

// GET /auth/:provider/callback
router.get("/:provider/callback", async (req, res) => {
    const { provider } = req.params;
    const { code, state, error, error_description } = req.query;

    if (error) {
        console.error("OAuth Provider Error:", error, error_description);
        return res.status(400).send(`Authentication failed: ${error} - ${error_description}`);
    }

    if (!code || !state) {
        return res.status(400).send("Invalid callback parameters.");
    }

    try {
        // Decode state
        const stateData = oauthService.decodeState(state); // returns returnsUrl? 
        // Wait, the current `decodeState` returns just the returnUrl string.
        // I need the whole object (uid, returnUrl).
        // I need to update the service BEFORE validly running this.
        // But I am creating this file now.

        // I will write code assuming the updated service API:
        // oauthService.decodeState(state) -> { returnUrl, uid, nonce }

        const { uid, returnUrl } = stateData;

        if (!uid) {
            return res.status(400).send("State validation failed: Missing user context.");
        }

        // Exchange code for tokens
        const tokens = await oauthService.getTokens(provider, code);

        // DEBUG: Log the keys to see what we actually get
        console.log(`[OAuth] ${provider} tokens received. Keys:`, Object.keys(tokens));

        // Robust extraction: Check for snake_case (standard) and camelCase (potential wrapper)
        const refreshToken = tokens.refresh_token || tokens.refreshToken || null;

        // Get user profile (optional, mainly for ID/Email verification)
        const profile = await oauthService.getUserProfile(provider, tokens.access_token);

        // Save to Firestore
        const tokenData = {
            accessToken: tokens.access_token,
            refreshToken: refreshToken, // Google only sends this on first consent or forced prompt
            providerUserId: profile.providerUserId,
            email: profile.email,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        };

        if (tokens.expires_in) {
            tokenData.expiresAt = new Date(Date.now() + (tokens.expires_in * 1000));
        }

        // Remove undefined keys
        Object.keys(tokenData).forEach(key => tokenData[key] === undefined && delete tokenData[key]);

        await db.collection("users").doc(uid).collection("connected_accounts").doc(provider).set(tokenData, { merge: true });

        res.redirect(returnUrl || "/settings");

    } catch (error) {
        console.error("OAuth callback error:", error);
        res.status(500).send(`Authentication failed: ${error.message}`);
    }
});

// DELETE /auth/:provider
// Disconnect logic: Remove connection AND dependent automations
// DELETE /auth/:provider
// Disconnect logic: Remove connection AND dependent automations
router.delete("/:provider", authMiddleware, async (req, res) => {
    const { provider } = req.params;
    const { uid } = req.user;

    if (!provider) {
        return res.status(400).send("Provider is required.");
    }

    try {
        const batch = db.batch();

        // 1. Query dependent automations
        // Ensure the field name matches exactly what is stored in automations.js (connected_account_type)
        const automationsRef = db.collection("users").doc(uid).collection("automations");
        const automationsSnapshot = await automationsRef.where("connected_account_type", "==", provider).get();

        // 2. Queue automation deletes
        if (!automationsSnapshot.empty) {
            automationsSnapshot.docs.forEach((doc) => {
                batch.delete(doc.ref);
            });
            console.log(`[Disconnect] Queued deletion for ${automationsSnapshot.size} automations for user ${uid}.`);
        } else {
            console.log(`[Disconnect] No dependent automations found for user ${uid} and provider ${provider}.`);
        }

        // 3. Queue connection delete
        const connectionRef = db.collection("users").doc(uid).collection("connected_accounts").doc(provider);
        batch.delete(connectionRef);

        // 4. Commit atomic batch
        // Even if automationsSnapshot is empty, the batch will successfully delete the connectionRef
        await batch.commit();

        console.log(`[Disconnect] User ${uid} disconnected ${provider} successfully.`);

        res.json({
            success: true,
            message: `Disconnected ${provider}. Deleted ${automationsSnapshot.size} related automations.`
        });

    } catch (error) {
        console.error("Disconnect error:", error);
        res.status(500).send("Failed to disconnect.");
    }
});

module.exports = router;
