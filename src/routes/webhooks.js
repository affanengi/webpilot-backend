const express = require("express");
const router = express.Router();
const db = require("../services/firestore");
const admin = require("../services/firebase");

// POST /webhooks/n8n/callback
// Inbound endpoint from N8N to store execution logs
router.post("/n8n/callback", async (req, res) => {
    try {
        // 1. Authenticate Request
        // The N8N HTTP Request node (the final node) should send the N8N_API_KEY as a Bearer token or a custom header
        const apiKey = req.headers["x-n8n-api-key"] || req.headers["authorization"]?.split(" ")[1];

        if (!apiKey || apiKey !== process.env.N8N_API_KEY) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        // 2. Extract Data
        const { uid, automationId, status, resultLink, message, executionId } = req.body;

        if (!uid || !automationId) {
            return res.status(400).json({ error: "Missing uid or automationId in payload" });
        }

        // 3. Save Execution Log to Firestore
        // Normalize N8N status strings → exactly "Success" or "Failed"
        // N8N may send: "Successful", "success", "completed", "failed", etc.
        const rawStatus = (status || "completed").toLowerCase();
        const normalizedStatus = rawStatus.includes("fail") || rawStatus.includes("error")
            ? "Failed"
            : "Success";

        const logData = {
            status: normalizedStatus,
            resultUrl: resultLink || null,
            resultLink: resultLink || null,
            message: message || "Automation finished successfully",
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        };

        const logsCollection = db
            .collection("users")
            .doc(uid)
            .collection("execution_logs");

        if (executionId) {
            // Check if there's a chained step
            const executionDoc = await logsCollection.doc(executionId).get();
            
            if (executionDoc.exists) {
                const data = executionDoc.data();
                const { chainSteps, currentStepId, executionContext, edges } = data;
                
                if (status !== "failed") {
                    let context = executionContext || {};
                    const previousResult = resultLink || message || "success";
                    context.previousResult = previousResult;

                    // Build individual dot-notation updates so we don't overwrite
                    // the per-node `.input` sub-keys previously written by workflowEngine
                    const contextUpdates = {
                        "executionContext.previousResult": previousResult,
                    };

                    if (currentStepId) {
                        // Store the full n8n response as this node's output
                        const outputPayload = { ...req.body };
                        delete outputPayload.uid;
                        delete outputPayload.automationId;
                        delete outputPayload.executionId;

                        contextUpdates[`executionContext.${currentStepId}.result`] = previousResult;
                        contextUpdates[`executionContext.${currentStepId}.message`] = message || "";
                        contextUpdates[`executionContext.${currentStepId}.output`] = outputPayload;

                        context[currentStepId] = {
                            result: previousResult,
                            message: message || "",
                            output: outputPayload
                        };
                    }
                    
                    let nextStepId = null;
                    if (edges && edges.length > 0) {
                        const edge = edges.find(e => e.source === currentStepId);
                        if (edge) nextStepId = edge.target;
                    } else if (chainSteps && chainSteps.length > 0) {
                        // Linear fallback
                        const currentIndex = chainSteps.findIndex(s => s.id === currentStepId);
                        if (currentIndex > -1 && currentIndex < chainSteps.length - 1) {
                            nextStepId = chainSteps[currentIndex + 1].id;
                        }
                    }

                    if (nextStepId) {
                        // Use dot-notation merge to preserve all existing context sub-keys
                        await logsCollection.doc(executionId).update({
                           currentStepId: nextStepId,
                           timestamp: admin.firestore.FieldValue.serverTimestamp(),
                           ...contextUpdates
                        });
                        
                        const workflowEngine = require("../services/workflowEngine");
                        workflowEngine.advanceWorkflow(uid, executionId).catch(err => {
                            console.error("[Webhooks] Failed to advance workflow:", err);
                        });
                        
                        console.log(`[Webhooks] Advanced to step ${nextStepId} for execution ${executionId}`);
                        
                        if (automationId && automationId !== "draft" && automationId !== "ai-generated") {
                            await db.collection("users").doc(uid).collection("automations").doc(automationId).update({
                                lastRun: admin.firestore.FieldValue.serverTimestamp(),
                                lastRunStatus: `Running Step ${nextStepId}`
                            });
                        }
                        return res.status(200).json({ success: true, message: `Step complete. Next step triggered.` });
                    }

                    // No next step — workflow finished. Save final context with merge
                    await logsCollection.doc(executionId).update({
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        ...contextUpdates
                    });
                }
            }

            // No chained step found or execution is completely finished, update log normally
            await logsCollection.doc(executionId).update(logData);
        } else {
            // Fallback: create a new one (enriching it a bit)
            await logsCollection.add({
                ...logData,
                automationId: automationId,
                automationName: "Webhook Triggered Automation",
                icon: "receipt_long"
            });
        }

        // Optional: Update the lastRun timestamp on the automation itself
        if (automationId && automationId !== "draft" && automationId !== "ai-generated") {
            await db
                .collection("users")
                .doc(uid)
                .collection("automations")
                .doc(automationId)
                .update({
                    lastRun: admin.firestore.FieldValue.serverTimestamp(),
                    lastRunStatus: logData.status
                });
        }

        console.log(`[Webhooks] Successfully logged execution for automation ${automationId} (User: ${uid})`);
        res.status(200).json({ success: true, message: "Log saved successfully" });

    } catch (error) {
        console.error("[Webhooks] Error handling N8N callback:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

module.exports = router;
