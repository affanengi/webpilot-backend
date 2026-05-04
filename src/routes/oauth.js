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
// Disconnect logic: Disable dependent automations (do NOT delete them) and remove the token doc
router.delete("/:provider", authMiddleware, async (req, res) => {
    const { provider } = req.params;
    const { uid } = req.user;

    if (!provider) {
        return res.status(400).send("Provider is required.");
    }

    try {
        const automationsRef = db.collection("users").doc(uid).collection("automations");

        // Query 1: automations where connected_account_type matches
        const byTypeSnapshot = await automationsRef
            .where("connected_account_type", "==", provider)
            .get();

        // Query 2: automations where connected_accounts array contains the provider
        const byArraySnapshot = await automationsRef
            .where("connected_accounts", "array-contains", provider)
            .get();

        // Merge unique automation docs (deduplicate by id)
        const seenIds = new Set();
        const docsToDisable = [];

        [...byTypeSnapshot.docs, ...byArraySnapshot.docs].forEach((docSnap) => {
            if (!seenIds.has(docSnap.id)) {
                seenIds.add(docSnap.id);
                docsToDisable.push(docSnap);
            }
        });

        // Batch: disable automations (not delete) + remove connection token
        const batch = db.batch();

        docsToDisable.forEach((docSnap) => {
            batch.update(docSnap.ref, {
                status: "disconnected",
                disconnectedProvider: provider,
                disconnectedAt: new Date().toISOString()
            });
        });

        // Remove the connected account token doc
        const connectionRef = db.collection("users").doc(uid).collection("connected_accounts").doc(provider);
        batch.delete(connectionRef);

        await batch.commit();

        console.log(`[Disconnect] User ${uid} disconnected ${provider}. Disabled ${docsToDisable.length} automation(s).`);

        res.json({
            success: true,
            message: `Disconnected ${provider}. ${docsToDisable.length} workflow(s) have been disabled. Reconnect ${provider} and re-save them to re-enable.`
        });

    } catch (error) {
        console.error("Disconnect error:", error);
        res.status(500).send("Failed to disconnect.");
    }
});

module.exports = router;
