const express = require("express");
const authMiddleware = require("../middleware/auth");
const db = require("../services/firestore");

const router = express.Router();

router.get("/me", authMiddleware, async (req, res) => {
  try {
    const { uid, email, name, picture } = req.user;

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    // 🟢 First-time signup
    if (!userSnap.exists) {
      const newUser = {
        uid,
        email,
        name,
        photoURL: picture,
        plan: "free",
        dailyCredits: 20,
        lastCreditReset: new Date().toISOString().slice(0, 10),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await userRef.set(newUser);

      return res.json({
        success: true,
        user: newUser,
        isNewUser: true,
      });
    }

    // 🟢 Existing user login
    const userData = userSnap.data();

    // Migrate legacy users who have no dailyCredits yet
    if (userData.dailyCredits === undefined) {
      const today = new Date().toISOString().slice(0, 10);
      await userRef.update({ dailyCredits: 20, lastCreditReset: today });
      userData.dailyCredits = 20;
      userData.lastCreditReset = today;
    }

    return res.json({
      success: true,
      user: userData,
      isNewUser: false,
    });
  } catch (error) {
    console.error("AUTH /me error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

module.exports = router;