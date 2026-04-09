const express = require('express');
const router = express.Router();
const db = require('../services/firestore');
const admin = require('../services/firebase');
const authMiddleware = require('../middleware/auth');
const n8nService = require('../services/n8n');
const oauthService = require('../services/oauth');
const aiService = require('../services/aiService');
const { automations: templateAutomations } = require('../data/automations');
const axios = require('axios');

/**
 * Helper — reads a user's OAuth token from the connected_accounts subcollection
 * (same path as workflowEngine uses), auto-refreshes if expired.
 * Returns the raw accessToken string or null if not connected.
 */
async function getUserToken(uid, provider) {
    // We must NOT alias google_drive or gmail to google to avoid Scope Insufficiency errors.
    const aliases = [provider];

    let tokenData = null;
    let tokenDocRef = null;

    for (const alias of aliases) {
        const tokenDoc = await db.collection("users").doc(uid).collection("connected_accounts").doc(alias).get();
        if (tokenDoc.exists) {
            tokenData = tokenDoc.data();
            tokenDocRef = tokenDoc.ref;
            break;
        }
    }

    if (!tokenData) return null;

    // Auto-refresh if within 5 minutes of expiry
    const isExpired = tokenData.expiresAt && tokenData.expiresAt.toDate() < new Date(Date.now() + 5 * 60000);
    if (isExpired && tokenData.refreshToken) {
        try {
            const newTokens = await oauthService.refreshAccessToken(provider, tokenData.refreshToken);
            const updates = { accessToken: newTokens.access_token, lastUpdated: admin.firestore.FieldValue.serverTimestamp() };
            if (newTokens.expires_in) updates.expiresAt = new Date(Date.now() + (newTokens.expires_in * 1000));
            if (newTokens.refresh_token) updates.refreshToken = newTokens.refresh_token;
            await tokenDocRef.update(updates);
            return newTokens.access_token;
        } catch (_) {
            return null;
        }
    }

    return tokenData.accessToken || null;
}

/**
 * POST /ai/chat
 * Main AI chat endpoint — classifies intent, validates required inputs,
 * fetches real OAuth tokens from the user's connected_accounts subcollection,
 * and triggers the N8N webhook with all credentials and Gemini API key injected.
 */
