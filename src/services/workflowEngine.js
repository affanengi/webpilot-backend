const db = require("./firestore");
const admin = require("./firebase");
const n8nService = require("./n8n");
const oauthService = require("./oauth");

/**
 * Fires the N8N webhook for a specific action node.
 */
async function executeN8NWebhook(uid, executionId, stepData, logRef, rootAutomationId, executionContext) {
    const { n8nWebhookId, connected_account_type, connected_accounts, inputs, id, title } = stepData;

    let accountsToFetch = [];
    if (Array.isArray(connected_accounts) && connected_accounts.length > 0) {
        accountsToFetch = connected_accounts;
    } else if (connected_account_type) {
        accountsToFetch = [connected_account_type];
    }

    const tokensPayload = {};
    for (const accountType of accountsToFetch) {
        const aliases = [accountType, accountType === "google_drive" ? "google" : null].filter(Boolean);
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

        if (!tokenData) throw new Error(`Not connected to ${accountType}.`);

        const isExpired = tokenData.expiresAt && tokenData.expiresAt.toDate() < new Date(Date.now() + 5 * 60000);

        if (isExpired && tokenData.refreshToken) {
            try {
                const newTokens = await oauthService.refreshAccessToken(accountType, tokenData.refreshToken);
                const updates = { accessToken: newTokens.access_token, lastUpdated: admin.firestore.FieldValue.serverTimestamp() };
                if (newTokens.expires_in) updates.expiresAt = new Date(Date.now() + (newTokens.expires_in * 1000));
                if (newTokens.refresh_token) updates.refreshToken = newTokens.refresh_token;
                await tokenDocRef.update(updates);
                tokenData.accessToken = newTokens.access_token;
            } catch (err) {
                throw new Error(`Failed to refresh ${accountType} session.`);
            }
        } else if (isExpired && !tokenData.refreshToken) {
            throw new Error(`Session expired for ${accountType}. Please reconnect.`);
        }

        tokensPayload[accountType] = tokenData.accessToken;
    }

    const namedTokens = {};
    for (const [accountType, token] of Object.entries(tokensPayload)) {
        const camelKey = accountType.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        namedTokens[`${camelKey}Token`] = token;
        if (accountType.includes('_')) namedTokens[`${accountType}_token`] = token;
    }

    // Resolve variables in inputs using executionContext before sending to N8N
    let resolvedInputs = JSON.stringify(inputs || {});
    resolvedInputs = resolvedInputs.replace(/\{\{PREVIOUS_RESULT\}\}/g, executionContext.previousResult || "");
    // Replace {{NodeId.field}} placeholders
    resolvedInputs = resolvedInputs.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
        const parts = path.split('.');
        const nodeId = parts[0];
        const field = parts.slice(1).join('.');
        if (executionContext[nodeId]) {
            if (!field || field === 'result') return executionContext[nodeId].result || match;
            return typeof executionContext[nodeId][field] !== 'undefined' ? executionContext[nodeId][field] : match;
        }
        return match;
    });
    resolvedInputs = JSON.parse(resolvedInputs);

    const n8nPayload = {
        ...resolvedInputs,
        tokens: tokensPayload,
        access_token: accountsToFetch.length > 0 ? tokensPayload[accountsToFetch[0]] : null,
        ...namedTokens,
        gemini_api_key: process.env.GEMINI_API_KEY,
        automationId: rootAutomationId,
        uid: uid,
        executionId: executionId,
        nodeId: id
    };

    console.log(`[WorkflowEngine] Firing Webhook: ${n8nWebhookId} for execution ${executionId}`);

    // Save the input payload to executionContext so the UI can display it
    // Strip system keys so only user-facing fields are stored
    const inputSnapshot = { ...resolvedInputs };
    if (logRef) {
        await logRef.update({
            status: `Running: ${title}`,
            message: "Webhook triggered, waiting for n8n to process...",
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            [`executionContext.${id}.input`]: inputSnapshot,
        }).catch(() => {});
    }

    n8nService.triggerAutomation(n8nWebhookId, n8nPayload).catch(async (err) => {
        console.error(`[WorkflowEngine] N8N Trigger Failed for ${n8nWebhookId}:`, err.message);
        if (logRef) {
            await logRef.update({
                status: "failed",
                message: `Failed to reach N8N: ${err.message}`,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            }).catch(() => {});
        }
    });
}

/**
 * Replaces placeholders in expressions, e.g., {{NodeID.status}} -> 'success'
 */
function evaluateExpression(expression, context) {
    if (typeof expression !== 'string') return expression;
    return expression.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
        if (path === 'PREVIOUS_RESULT') return context.previousResult || "";
        const parts = path.split('.');
        if (context[parts[0]]) return context[parts[0]][parts[1] || 'result'] || "";
        return match;
    });
}

/**
 * Main Orchestration Loop
 * Traverses the graph, executes synchronous Logic nodes locally, and stops when an asynchronous Webhook or Wait is reached.
 */
