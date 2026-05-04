const cron = require('node-cron');
const db = require('./firestore');
const workflowEngine = require('./workflowEngine');
const admin = require('./firebase');

// Map to store active cron tasks. Key: "uid|automationId"
const activeSchedules = new Map();

/**
/**
 * Initializes global schedule listeners using Firestore onSnapshot.
 * This guarantees the backend instantly reacts when the frontend toggles status.
 */
function initScheduler() {
    console.log("[Scheduler] Initializing global schedule listener...");
    try {
        if (!db) {
            console.warn("[Scheduler] Skipping initialization: db is null (Firebase not initialized)");
            return;
        }
        db.collectionGroup("automations").onSnapshot(snapshot => {
            snapshot.docChanges().forEach(change => {
                const autoDoc = change.doc;
                const data = autoDoc.data();
                const automationId = autoDoc.id;
                // Try grabbing uid from data or from the path structure: users/{uid}/automations/{id}
                const uid = data.uid || autoDoc.ref.parent.parent.id;

                if (change.type === 'removed') {
                    removeSchedule(uid, automationId);
                } else {
                    const isActive = data.status === 'active' || data.status === 'enabled';
                    if (!isActive) {
                        removeSchedule(uid, automationId);
                    } else {
                        scheduleAutomation(uid, automationId, data);
                    }
                }
            });
        });
        console.log("[Scheduler] Global onSnapshot listener attached.");
    } catch (err) {
        console.error("[Scheduler] Failed to attach global listener:", err);
    }
}

/**
 * Schedules or re-schedules an automation if it has a schedule trigger.
 */
function scheduleAutomation(uid, automationId, data) {
    const scheduleKey = `${uid}|${automationId}`;
    removeSchedule(uid, automationId); // clear existing if any

    const isActive = data.status === 'active' || data.status === 'enabled';
    if (!data || !isActive || !data.steps || data.steps.length === 0) return;

    // Look for the Schedule Trigger step. Typically it's the first step.
    const scheduleStep = data.steps.find(step => step.nodeType === 'scheduleNode' || (step.id && step.id.includes('trigger-schedule')));
    
    if (!scheduleStep) return;

    // Validate if the cron expression exists
    const cronExpression = scheduleStep.inputs?.cron_expression;
    if (!cronExpression || !cron.validate(cronExpression)) {
        console.log(`[Scheduler] Invalid or missing cron expression for automation ${automationId}. Skipping.`);
        return;
    }

    console.log(`[Scheduler] Scheduling ${automationId} for ${cronExpression}`);
    const task = cron.schedule(cronExpression, async () => {
        console.log(`[Scheduler] CRON FIRED for ${automationId}`);
        await executeScheduledWorkflow(uid, automationId, data);
    });

    activeSchedules.set(scheduleKey, task);
}

/**
 * Removes a scheduled task.
 */
function removeSchedule(uid, automationId) {
    const scheduleKey = `${uid}|${automationId}`;
    if (activeSchedules.has(scheduleKey)) {
        console.log(`[Scheduler] Removing schedule for ${automationId}`);
        activeSchedules.get(scheduleKey).stop();
        activeSchedules.delete(scheduleKey);
    }
}

/**
 * Syncs the schedule for a single automation efficiently.
 * Useful when an automation is saved/updated/deleted in the API.
 */
function syncSchedule(uid, automationId, data) {
    if (!data || data.status !== 'active') {
        removeSchedule(uid, automationId);
    } else {
        scheduleAutomation(uid, automationId, data);
    }
}

/**
 * Inner executor when cron fires
 */
async function executeScheduledWorkflow(uid, automationId, data) {
    // 1. Create execution log
    try {
        console.log(`[Scheduler] Creating execution log for user: ${uid}, automation: ${automationId}`);
        const logRef = await db.collection("users").doc(uid).collection("execution_logs").add({
            automationId: automationId,
            automationName: data.name || data.title || "Scheduled Automation",
            icon: data.icon || "schedule",
            status: "Running",
            message: "Automation started via Schedule...",
            chainSteps: data.steps,
            edges: data.edges || [],
            currentStepId: data.steps[0]?.id || null,
            executionContext: {},
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // 2. Start the engine
        await workflowEngine.advanceWorkflow(uid, logRef.id);
    } catch (err) {
        console.error(`[Scheduler] Execution failed for ${automationId}:`, err);
    }
}

module.exports = {
    initScheduler,
    scheduleAutomation,
    removeSchedule,
    syncSchedule
};
