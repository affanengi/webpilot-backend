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
async function determineIntent(prompt) {
    const instruction = `You are the WebPilot AI Coordinator. Classify the user's input into one of four intents and extract any parameters mentioned.

1. 'SMALL_TALK': Greeting, question, or anything non-automation. Provide a friendly 'response'.
2. 'TRIGGER_EXISTING': User wants to RUN an existing automation (Post to LinkedIn, Upload to YouTube, Send emails, Create Notion notes, etc.).
   - Extract as many 'parameters' as the user provided. Common parameter keys:
     - post_topic: the topic or text for a LinkedIn/social post
     - post_tone: tone of voice (e.g. Professional, Casual, Inspirational)
     - topic: general topic for content
     - page_id: Notion page ID if mentioned
     - google_sheet_url: spreadsheet URL if mentioned
     - video_title / videoTitle: YouTube video title if mentioned
     - video_description: YouTube video description if mentioned
     - privacy_status: YouTube video privacy — MUST be 'public', 'private', or 'unlisted'. Default to 'private' if not mentioned. If user says 'public video', set to 'public'.
     - folder_name / folderAction: Google Drive folder name/action
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
   - "linkedin post" / "post to linkedin"         → type: "actionNode", n8nWebhookId: "linkedin-post", connected_account_type: "linkedin"
   - "youtube upload" / "upload to youtube"       → type: "actionNode", n8nWebhookId: "advanced-youtube-upload", connected_account_type: "youtube"
   - "notion notes" / "create notion"             → type: "actionNode", n8nWebhookId: "notion-ai-notes", connected_account_type: "notion"
   - "send email" / "gmail" / "bulk email"        → type: "actionNode", n8nWebhookId: "gmail-send", connected_account_type: "google"
   - "google drive" / "create folder"             → type: "actionNode", n8nWebhookId: "google-drive", connected_account_type: "google_drive"
   - "google docs" / "create doc"                 → type: "actionNode", n8nWebhookId: "google-docs-automation", connected_account_type: "google_docs"
   - "wait" / "pause" / "delay"                   → type: "waitNode"
   - "if" / "condition" / "branch"                → type: "ifNode"
4. 'BUILD_NEW': Fallback only. User mentions building but it's too vague to extract nodes. Provide a 'summary'.

Respond in strict JSON:
{
  "intent": "SMALL_TALK" | "TRIGGER_EXISTING" | "BUILD_AUTOMATION" | "BUILD_NEW",
  "response": "...",
  "parameters": { "post_topic": "...", "post_tone": "Professional" },
  "automationBlueprint": { "name": "...", "steps": [...], "edges": [...] },
  "summary": "..."
}

Rules:
- Include only relevant keys (omit null/empty ones).
- For TRIGGER_EXISTING: always include 'parameters' even if empty ({}).
- For BUILD_AUTOMATION: always include 'automationBlueprint'. Generate step ids as "step_1", "step_2", etc.
- For SMALL_TALK: only include 'response'.
- Never include raw access tokens or API keys in parameters.
- If user specifies a name like "name it X" or "call it X", use that exact name in automationBlueprint.name.`;

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


