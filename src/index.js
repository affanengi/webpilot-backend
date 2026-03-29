require("dotenv").config();
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

console.log("✅ Firebase Admin initialized");


const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/auth", authRoutes);
const oauthRoutes = require("./routes/oauth");
app.use("/auth", oauthRoutes);

const automationsRoutes = require("./routes/automations");
app.use("/automations", automationsRoutes);

const webhooksRoutes = require("./routes/webhooks");
app.use("/webhooks", webhooksRoutes);

const schedulerService = require("./services/schedulerService");

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`Backend running on port ${PORT}`);
  await schedulerService.initScheduler();
});