router.post('/chat', authMiddleware, async (req, res) => {
    try {
        const { prompt } = req.body;
        const uid = req.user.uid;

        if (!prompt) {
            return res.status(400).json({ success: false, error: "Prompt is required" });
        }

        // 1. Fetch existing automations for context (limit to 50 for token sanity)
        const automationsSnapshot = await db.collection("users").doc(uid).collection("automations").limit(50).get();
        const existingAutomations = automationsSnapshot.docs.map(doc => {
            const data = doc.data();
            const location = (data.isCustom === true || (data.steps && data.steps.length > 1)) ? "Custom Automations Tab" : "My Automations Tab";
            return { id: doc.id, name: data.name || data.title || "Untitled Automation", location };
        });

        // 2. Coordinator Intent Classification
        const classification = await aiService.determineIntent(prompt, { automations: existingAutomations });
        console.log(`[AI Chat] User ${uid} intent:`, classification.intent);

        if (classification.intent === 'SMALL_TALK') {
            return res.json({
                success: true,
                message: classification.response || "I'm here to help you automate! Try asking me to post to LinkedIn or upload to YouTube."
            });
        }

        if (classification.intent === 'DELETE_AUTOMATION') {
            const { automationId, automationName } = classification;
            if (!automationId) {
                return res.json({
                    success: true,
                    message: "I couldn't find an automation matching that name. Please verify the name from your Automations list."
                });
            }
            // Return action for frontend to confirm deletion
            return res.json({
                success: true,
                intent: 'DELETE_AUTOMATION',
                automationId: automationId,
                automationName: automationName || "Automation",
                message: `Are you sure you want to delete **${automationName || "Automation"}**?`
            });
        }

        if (classification.intent === 'EDIT_AUTOMATION') {
            const { automationId, automationName } = classification;
            if (!automationId) {
                return res.json({
                    success: true,
                    message: "I couldn't find the automation you want to edit. Please verify the exact name."
                });
            }

            const docRef = db.collection("users").doc(uid).collection("automations").doc(automationId);
            const docSnap = await docRef.get();

            if (!docSnap.exists) {
                return res.json({
                    success: true,
                    message: `I couldn't find the automation **${automationName}** in your account.`
                });
            }

            try {
                const proposedState = await aiService.proposeWorkflowEdit(prompt, docSnap.data());
                
                return res.json({
                    success: true,
                    intent: 'workflow-proposal',
                    automationId,
                    automationName: automationName || "Automation",
                    proposedState,
                    message: `I've drafted the changes for **${automationName || "Automation"}**! Please review the preview before saving.`
                });
            } catch (err) {
                console.error("Workflow Edit Error:", err);
                return res.json({
                    success: true,
                    message: "Sorry, I ran into an issue while trying to modify the workflow. Please try again."
                });
            }
        }

        if (classification.intent === 'CONNECT_ACCOUNT' || classification.intent === 'DISCONNECT_ACCOUNT') {
            const { provider } = classification;
            if (!provider) {
                return res.json({
                    success: true,
                    message: "Which account are you trying to manage? Please specify (e.g. Google, YouTube, LinkedIn)."
                });
            }

            // Return action for frontend to handle via OAuth/API
            return res.json({
                success: true,
                intent: classification.intent,
                provider: provider,
                message: classification.intent === 'CONNECT_ACCOUNT' 
                    ? `Click the button below to connect your **${provider}** account.` 
                    : `Click the button below to disconnect your **${provider}** account.`
            });
        }

        if (classification.intent === 'BUILD_AUTOMATION') {
            const blueprint = classification.automationBlueprint;

            if (!blueprint || !blueprint.steps || blueprint.steps.length === 0) {
                // Fallback if the AI didn't extract a blueprint
                return res.json({
                    success: true,
                    message: "I'd love to build that for you! Could you be more specific? For example: **Build an automation with a Schedule Trigger and a LinkedIn Post node, name it Daily LinkedIn Post**."
                });
            }

            // Trigger / logic node types — they never require external accounts
            const TRIGGER_LOGIC_TYPES = new Set([
                "scheduleNode", "manualTriggerNode", "waitNode",
                "ifNode", "loopNode", "switchNode"
            ]);

            // Sanitize steps: strip account/webhook fields from trigger & logic nodes
            const sanitizedSteps = blueprint.steps.map(step => {
                if (TRIGGER_LOGIC_TYPES.has(step.type)) {
                    // Only keep id, type, title, inputs — no account or webhook
                    return { id: step.id, type: step.type, title: step.title, inputs: step.inputs || {} };
                }
                return step;
            });

            // Derive aggregated accounts only from action nodes
            const connectedAccounts = [...new Set(
                sanitizedSteps
                    .filter(s => s.connected_account_type)
                    .map(s => s.connected_account_type)
            )];
            const primaryWebhook = sanitizedSteps.find(s => s.n8nWebhookId)?.n8nWebhookId || null;
            const primaryAccount = connectedAccounts[0] || null;

            const automationName = blueprint.name || "AI-Created Automation";
            const now = new Date();

            const newAutomation = {
                uid,
                name: automationName,
                steps: sanitizedSteps,
                edges: blueprint.edges || [],
                inputs: {},
                n8nWebhookId: primaryWebhook,
                connected_account_type: primaryAccount,
                connected_accounts: connectedAccounts,
                status: "active",
                icon: "smart_toy",
                source: "ai-chat",
                isCustom: true,   // marks it as a canvas automation so "Edit in Canvas" button shows
                createdAt: now,
                updatedAt: now
            };

            // Wrap Firestore write in a 12s timeout — never let a network blip crash the whole response
            let automationId = null;
            try {
                const writePromise = db.collection("users").doc(uid).collection("automations").add(newAutomation);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Firestore write timed out")), 12000)
                );
                const docRef = await Promise.race([writePromise, timeoutPromise]);
                automationId = docRef.id;
                console.log(`[AI Chat] BUILD_AUTOMATION created: ${automationId} ("${automationName}") for user ${uid}`);
            } catch (fsErr) {
                console.error(`[AI Chat] Firestore write failed for BUILD_AUTOMATION ("${automationName}"):`, fsErr.message);
                // Still respond with a success message — user gets feedback, they can retry
                return res.json({
                    success: false,
                    message: `I designed your **${automationName}** automation but couldn't save it right now due to a connection issue. Please try again in a moment. ⚠️`
                });
            }

            return res.json({
                success: true,
                intent: "BUILD_AUTOMATION",
                automationId,
                automationName,
                nodeCount: blueprint.steps.length,
                message: `I've built your **${automationName}** automation with ${blueprint.steps.length} node${blueprint.steps.length !== 1 ? "s" : ""}! Open it in the canvas to configure any settings and execute it when ready. 🚀`
            });
        }

        if (classification.intent === 'BUILD_NEW') {
            return res.json({
                success: true,
                message: classification.summary || "Could you be more specific about what you'd like to automate? For example: **Build a Schedule Trigger + LinkedIn Post automation, name it Daily Post**."
            });
        }

        // 2. TRIGGER_EXISTING — find the best matching template
        const match = await aiService.findBestTemplateMatch(prompt, templateAutomations);
        if (!match) {
            return res.json({
                success: false,
                needsInput: true,
                message: "I couldn't find a matching automation for that request. Could you be more specific? For example: **Post a tech article to LinkedIn** or **Upload a video to YouTube**."
            });
        }

        console.log(`[AI Chat] Matched template: ${match.id} ("${match.title}") for user ${uid}`);

        // 3. Check required inputs — ask user if they're missing
        const requiredInputs = (match.inputs || []).filter(inp => inp.required && !inp.dependency);
        const missingFields = [];

        for (const inp of requiredInputs) {
            const paramKey = inp.id;
            if (!classification.parameters || !classification.parameters[paramKey]) {
                missingFields.push({ id: inp.id, label: inp.label, placeholder: inp.placeholder });
            }
        }

        if (missingFields.length > 0) {
            const fieldDescriptions = missingFields
                .map(f => `**${f.label}** (e.g. "${f.placeholder || 'your value'}")`)
                .join(', ');
            return res.json({
                success: true,
                needsInput: true,
                templateId: match.id,
                templateTitle: match.title,
                missingFields,
                message: `To run **${match.title}**, I need a bit more information:\n\n${fieldDescriptions}\n\nJust reply with those details and I'll start the automation right away! 🚀`
            });
        }

        // 4. Fetch real OAuth tokens from the user's connected_accounts subcollection
        //    (mirrors exactly what workflowEngine.js does — no stale root-doc data)
        const providerMap = {
            googleOAuth2Api: "google",
            googleSheetsOAuth2Api: "google_sheets",
            linkedInOAuth2Api: "linkedin",
            googleDriveOAuth2Api: "google_drive",
            notionApi: "notion",
            youTubeOAuth2Api: "youtube"
        };

        const credentialsData = {};
        for (const [credKey, provider] of Object.entries(providerMap)) {
            const token = await getUserToken(uid, provider);
            credentialsData[credKey] = token; // null if not connected — N8N handles it
        }


        console.log(`[AI Chat] Credentials fetched for ${uid}. Connected providers:`, Object.values(providerMap).filter(p => p));


        // 5. Validate that required accounts are connected
        const requiredAccounts = match.connected_accounts || (match.connected_account_type ? [match.connected_account_type] : []);
        const missingAccounts = [];
        for (const acct of requiredAccounts) {
            const token = await getUserToken(uid, acct);
            if (!token) missingAccounts.push(acct);
        }

        if (missingAccounts.length > 0) {
            const friendlyNames = { linkedin: "LinkedIn", google: "Google", google_drive: "Google Drive", notion: "Notion", youtube: "YouTube" };
            const names = missingAccounts.map(a => friendlyNames[a] || a).join(", ");
            return res.json({
                success: false,
                needsInput: true,
                message: `To run **${match.title}**, you need to connect these accounts first: **${names}**.\n\nGo to [Connected Accounts](/connected-accounts) to link them and then try again! 🔗`
            });
        }

        // 6. Create execution log with `timestamp` field so ExecutionLogs.jsx can find it
        const executionRef = await db.collection("users").doc(uid).collection("execution_logs").add({
            automationId: "ai-generated",
            automationName: match.title,
            icon: match.icon || "smart_toy",
            status: "Running",
            message: `Starting ${match.title}...`,
            timestamp: admin.firestore.FieldValue.serverTimestamp() // ← must match what ExecutionLogs.jsx queries on
        });

        const executionId = executionRef.id;
        console.log(`[AI Chat] Execution log created: ${executionId}`);

        // 7. Build tokens in exactly the same structure workflowEngine.js produces
        //    so all existing N8N code nodes work without modification.
        //
        //    workflowEngine sends:
        //      tokens: { linkedin: "TOKEN", google: "TOKEN" }
        //      linkedinToken: "TOKEN"            ← camelCase alias
        //      linkedin_token: "TOKEN"           ← snake_case alias (if provider had underscore)
        //      access_token: "TOKEN"             ← first account's raw token
        //      gemini_api_key: "KEY"             ← snake_case (what N8N nodes reference)
        //      automationId / uid / executionId

        // Build tokens map { provider: rawAccessToken }
        const tokensMap = {};
        const namedTokens = {};

        for (const [credKey, provider] of Object.entries(providerMap)) {
            const rawToken = credentialsData[credKey];
            if (rawToken) {
                tokensMap[provider] = rawToken;

                // camelCase alias: linkedin → linkedinToken
                const camelKey = provider.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
                namedTokens[`${camelKey}Token`] = rawToken;

                // snake_case alias for providers with underscore: google_drive → google_drive_token
                if (provider.includes('_')) {
                    namedTokens[`${provider}_token`] = rawToken;
                }
            }
        }

        const primaryToken = requiredAccounts.length > 0 ? tokensMap[requiredAccounts[0]] : null;

        const payload = {
            // User-provided parameters from the AI (post_topic, post_tone, etc.)
            ...(classification.parameters || {}),

            // Nested tokens map — N8N "Single Topic Setup" reads body.tokens?.linkedin
            tokens: tokensMap,

            // Flat token aliases — same as workflowEngine
            ...namedTokens,

            // Primary account's raw token at root level
            access_token: primaryToken,

            // Gemini API key for N8N content generation (LinkedIn/YouTube writing)
            gemini_api_key: process.env.GEMINI_API_KEY_2,

            // Execution context
            automationId: "ai-generated",
            uid: uid,
            executionId,
            userId: uid
        };

        // 8. Respond immediately — fire N8N async
        const webhookId = match.n8nWebhookId;
        if (!webhookId) {
            await executionRef.update({
                status: "Failed",
                message: "This automation template is missing its webhook configuration.",
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.json({
                success: false,
                error: `The template "${match.title}" is not fully configured yet.`
            });
        }

        // Fire the webhook asynchronously — update log on failure
        n8nService.triggerAutomation(webhookId, payload).catch(async (err) => {
            console.error(`[AI Chat] N8N webhook failed for ${match.id}:`, err.message);
            await executionRef.update({
                status: "Failed",
                message: `Workflow error: ${err.message}`,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        return res.json({
            success: true,
            message: `Started your **${match.title}** automation! I'll let you know once it's done. 🚀`,
            templateId: match.id,
            templateTitle: match.title,
            executionId
        });

    } catch (error) {
        console.error("[AI Chat] Internal error:", error);
        res.status(500).json({ success: false, error: "Internal server error during chat processing." });
    }
});

/**
 * POST /ai/export
 * Exports AI generated content to Google Docs or Gmail Draft
 */
router.post('/export', authMiddleware, async (req, res) => {
    let provider = 'google'; // default
    try {
        const { action, content } = req.body;
        const uid = req.user.uid;

        if (!action || !content) {
            return res.status(400).json({ success: false, error: "Action and content are required" });
        }

        // Fetch token based on action. We must strictly use the correct provider to ensure we have the required scopes.
        provider = action === 'docs' ? 'google_drive' : (action === 'gmail' ? 'gmail' : 'google'); 
        const token = await getUserToken(uid, provider);

        if (!token) {
            return res.json({
                success: false,
                intent: 'CONNECT_ACCOUNT',
                provider: provider,
                message: `You need to connect your ${provider === 'google_drive' ? 'Google Docs' : provider === 'gmail' ? 'Gmail' : 'Google'} account to use this feature!`
            });
        }

        if (action === 'docs') {
            const rawResponse = await axios.post('https://docs.googleapis.com/v1/documents', {
                title: 'AI Export'
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const documentId = rawResponse.data.documentId;
            
            await axios.post(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
                requests: [{
                    insertText: {
                        location: { index: 1 },
                        text: content
                    }
                }]
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });

            return res.json({
                success: true,
                url: `https://docs.google.com/document/d/${documentId}/edit`
            });
        } else if (action === 'gmail') {
            // RFC 2822 format with proper MIME headers
            const emailLines = [
                'MIME-Version: 1.0',
                'Content-Type: text/plain; charset="UTF-8"',
                'Content-Transfer-Encoding: 7bit',
                'Subject: WebPilot AI Draft',
                'To: me',
                '',
                content
            ];
            const encodedMessage = Buffer.from(emailLines.join('\r\n')).toString('base64url');

            // Standard (non-upload) endpoint — accepts JSON
            const draftResponse = await axios.post('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
                message: { raw: encodedMessage }
            }, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            return res.json({
                success: true,
                url: `https://mail.google.com/mail/u/0/#drafts`
            });
        }

        return res.status(400).json({ success: false, error: "Invalid action" });

    } catch (error) {
        console.error("[AI Export] Error:", error.response?.data || error.message);
        
        // Handle Insufficient Scopes / Permission Denied actively
        const isPermissionDenied = error.response?.data?.error?.status === 'PERMISSION_DENIED' || error.response?.status === 403;
        
        if (isPermissionDenied) {
            return res.json({
                success: false,
                intent: 'CONNECT_ACCOUNT',
                provider: provider,
                message: `Your connected account doesn't have enough permissions. Please reconnect your ${provider === 'google_drive' ? 'Google Docs' : provider === 'gmail' ? 'Gmail' : 'Google'} account.`
            });
        }
        
        res.status(500).json({ success: false, error: "Failed to export data. Token may be invalid or expired. Try reconnecting your account." });
    }
});

module.exports = router;
