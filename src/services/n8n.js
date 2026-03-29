const axios = require("axios");

/**
 * Triggers an N8N automation webhook securely using the global N8N API key.
 * @param {string} webhookId - The ID of the N8N webhook.
 * @param {object} payload - The data payload to send to N8N (e.g., access token, automation parameters).
 * @returns {Promise<object>} response from N8N
 */
exports.triggerAutomation = async (webhookId, payload) => {
    // Custom domain as specified by the user
    const n8nDomain = "https://n8n.affanmohd.online";
    const apiKey = process.env.N8N_API_KEY;

    if (!apiKey) {
        throw new Error("N8N_API_KEY is not defined in environment variables.");
    }

    // The full webhook URL
    const url = `${n8nDomain}/webhook/${webhookId}`;

    // In N8N, configure the Webhook node for "Header Auth" and set the credential's Header Name to "x-n8n-api-key"
    const headers = {
        "x-n8n-api-key": apiKey,
        "Content-Type": "application/json"
    };

    try {
        const response = await axios.post(url, payload, { headers });
        return response.data;
    } catch (error) {
        console.error("Error triggering N8N automation:", error.response?.data || error.message);
        // Throw an explicit error to catch in the route handler
        throw new Error(error.response?.data?.message || "Failed to trigger N8N automation");
    }
};
