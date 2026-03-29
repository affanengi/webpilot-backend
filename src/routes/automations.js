const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const db = require("../services/firestore");
const admin = require("../services/firebase");
const n8nService = require("../services/n8n");
const oauthService = require("../services/oauth");
const { useCredits, getCredits, ADMIN_EMAILS } = require("../services/credits");
const schedulerService = require("../services/schedulerService");

// Middleware to protect all automation routes
router.use(authMiddleware);

// GET /credits
// Returns the user's current daily credit balance.
// Side-effect: triggers the auto-reset if the date has changed since lastCreditReset.
router.get("/credits", async (req, res) => {
    try {
        const { uid } = req.user;
        const credits = await getCredits(uid);
        const isAdmin = ADMIN_EMAILS.includes(req.user.email);
        res.json({ success: true, credits: isAdmin ? null : credits, isAdmin });
    } catch (err) {
        console.error("[Credits] Error fetching credits:", err);
        res.status(500).json({ error: "Failed to fetch credits." });
    }
});

// POST /automations
// Create a new automation
router.post("/", async (req, res) => {
    try {
        const { uid } = req.user;
        let { 
            name, 
            connected_account_type, 
            connected_accounts, 
            inputs, 
            n8nWebhookId, 
            templateId, 
            steps,
            ...otherFields 
        } = req.body;

        // Extract required root fields safely across all steps (ignoring logic/trigger nodes that lack these fields)
        if (steps && steps.length > 0) {
            let aggregatedAccounts = new Set(connected_accounts || []);
            let aggregatedTypes = new Set(connected_account_type ? [connected_account_type] : []);

            for (const step of steps) {
                if (!n8nWebhookId && step.n8nWebhookId) n8nWebhookId = step.n8nWebhookId;
                if (!inputs && step.inputs) inputs = step.inputs;
                
                if (step.connected_account_type) aggregatedTypes.add(step.connected_account_type);
                if (step.connected_accounts && Array.isArray(step.connected_accounts)) {
                    step.connected_accounts.forEach(acc => aggregatedAccounts.add(acc));
                }
            }

            if (!connected_account_type && aggregatedTypes.size > 0) {
                connected_account_type = Array.from(aggregatedTypes)[0];
            }
            if (!connected_accounts || connected_accounts.length === 0) {
                connected_accounts = Array.from(aggregatedAccounts);
            }
        }

        // 🚨 CRITICAL: We no longer strictly enforce connected_account_type because logic-only graphs (e.g. Scheduled -> Wait -> If)
        // might not have external connections. Instead, we default to null/empty so the save succeeds.
        if (!connected_account_type) connected_account_type = null;
        if (!connected_accounts || !Array.isArray(connected_accounts)) connected_accounts = [];

        if (!name) {
            return res.status(400).json({ error: "Missing required fields: name" });
        }

        // Deduct 15 credits (admin bypass via useCredits)
        const creditResult = await useCredits(uid, 15);
        if (!creditResult.allowed) return res.status(403).json({ error: creditResult.error });

        const newAutomation = {
            uid,
            name,
            connected_account_type: connected_account_type || null, 
            connected_accounts: connected_accounts || [], // e.g. ["google_drive", "youtube", "google_sheets"]
            inputs: inputs || {}, // stores parameters like videoSourceFolderId, metadataSource, privacyStatus
            n8nWebhookId,
            templateId: templateId || null,
            steps: steps || null,
            edges: req.body.edges || [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "active",
            ...otherFields
        };

        const docRef = await db.collection("users").doc(uid).collection("automations").add(newAutomation);

        // Sync to in-memory scheduler
        schedulerService.syncSchedule(uid, docRef.id, newAutomation);

        res.status(201).json({
            success: true,
            id: docRef.id,
            message: "Automation created successfully",
            automation: { id: docRef.id, ...newAutomation }
        });

    } catch (error) {
        console.error("Error creating automation:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// GET /automations
// List all automations for the user
router.get("/", async (req, res) => {
    try {
        const { uid } = req.user;
        const snapshot = await db.collection("users").doc(uid).collection("automations")
            .orderBy("createdAt", "desc")
            .get();

        const automations = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.json({ success: true, automations });

    } catch (error) {
        console.error("Error fetching automations:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// DELETE /automations/:id
// Delete a specific automation
router.delete("/:id", async (req, res) => {
    try {
        const { uid } = req.user;
        const { id } = req.params;

        await db.collection("users").doc(uid).collection("automations").doc(id).delete();

        // Remove from in-memory scheduler
        schedulerService.removeSchedule(uid, id);

        res.json({ success: true, message: "Automation deleted successfully" });

    } catch (error) {
        console.error("Error deleting automation:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// POST /automations/:id/trigger
// Trigger an existing automation (supports chained steps)
router.post("/:id/trigger", async (req, res) => {
    let logRef = null;

    try {
        const { uid } = req.user;
        const { id } = req.params;

        console.log(`[Trigger] Called for automation: ${id} by user: ${uid}`);

        // Deduct 5 credits (admin bypass via useCredits)
        const creditResult = await useCredits(uid, 5);
        if (!creditResult.allowed) return res.status(403).json({ error: creditResult.error });

        // 1. Fetch automation details
        const automationDoc = await db.collection("users").doc(uid).collection("automations").doc(id).get();
        if (!automationDoc.exists) {
            console.error(`[Trigger] Automation ${id} not found for user ${uid}`);
            return res.status(404).json({ error: "Automation not found" });
        }

        const automation = automationDoc.data();
        // Always prefer the live inputs from the canvas (req.body.steps) over stale Firestore data.
        // This ensures config changes made in the modal before clicking Execute are respected.
        let steps = req.body.steps || automation.steps;
        let edges = req.body.edges ?? automation.edges ?? [];

        // Backward compatibility for automations saved before chaining
        if (!steps || !Array.isArray(steps) || steps.length === 0) {
            steps = [{
                n8nWebhookId: automation.n8nWebhookId,
                connected_account_type: automation.connected_account_type,
                connected_accounts: automation.connected_accounts,
                inputs: automation.inputs || req.body, // Support dynamic inputs
                id: automationDoc.id
            }];
        }

        const firstStep = steps[0];

        // 2. CREATE THE EXECUTION LOG
        console.log(`[Trigger] Creating execution log for user: ${uid}`);
        logRef = await db.collection("users").doc(uid).collection("execution_logs").add({
            automationId: id,
            automationName: automation.name || automation.title || "Unknown Automation",
            icon: automation.icon || "receipt_long",
            status: "Running",
            message: "Automation started...",
            chainSteps: steps,
            edges: edges,
            currentStepId: steps[0]?.id || null,
            executionContext: {},
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        const executionId = logRef.id;
        console.log(`[Trigger] Execution log created: ${executionId}`);

        // 3. Respond immediately
        res.status(202).json({
            success: true,
            message: "Automation triggered. Check Execution Logs for status.",
            executionId: executionId
        });

        // 4. Trigger the first step async via workflowEngine
        const workflowEngine = require("../services/workflowEngine");
        try {
            await workflowEngine.advanceWorkflow(uid, executionId);
        } catch (err) {
            console.error(`[Trigger] Execute Step 1 failed:`, err);
            await logRef.update({ status: "Failed", message: err.message, timestamp: admin.firestore.FieldValue.serverTimestamp() });
        }
    } catch (error) {
        console.error("[Trigger] Unexpected error:", error);
        if (logRef) {
            await logRef.update({ status: "Failed", message: error.message, timestamp: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        }
        if (!res.headersSent) res.status(500).json({ error: error.message || "Internal Server Error" });
    }
});

// POST /automations/run-draft
// Trigger an automation without saving it to DB (supports single step or array of chained steps)
router.post("/run-draft", async (req, res) => {
    let logRef = null;

    try {
        const { uid } = req.user;
        let { steps, edges, n8nWebhookId, connected_account_type, connected_accounts, inputs, title, icon } = req.body;

        // Backward compatibility
        if (!steps || !Array.isArray(steps) || steps.length === 0) {
            steps = [{ n8nWebhookId, connected_account_type, connected_accounts, inputs, title, icon, id: 'draft' }];
        }
        if (!edges) edges = [];

        console.log(`[Run-Draft] Called for draft by user: ${uid}`);

        // Check Credits (admin bypass via useCredits)
        const creditResult = await useCredits(uid, 5);
        if (!creditResult.allowed) return res.status(403).json({ error: creditResult.error });

        // CREATE LOG
        logRef = await db.collection("users").doc(uid).collection("execution_logs").add({
            automationId: "draft",
            automationName: req.body.title || steps[0]?.title || "Draft Automation",
            icon: req.body.icon || steps[0]?.icon || "bolt",
            status: "Running",
            message: "Automation started...",
            chainSteps: steps,
            edges: edges,
            currentStepId: steps[0]?.id || null,
            executionContext: {},
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        const executionId = logRef.id;

        res.status(202).json({
            success: true,
            message: "Draft automation triggered. Check Execution Logs.",
            executionId: executionId
        });

        // Execute first step async
        const workflowEngine = require("../services/workflowEngine");
        try {
            await workflowEngine.advanceWorkflow(uid, executionId);
        } catch (err) {
            console.error(`[Run-Draft] Execute Step 1 failed:`, err);
            await logRef.update({ status: "Failed", message: err.message, timestamp: admin.firestore.FieldValue.serverTimestamp() });
        }

    } catch (error) {
        console.error("[Run-Draft] Unexpected error:", error);
        if (logRef) {
            await logRef.update({ status: "Failed", message: error.message, timestamp: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        }
        if (!res.headersSent) res.status(500).json({ error: error.message || "Internal Server Error" });
    }
});

module.exports = router;
