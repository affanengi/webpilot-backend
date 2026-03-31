<h1 align="center">
  <img src="https://i.postimg.cc/L58wRxyk/webpilot-logo.png" alt="WebPilot Logo" width="120" style="border-radius: 20px" />
  <br>
  WebPilot Backend Server
</h1>

<p align="center">
  <b>The Brains Behind AI-Powered Web Automations. Orchestrating N8N workflows, authenticating users, processing Gemini AI commands, and managing web automation states in real-time.</b>
</p>

---

## 📖 Table of Contents

1. [Introduction to WebPilot](#1-introduction-to-webpilot)
2. [What Does This Application Do?](#2-what-does-this-application-do)
3. [System Architecture & Data Flow](#3-system-architecture--data-flow)
   - [The Role of the Engine](#the-role-of-the-engine)
   - [How N8N Workflows Connect](#how-n8n-workflows-connect)
   - [How the AI Chat Connects](#how-the-ai-chat-connects)
4. [Technology Stack](#4-technology-stack)
5. [Prerequisites & Requirements](#5-prerequisites--requirements)
6. [Detailed Setup Instructions](#6-detailed-setup-instructions)
   - [Step 1: Clone the Repository](#step-1-clone-the-repository)
   - [Step 2: Install Node Dependencies](#step-2-install-node-dependencies)
   - [Step 3: Firebase Admin Setup](#step-3-firebase-admin-setup)
   - [Step 4: Environment Configuration](#step-4-environment-configuration)
   - [Step 5: Starting the Server](#step-5-starting-the-server)
7. [In-Depth Feature Explanations](#7-in-depth-feature-explanations)
   - [Firebase Authentication Middleware](#firebase-authentication-middleware)
   - [The Google Gemini 2.5 AI Brain](#the-google-gemini-25-ai-brain)
   - [Workflow Engine & Chaining Mechanism](#workflow-engine--chaining-mechanism)
   - [The Credit Engine](#the-credit-engine)
   - [Real-Time Server-Sent Events (SSE)](#real-time-server-sent-events-sse)
8. [Database Schema (Firestore)](#8-database-schema-firestore)
   - [The `users` Collection](#the-users-collection)
   - [The `automations` Collection](#the-automations-collection)
   - [The `executions` Collection](#the-executions-collection)
9. [API Route Documentation](#9-api-route-documentation)
   - [Authentication & User Routes](#authentication--user-routes)
   - [AI & Intent Routes](#ai--intent-routes)
   - [Automation Execution Routes](#automation-execution-routes)
   - [Credits & Limits Routes](#credits--limits-routes)
10. [N8N Integration Example](#10-n8n-integration-example)
11. [Troubleshooting & Common Errors](#11-troubleshooting--common-errors)
12. [Contribution Guidelines](#12-contribution-guidelines)
13. [License](#13-license)

---

## 1. Introduction to WebPilot

WebPilot is a next-generation web automation tool designed to make orchestrating cloud workflows as easy as having a conversation. 

If you want to read data from Google Sheets, summarize it using Google Gemini, and then natively post it to LinkedIn and notify your Slack team, all you have to do is type it out into a Chatbox. The WebPilot system interprets your command, constructs a Node-based logic diagram, and dynamically provisions the required backend webhooks to make your dream a reality. 

This repository, **`webpilot-backend`**, acts as the central hub of operations. It doesn't perform the final API requests directly (that's N8N's job). Instead, it securely stores your data in Firestore, tells the AI what to build, deducts your usage credits, and strictly commands N8N on when, where, and how to fire.

---

## 2. What Does This Application Do?

In simple words, the WebPilot application is an **Automation Orchestrator**. 

Consider a user who wants an automation: *"Every morning at 9:00 AM, fetch my Google Drive analytics and send it to me over Email."*

The WebPilot Frontend captures this user request, but it's the **WebPilot Backend** that does the heavy lifting:

1. **Natural Language Decoding:** The backend securely passes the user's prompt to Google's highly advanced Gemini 2.5 Flash model. It then analyzes what the user is legally allowed to do, filters out any malicious intents, and returns a JSON payload denoting exactly which "Nodes" (like a Google Drive Node, an Email Node, and a Timer Node) are needed.
2. **Database Management:** Once the AI finishes dreaming up the blueprint, the backend translates the blueprint and permanently stores it in Google Firestore.
3. **Trigger Management:** When the user clicks "Run Now" or a cron-job expires, the backend queries the database for the exact configuration the user created.
4. **Integration with N8N:** N8N (Nodemation) is an open-source workflow execution engine running on a separate server. The WebPilot Backend initiates a POST request directly to a customized N8N webhook trigger. It injects the user's OAuth tokens and configurations so that N8N can do the manual labor of authenticating with Google and sending emails.
5. **Real-Time Pipeline Viewing:** As N8N processes tasks, N8N fires HTTP callbacks to the WebPilot Backend. The backend then transmits live Server-Sent Events (SSE) to the user's browser, essentially drawing a live visual map of the data moving through the pipes.

---

## 3. System Architecture & Data Flow

Understanding the system architecture is the single most important step for developers cloning this project. 

The architecture is built on three massive pillars:

### Pillar 1: The React Frontend (User Viewport)
Provides the interactive layout, the drag-and-drop Canvas (React Flow), and the sleek chat interface. It makes HTTP REST calls to this Node.js Backend using Bearer token headers verified via Google Firebase Authentication.

### Pillar 2: The Node.js Backend (This Repository)
The brain. Handles AI prompt engineering (`aiService.js`), routes logic, enforces API rate limits, deducts system credits, reads and writes from the remote Firestore database, and acts as a middleman for all execution paths.

### Pillar 3: N8N (Execution Muscles)
An independently deployed N8N instance. The Node.js backend does **not** natively talk to Google Drive or YouTube to upload videos. That would require hardcoding thousands of APIs. Instead, the Node.js backend talks directly to N8N Webhooks, and N8N acts out the instructions by routing the provided OAuth keys into its own highly robust Google/YouTube integration nodes.

### The Macro Data Flow:
```mermaid
graph TD
    A[Frontend Client (React)] -->|HTTP POST /api/run-draft| B(WebPilot Node.js Backend)
    B -->|Fetch Auth / Configs| C[(Firebase Firestore)]
    C --> B
    B -->|POST HTTP Requests to chained webhooks| D{N8N Automation Engine}
    D -->|Perform Action| E[External API (e.g. YouTube)]
    E -->|Response Data| D
    D -->|POST /api/webhooks/n8n/callback| B
    B -->|Server-Sent Events| A
```

> **Where does the AI live?**
> The AI lives inside the Backend inside `/src/services/aiService.js`. When the frontend pings `/api/chat`, the backend opens a pipeline directly to Google Vertex/Gemini and provides a MASSIVE system prompt explaining node templates.

![WebPilot Architecture Overview](<Insert Screenshot URL Here>)
*(Space left intentionally for Architecture Overview Screenshot)*

---

## 4. Technology Stack

Because this application needs to be incredibly fast, highly scalable, and completely serverless-friendly, we opted for the latest modular technologies:

- **Runtime Environment:** [Node.js](https://nodejs.org/en) (v18+ Recommended)
- **Web Framework:** [Express.js](https://expressjs.com/)
- **Database & Authentication:** [Firebase Admin / Firestore](https://firebase.google.com/)
- **Cross-Origin Resource Sharing:** [CORS](https://expressjs.com/en/resources/middleware/cors.html)
- **Environment Variables:** `dotenv`
- **Real-time Event Streaming:** Server-Sent Events (SSE)
- **AI Brains / LLM:** Google Gemini API (`@google/generative-ai`) via 2.5 Flash.
- **Background Worker Integrations:** N8N Open Framework Webhooks.

---

## 5. Prerequisites & Requirements

Before you hit the clone button, ensure your operating environment supports the following configuration files and runtimes:

1. **Node.js (v18.x or above):** Essential for running the modern JS imports and logic.
2. **NPM or Yarn:** For package management (this repo uses `package-lock.json`).
3. **Google Firebase Account:** You must have a free tier Firebase active account to utilize Firestore as the NoSQL database logic. 
4. **Google Gemini API Key:** Required for generating AI workflows.
5. **A Deployed N8N Instance:** N8N must be hosted to process the backend's webhooks.

---

## 6. Detailed Setup Instructions

Follow these exact steps to run the backend natively on your local machine.

### Step 1: Clone the Repository
Open a terminal prompt and download the project.
```bash
git clone https://github.com/affanengi/webpilot-backend.git
cd webpilot-backend
```

### Step 2: Install Node Dependencies
Install all the core Express libraries and tooling files.
```bash
npm install
```

### Step 3: Firebase Admin Setup
WebPilot requires administrative priority over your Firestore database.
1. Go to the [Firebase Developer Console](https://console.firebase.google.com/).
2. Click on your project > **Project Settings** > **Service Accounts**.
3. Click "Generate New Private Key".
4. Rename that downloaded JSON file to `serviceAccountKey.json`.
5. Drop `serviceAccountKey.json` directly into the very top (root) directory of this repository (`webpilot-backend/serviceAccountKey.json`).

*(This is heavily ignored by `.gitignore` to prevent you from accidentally leaking the master database key to the public!).*

### Step 4: Environment Configuration
Create a `.env` file in the root directory. Copy everything below and replace the capitalized words with your real tokens:

```env
# Server Mapping
PORT=3000

# The address of your running Frontend React Server (required for CORS permission)
FRONTEND_URL=http://localhost:5173

# The address of your deployed N8N API Engine
N8N_BASE_URL=https://your-n8n-instance-url.com

# Google Gemini API key used in /src/services/aiService.js
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE

# Security token designed to protect your callback webhooks.
# Make this string whatever you want, but ensure N8N's callback 
# headers pass this EXACT string inside "x-n8n-callback-secret".
N8N_CALLBACK_SECRET=SUPER_SECRET_AUTHENTICATION_STRING_FOR_N8N
```

### Step 5: Starting the Server
You're practically finished! Now, launch the hot-reloading development server:

```bash
npm run dev
```
If you configured it properly, you'll see green text on your terminal saying:
`🚀 Server running on http://localhost:3000!`
And it will successfully connect to Firebase!

---

## 7. In-Depth Feature Explanations

To modify this backend, you must understand exactly how its unique systems link to each other.

### Firebase Authentication Middleware
Look into `/src/middlewares/authMiddleware.js`. 
Every single time the frontend makes an API call, it sends an `Authorization: Bearer <token>` header. The Firebase Admin SDK grabs that token, authenticates it against Google's live server database, and attaches the decoded user data into `req.user`. If it fails, the server violently drops the connection (Http Status 401).

### The Google Gemini 2.5 AI Brain
Look into `/src/services/aiService.js`.
The backend doesn't just ask Gemini "Make an automation." The backend feeds Gemini a **massive system instruction set**. It teaches Gemini:
*   What an N8N node is.
*   What templates are available.
*   What parameters the Google Sheet node requires versus the Gmail Node.
*   The JSON strict schema to return.

Gemini returns raw JSON logic. The backend parses it, builds standard schema trees, sets the AI state to `success`, and injects it back to the user via UI cards!

![AI Service Console Overview](<Insert Screenshot URL Here>)

### Workflow Engine & Chaining Mechanism
Look into `/src/services/workflowEngine.js` and `/src/routes/webhooks.js`.
One node doesn't finish an automation; automations are chains. A common automation features: 
`[Schedule Node -> Google Sheets Output -> ChatGPT Re-phraser -> LinkedIn Poster]`

The workflow engine achieves this via **Chaining Execution State**:
1. The engine triggers the 1st node (Schedule) and creates an "execution log."
2. The 1st node completes on N8N.
3. N8N sends a callback POST request to `/api/webhooks/n8n/callback/1`.
4. The Webhook route receives the result of Step 1, maps the variables, then immediately triggers Step 2.
5. In Step 2, if the user requested `{{STEP_1_RESULT}}`, the Workflow Engine intelligently parses the string, rips the required data out of the execution cache, and sends it into Step 2!

### The Credit Engine
Nothing is free, including generative AI pipelines! Look inside `/src/routes/ai.js`. Every time a user interacts with the system:
1. The user spends 1 credit per AI prompt generation.
2. The user spends 5 credits per Workflow execution.
The backend validates if `user.credits > 0`. If they do, it decrements the value through Firestore `update({ credits: admin.firestore.FieldValue.increment(-1) })` ensuring no race conditions bypass the billing limit!

### Real-Time Server-Sent Events (SSE)
The frontend doesn't ping the backend continuously. Instead, the backend keeps the HTTP connection open forever using SSE (`/api/executions/stream/:executionId`). Every time a webhook reports an update to the backend, the backend streams a text notification packet `data: { status: 'running' }\n\n` down pipeline to the React Canvas!

---

## 8. Database Schema (Firestore)

The NoSQL data structure is the backbone of the application. Everything relies on these standard structures.

### The `users` Collection
Stores generic user data, settings, and remaining credits.
```json
{
  "uid": "1A2B3D...",
  "email": "user@google.com",
  "displayName": "Affan Developer",
  "credits": {
    "total": 500,
    "lastReplenished": Timestamp
  },
  "settings": {
    "theme": "dark"
  }
}
```

### The `automations` Collection
The permanent layout structure of a specific automation. Let's look at one created via the Canvas React Flow:
```json
{
  "userId": "1A2B3D...",
  "automationId": "auto_xyz123",
  "name": "My LinkedIn Bot",
  "description": "Posts to linkedin daily",
  "status": "enabled",
  "steps": [
    {
      "id": "node_schedule1",
      "type": "scheduleNode",
      "title": "Scheduled Trigger",
      "inputs": { "cron_expression": "0 9 * * *" }
    },
    {
      "id": "node_linkedin1",
      "type": "actionNode",
      "title": "LinkedIn Post",
      "n8nWebhookId": "1b2c3d...",
      "inputs": { "content": "Hello World!" },
      "required_account": "linkedin"
    }
  ],
  "createdAt": Timestamp
}
```

### The `executions` Collection
A temporary log structure storing the real-time execution result of an automation. Let's see what a failed output looks like:
```json
{
  "executionId": "exec_555",
  "automationId": "auto_xyz123",
  "status": "failed",
  "stepResults": {
    "0": { "status": "completed", "output": {"time": "09:00"} },
    "1": { "status": "failed", "error": "LinkedIn OAuth Key Expired", "time": Timestamp }
  }
}
```

---

## 9. API Route Documentation

Every API interaction from the WebPilot Application frontend targets one of these four massive core clusters. 

> **Authentication Required:** Almost all routes are protected and mandate the `Authorization: Bearer <JWT_TOKEN>` header. If the middleware drops it, these controllers never trigger.

### Authentication & User Routes
- `[GET] /api/user/me`: Analyzes the decoded JWT token, cross-references it with Firestore, and returns the complete User Profile including credit balances and connection flags.
- `[POST] /api/user/sync`: Triggers immediately after an SSO sign-in on the frontend to provision their default database documents if they are a brand-new user registering for the first time.

### AI & Intent Routes
Located inside `/routes/ai.js`.
- `[POST] /api/ai/chat`: The most magical route in the entire backend. Accepts a chat string. Automatically determines whether the user wants to `BUILD_AUTOMATION` or `DELETE_AUTOMATION` or `GENERAL_CHAT`. Handles the entire generation sequence, saves custom blueprints to the DB, and deducts 1 AI generation credit.

### Automation Execution Routes
- `[GET] /api/automations`: Lists every automation the authenticated user has access to.
- `[POST] /api/automations/draft/run-draft`: Triggers an automation directly using the configurations stored purely in memory (from the frontend canvas preview modal). Deducts execution credits and instantiates a new execution ID pipeline.
- `[POST] /api/automations/:id/trigger`: Same as `run-draft` but utilizes the permanent automation configuration stored on the database to initiate the task. Useful for programmatic requests.
- `[GET] /api/executions/:executionId`: Returns the historical log of a specific past execution, useful for visualizing outputs in the Execution History logs pane.
- `[GET] /api/executions/stream/:executionId`: Intitiates a Server-Sent Events network handshake to keep the pipeline alive. Returns real-time JSON log chunks recursively until the execution engine declares "success" or "fail".

### Callback Routes (For N8N)
- `[POST] /api/webhooks/n8n/callback`: Does NOT require a Bearer token. This is an open-internet connection. Instead, N8N securely authenticates by passing an `x-n8n-callback-secret` that perfectly maps to the API `.env` string. It receives data outputs from executed N8N chains and pushes the data towards the next internal node in the array chain loop.

![API Configuration Overview Visualization](<Insert Screenshot URL Here>)
*(Space left intentionally for API Route Architecture Diagrams)*

---

## 10. N8N Integration Example

How does N8N actually process these things? If you run an automation that specifies the **Google Docs** step, the Node.js backend pushes a payload to the Webhook associated with Google Docs on your N8N server:

**Payload format sent from Node.js (WebPilot Engine):**
```json
{
    "userId": "123",
    "automationId": "auto_890",
    "executionId": "exec_555",
    "stepIndex": 1,
    "action": "Create Document",
    "inputs": {
        "title": "My Weekly Generated File"
    },
    "tokens": {
        "google_docs": { "access_token": "ya29...", "refresh_token": "1//..." }
    }
}
```

The N8N server accepts this webhook! 
It extracts `tokens.google_docs`, applies it dynamically to an OAuth Parameter Node configured with the Google Workspace APIs, passes the `title`, triggers the Google REST Endpoint, creates the doc, and captures the URL of it.

Then, the final node inside N8N executes an HTTP Request pointing right back to the WebPilot Backend:
```http
POST /api/webhooks/n8n/callback
x-n8n-callback-secret: MY_SECRET_STRING
{
   "executionId": "exec_555",
   "stepIndex": 1,
   "status": "success",
   "output": {
       "url": "https://docs.google.com/doc/abc..."
   }
}
```

 WebPilot acknowledges the payload, and magically injects the URL stream directly into your user's UI.

---

## 11. Troubleshooting & Common Errors

If you run into issues while operating the backend locally, refer to the following common traps.

- **Issue:** `Error 401: Unauthorized` on all frontend API endpoints.
  - **Fix:** Your Firebase client configuration is outdated, or your clock is unsynced rendering the JWT signature invalid. Log out completely on the UI, clear local storage, and log back in to force a token refresh. 

- **Issue:** AI Chat instantly errors and says "Request failed".
  - **Fix:** Your `GEMINI_API_KEY` is either missing in the config or lacks billing enabled on the Google AI Platform. Make sure you use 2.5 Flash as your enabled model inside the Google Cloud Console. 

- **Issue:** `Failed to read serviceAccountKey.json`.
  - **Fix:** The backend is entirely unable to talk to the exact firebase implementation because the Admin SDK credentials are missing from the folder. Re-download it from the Project Settings panel and ensure the file is named perfectly.

- **Issue:** Automations get stuck on "Starting...".
  - **Fix:** The webhook callback failed. N8N executed the task but the WebPilot backend never received the specific response payload because `N8N_CALLBACK_SECRET` was improperly typed, or N8N didn't have internet access to reach the running backend host (i.e., attempting to ping Localhost over docker bridge).

---

## 12. Contribution Guidelines

We highly encourage contributions to extending the Node templates supported by WebPilot! 

**If you want to add a new Automation template to the platform:**
1. Fork the frontend repository to add the UI mappings for the node variables.
2. Go to your N8N instance, build the webhook node listener, action logic, and callback sender.
3. Update the `aiService.js` instructions on the backend to teach Gemini how to naturally map user descriptions to the precise variable requirements for your new node template!
4. Create a Pull Request summarizing the specific changes, and we'll evaluate the implementation logic!

---

## 13. License

Distributed under the MIT License. You are free to copy, modify, distribute, and otherwise use this software in any capacity.

Please utilize responsibly. Since the backend handles secure OAuth execution tokens on behalf of the users, be explicitly mindful of configuring `.env` keys securely and enforcing Firestore Database Security Policies before launching a full production deployment instance!

---
*Generated meticulously for Affan's proprietary platform framework. Automate everything, empower everyone.*