async function advanceWorkflow(uid, executionId) {
    const logRef = db.collection("users").doc(uid).collection("execution_logs").doc(executionId);
    const logDoc = await logRef.get();
    if (!logDoc.exists) return;
    
    const data = logDoc.data();
    if (data.status === "failed" || data.status === "completed") return;

    let { chainSteps, edges, currentStepId, executionContext } = data;
    if (!executionContext) executionContext = {}; 
    if (!edges) edges = []; // Fallback for old linear workflows
    
    // Find current node
    let currentNode = chainSteps.find(s => s.id === currentStepId);

    // If no specific currentStepId, but we haven't failed/completed, and it's a legacy array:
    if (!currentNode && !currentStepId && chainSteps && chainSteps.length > 0) {
        // Fallback for linear arrays without graph edges
        const currentIndex = data.currentStepIndex || 0;
        currentNode = chainSteps[currentIndex];
        currentStepId = currentNode.id;
    }

    // End of workflow
    if (!currentNode) {
        await logRef.update({ status: "completed", message: "Workflow finished executing." });
        return;
    }

    let nextStepId = null;

    try {
        if (currentNode.type === 'waitNode') {
            const time = parseInt(currentNode.inputs.wait_time || 1);
            const unit = currentNode.inputs.wait_unit || "Minutes";
            let ms = time * 60000;
            if (unit === 'Hours') ms *= 60;
            if (unit === 'Days') ms *= 24 * 60;
            
            await logRef.update({ status: `Waiting`, message: `Paused for ${time} ${unit}` });
            
            const edge = edges.find(e => e.source === currentStepId);
            if (edge) nextStepId = edge.target;
            
            console.log(`[WorkflowEngine] Pausing for ${ms} ms at wait node...`);
            setTimeout(async () => {
                await logRef.update({ currentStepId: nextStepId });
                advanceWorkflow(uid, executionId);
            }, ms);
            return; // Pause traversal
        } 
        else if (currentNode.type === 'ifNode') {
            const field = evaluateExpression(currentNode.inputs.condition_field, executionContext);
            const val = evaluateExpression(currentNode.inputs.condition_value, executionContext);
            const op = currentNode.inputs.condition_operator || "Equals";
            
            let isTrue = false;
            if (op === "Equals") isTrue = (field == val);
            else if (op === "Not Equals") isTrue = (field != val);
            else if (op === "Contains") isTrue = String(field).toLowerCase().includes(String(val).toLowerCase());
            else if (op === "Greater Than") isTrue = Number(field) > Number(val);
            else if (op === "Less Than") isTrue = Number(field) < Number(val);

            const outHandle = isTrue ? 'true' : 'false';
            const edge = edges.find(e => e.source === currentStepId && e.sourceHandle === outHandle);
            if (edge) nextStepId = edge.target;
            
            console.log(`[WorkflowEngine] IfNode evaluated to ${isTrue} handle. Next -> ${nextStepId}`);
            executionContext[currentStepId] = { result: isTrue };
        }
        else if (currentNode.type === 'switchNode') {
            const triggerVar = evaluateExpression(currentNode.inputs.switch_variable, executionContext);
            let matchCase = null;
            
            // Loop through inputs dynamically checking cases
            for (let i = 1; i <= 4; i++) {
                const caseVal = evaluateExpression(currentNode.inputs[`case_${i}`], executionContext);
                if (caseVal && String(triggerVar).trim() === String(caseVal).trim()) {
                    matchCase = `case${i}`; break;
                }
            }
            
            let edge = null;
            if (matchCase) {
                edge = edges.find(e => e.source === currentStepId && e.sourceHandle === matchCase);
            }
            // Fallback case handling could be added if you have a default handle
            if (!edge) edge = edges.find(e => e.source === currentStepId && e.sourceHandle === 'fallback');
            
            if (edge) nextStepId = edge.target;
            executionContext[currentStepId] = { result: triggerVar, matched: matchCase };
        }
        else if (currentNode.type === 'manualTriggerNode' || currentNode.type === 'scheduleNode') {
            // It's just a trigger, simply advance to its target
            const edge = edges.find(e => e.source === currentStepId);
            if (edge) nextStepId = edge.target;
            
            // Or in legacy linear arrays:
            if (!nextStepId && (!edges || edges.length === 0)) {
                const idx = chainSteps.findIndex(s => s.id === currentStepId);
                if (idx < chainSteps.length - 1) nextStepId = chainSteps[idx+1].id;
            }
        }
        else if (currentNode.type === 'loopNode') {
            // Simplified loop handling. Advanced implementations queue items explicitly.
            const arrData = evaluateExpression(currentNode.inputs.loop_array, executionContext);
            let arr = [];
            try { arr = typeof arrData === 'string' ? JSON.parse(arrData) : arrData; } catch(e){}
            if (!Array.isArray(arr)) arr = [arrData];
            
            // For now, to keep it simple without massive recursion refactoring,
            // we will just take the whole array and pass it along, leaving advanced loop sub-branch spawning for a full queue worker.
            console.log(`[WorkflowEngine] LoopNode hit. Loop iterations aren't fully deep supported without worker queue. Treating as pass-through.`);
            const edge = edges.find(e => e.source === currentStepId && e.sourceHandle === 'item');
            if (edge) nextStepId = edge.target;
        }
        else {
            // It's a standard N8N web_hook action node
            await executeN8NWebhook(uid, executionId, currentNode, logRef, data.automationId, executionContext);
            return; // Pause traversal
        }

        // If we processed a synchronous logic node, advance immediately
        await logRef.update({ 
            currentStepId: nextStepId,
            executionContext: executionContext
        });
        
        if (nextStepId) {
            // Avoid call stack limits for very long synchronous chains
            process.nextTick(() => advanceWorkflow(uid, executionId));
        } else {
            await logRef.update({ status: "completed", message: "Workflow completed." });
        }
    } catch (error) {
         console.error(`[WorkflowEngine] Logic evaluation failed at ${currentStepId}:`, error);
         await logRef.update({ status: "failed", message: `Step ${currentNode.title || 'Unknown'} failed: ${error.message}` });
    }
}

// Backward compatibility export
module.exports = { 
    executeStep: executeN8NWebhook, 
    advanceWorkflow 
};
