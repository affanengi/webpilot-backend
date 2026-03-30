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
    const instruction = `You are the WebPilot AI Coordinator. Classify the user's input into one of three intents and extract any parameters mentioned.

1. 'SMALL_TALK': Greeting, question, or anything non-automation. Provide a friendly 'response'.
2. 'TRIGGER_EXISTING': User wants to run an existing automation (Post to LinkedIn, Upload to YouTube, Send emails, Create Notion notes, etc.).
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
3. 'BUILD_NEW': User wants to create a custom automation from scratch. Provide a 'summary'.

Respond in strict JSON:
{
  "intent": "SMALL_TALK" | "TRIGGER_EXISTING" | "BUILD_NEW",
  "response": "...",
  "parameters": { "post_topic": "...", "post_tone": "Professional" },
  "summary": "..."
}

Rules:
- Include only relevant keys (omit null/empty ones).
- For TRIGGER_EXISTING: always include 'parameters' even if empty ({}).
- For SMALL_TALK: only include 'response'.
- Never include raw access tokens or API keys in parameters.`;

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


