const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY_1 });

// Retry wrapper — handles 429 rate limit with exponential backoff
async function withRetry(fn, maxRetries = 3) {
    let lastErr;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const is429 = err?.status === 429 || (err?.message || "").includes("RESOURCE_EXHAUSTED");
            if (!is429) throw err;
            const delay = (i + 1) * 2000; // 2s, 4s, 6s
            console.warn(`[Gemini] Rate limited. Retry ${i + 1}/${maxRetries} in ${delay}ms...`);
            await new Promise(res => setTimeout(res, delay));
        }
    }
    throw lastErr;
}

/**
 * determineIntent — classifies the prompt and extracts any parameters mentioned.
 */
async function determineIntent(prompt, userContext = {}) {
    // Format existing automations to give the AI context for deletion matching
    const automationsList = (userContext.automations || []).map(a => `- "${a.name}" (ID: ${a.id}) [Location: ${a.location || 'Unknown'}]`).join("\n");

    const instruction = `You are the WebPilot AI Coordinator. Classify the user's input into one of these intents and extract parameters.

1. 'SMALL_TALK': Greeting, question, or anything non-automation. Provide a friendly 'response'.
2. 'TRIGGER_EXISTING': User wants to RUN an existing automation (Post to LinkedIn, Upload to YouTube, Send emails, Create Notion notes, etc.).
   - Extract as many 'parameters' as the user provided. Common parameter keys:
     - post_topic, post_tone, topic, page_id, google_sheet_url, video_title, video_description, privacy_status (MUST be 'public', 'private', or 'unlisted'), folder_name
3. 'BUILD_AUTOMATION': User wants to CREATE / BUILD a new custom automation workflow. Keywords: "build", "create", "make", "set up an automation", "design a workflow".
   - Extract 'automationBlueprint' with this EXACT structure:
     {
       "name": "<the name the user gave, or a sensible default like 'Scheduled LinkedIn Post'>",
       "steps": [
         {
           "id": "step_1",
           "type": "<node type — see mapping below>",
           "title": "<friendly label>",
           "n8nWebhookId": "<webhook id or omit for logic/trigger nodes>",
           "connected_account_type": "<account type or omit>",
           "inputs": {}
         }
       ],
       "edges": [
         { "id": "e1", "source": "step_1", "target": "step_2" }
       ]
     }
   Node type mapping (ALWAYS use these exact values):
   - "schedule trigger" / "scheduled" / "cron"   → type: "scheduleNode"
   - "manual trigger" / "on click" / "button"     → type: "manualTriggerNode"
   - "linkedin post" / "post to linkedin"         → type: "automationNode", n8nWebhookId: "linkedin-post", connected_account_type: "linkedin"
   - "youtube upload" / "upload to youtube"       → type: "automationNode", n8nWebhookId: "advanced-youtube-upload", connected_account_type: "youtube"
   - "notion notes" / "create notion"             → type: "automationNode", n8nWebhookId: "notion-ai-notes", connected_account_type: "notion"
   - "send email" / "gmail" / "bulk email"        → type: "automationNode", n8nWebhookId: "gmail-send", connected_account_type: "google"
   - "google drive" / "create folder"             → type: "automationNode", n8nWebhookId: "google-drive", connected_account_type: "google_drive"
   - "google docs" / "create doc"                 → type: "automationNode", n8nWebhookId: "google-docs-automation", connected_account_type: "google_docs"
   - "wait" / "pause" / "delay"                   → type: "waitNode"
   - "if" / "condition" / "branch"                → type: "ifNode"
4. 'BUILD_NEW': Fallback only. User mentions building but it's too vague to extract nodes. Provide a 'summary'.
5. 'DELETE_AUTOMATION': User wants to delete an automation. Match their request strictly to one of these user automations by EXACT NAME and LOCATION (if specified):
${automationsList || "   (No existing automations found)"}
   - Extract 'automationId' and 'automationName' of the exact match. Pay close attention to the automation name and location (Custom Automations Tab vs My Automations Tab).
   - DO NOT guess partial matches. If there is no strong, confident match, OMIT 'automationId' completely rather than accidentally deleting the wrong flow.
6. 'CONNECT_ACCOUNT': User asks to connect a platform account (Google, Youtube, Linkedin, Notion, etc.). 
   - Extract 'provider' as one of: "google", "youtube", "linkedin", "notion", "instagram", "gmail", "google_drive", "google_docs", "google_sheets". Defaults to lowercased platform name.
7. 'DISCONNECT_ACCOUNT': User asks to disconnect a platform account. Extract 'provider' using the same list above.

Respond in strict JSON:
{
  "intent": "SMALL_TALK" | "TRIGGER_EXISTING" | "BUILD_AUTOMATION" | "BUILD_NEW" | "DELETE_AUTOMATION" | "CONNECT_ACCOUNT" | "DISCONNECT_ACCOUNT",
  "response": "...",
  "parameters": { "post_topic": "...", "post_tone": "Professional" },
  "automationBlueprint": { "name": "...", "steps": [...], "edges": [...] },
  "summary": "...",
  "automationId": "...",
  "automationName": "...",
  "provider": "..."
}

Rules:
- Include only relevant keys (omit null/empty ones).
- For DELETE_AUTOMATION: Always include automationId and automationName if matched.
- For CONNECT_ACCOUNT / DISCONNECT_ACCOUNT: Always include 'provider'.
- For TRIGGER_EXISTING: always include 'parameters' even if empty ({}).
- For BUILD_AUTOMATION: always include 'automationBlueprint'. Generate step ids as "step_1", "step_2", etc.
- For SMALL_TALK: only include 'response'.`;

    try {
        const response = await withRetry(() => ai.models.generateContent({
            model: "gemini-3.1-flash-lite-preview",
            contents: prompt,
            config: {
                systemInstruction: instruction,
                responseMimeType: "application/json"
            }
        }));
        return JSON.parse(response.text);
    } catch (e) {
        console.error("AI Coordinator Error:", e);
        const is429 = e?.status === 429 || (e?.message || "").includes("RESOURCE_EXHAUSTED");
        if (is429) {
            return { intent: "SMALL_TALK", response: "I'm getting a lot of requests right now — please try again in a moment!" };
        }
        return { intent: "SMALL_TALK", response: "Sorry, I ran into an issue classifying your request. Please try again." };
    }
}

/**
 * findBestTemplateMatch — finds the best matching automation template for the prompt.
 */
async function findBestTemplateMatch(prompt, templates) {
    const contextStr = templates.map((t, idx) =>
        `[${idx}] "${t.title}" — ${t.description || t.id}`
    ).join("\n");

    const instruction = `You are an automation matcher for the WebPilot platform.
Given the user's prompt, select the most relevant automation from the list below.
Return the index of the best match, or -1 if nothing is relevant.

Available automations:
${contextStr}

Rules:
- Match by intent, not exact words. "Post about AI on LinkedIn" -> LinkedIn Post Automation
- Return -1 if the user is just chatting or the request is completely unrelated

Respond with ONLY valid JSON:
{ "matchIdx": <number> }`;

    try {
        const response = await withRetry(() => ai.models.generateContent({
            model: "gemini-3.1-flash-lite-preview",
            contents: prompt,
            config: {
                systemInstruction: instruction,
                responseMimeType: "application/json"
            }
        }));
        const match = JSON.parse(response.text);
        if (typeof match.matchIdx === "number" && match.matchIdx >= 0 && match.matchIdx < templates.length) {
            return templates[match.matchIdx];
        }
    } catch (e) {
        console.error("Match error:", e);
    }
    return null;
}

module.exports = {
    determineIntent,
    findBestTemplateMatch
};


