/**
 * credits.js — Daily credit system with admin bypass.
 *
 * Rules:
 *  - Admin email(s) → unlimited (skip all deduction/checks)
 *  - All others → 20 credits/day, resets at midnight UTC
 */

const db = require("./firestore");

const ADMIN_EMAILS = ["mohammedaffanrazvi604@gmail.com"];
const DAILY_CREDIT_ALLOWANCE = 20;

/**
 * Returns current credits for `uid`. Auto-resets daily for normal users.
 * Returns Infinity for admin accounts.
 */
async function getCredits(uid) {
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw new Error("User not found");

    const data = userSnap.data();

    // Admin bypass
    if (ADMIN_EMAILS.includes(data.email)) return Infinity;

    const todayStr = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    const lastReset = data.lastCreditReset || "";

    // Auto-reset if it's a new day
    if (lastReset !== todayStr) {
        await userRef.update({
            dailyCredits: DAILY_CREDIT_ALLOWANCE,
            lastCreditReset: todayStr,
        });
        return DAILY_CREDIT_ALLOWANCE;
    }

    const credits = data.dailyCredits;
    return credits !== undefined ? credits : DAILY_CREDIT_ALLOWANCE;
}

/**
 * Checks if user has enough credits and deducts them.
 * Returns { allowed: true } or { allowed: false, error: "..." }
 */
async function useCredits(uid, amount) {
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return { allowed: false, error: "User not found" };

    const data = userSnap.data();

    // Admin bypass
    if (ADMIN_EMAILS.includes(data.email)) return { allowed: true };

    const todayStr = new Date().toISOString().slice(0, 10);
    const lastReset = data.lastCreditReset || "";

    let credits = data.dailyCredits;

    // Auto-reset if new day
    if (lastReset !== todayStr) {
        credits = DAILY_CREDIT_ALLOWANCE;
        await userRef.update({ dailyCredits: credits, lastCreditReset: todayStr });
    }

    if (credits === undefined) credits = DAILY_CREDIT_ALLOWANCE;

    if (credits < amount) {
        return {
            allowed: false,
            error: `Insufficient daily credits. You need at least ${amount} credits. Your credits reset daily at midnight UTC.`,
        };
    }

    await userRef.update({ dailyCredits: credits - amount });
    return { allowed: true };
}

module.exports = { getCredits, useCredits, ADMIN_EMAILS, DAILY_CREDIT_ALLOWANCE };
