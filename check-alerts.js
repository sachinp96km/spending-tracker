// api/check-alerts.js — Vercel Serverless Function
// cron-job.org pings: https://spending-tracker360.vercel.app/api/check-alerts

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Initialize Firebase Admin only once
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

module.exports = async (req, res) => {
  // Security check — only cron-job.org can call this
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const usersSnap = await db.collection('users').get();
    const results = [];

    for (const userDoc of usersSnap.docs) {
      const data = userDoc.data();
      if (!data.sw3) continue;

      let S;
      try { S = JSON.parse(data.sw3); } catch(e) { continue; }

      const tgToken = S.settings?.tgToken;
      const tgChatId = S.settings?.tgChatId;
      if (!tgToken || !tgChatId) continue;

      const reminders = S.reminders || [];
      const today = getISTToday();
      const alerts = [];

      for (const r of reminders) {
        if (!r.date) continue;
        const daysLeft = daysDiff(r.date, today);

        // TYPE 1: Auto advance — 2 days before due date
        if (r.autoAlert !== false) {
          const alertOn = addDays(r.date, -2);
          if (alertOn === today) {
            alerts.push(
              `⏰ <b>SpendWise — 2 Day Reminder</b>\n\n` +
              `📌 <b>${r.title}</b>\n` +
              `💰 Amount: <b>₹${formatAmt(r.amount)}</b>\n` +
              `📅 Due in <b>2 days</b> on ${formatDate(r.date)}\n` +
              `⚡ Pay before it's too late!`
            );
          }
          // Due TODAY
          if (r.date === today) {
            alerts.push(
              `🔴 <b>SpendWise — Due TODAY!</b>\n\n` +
              `📌 <b>${r.title}</b>\n` +
              `💰 Amount: <b>₹${formatAmt(r.amount)}</b>\n` +
              `📅 Due <b>TODAY</b> — ${formatDate(r.date)}\n` +
              `⚡ Please pay now!`
            );
          }
        }

        // TYPE 2: Overdue — every day until settled
        if (daysLeft < 0) {
          const daysOver = Math.abs(daysLeft);
          alerts.push(
            `⚠️ <b>SpendWise — OVERDUE!</b>\n\n` +
            `📌 <b>${r.title}</b>\n` +
            `💰 Amount: <b>₹${formatAmt(r.amount)}</b>\n` +
            `📅 Was due: ${formatDate(r.date)}\n` +
            `🔴 Overdue by <b>${daysOver} day${daysOver !== 1 ? 's' : ''}</b> — settle immediately!`
          );
        }

        // TYPE 3: Custom date/time alert
        if (r.customAlertOn && r.alertDate) {
          const alertDateStr = (r.alertDate || '').trim().slice(0, 10);
          if (alertDateStr === today) {
            alerts.push(
              `🔔 <b>SpendWise — Custom Alert</b>\n\n` +
              `📌 <b>${r.title}</b>\n` +
              `💰 Amount: <b>₹${formatAmt(r.amount)}</b>\n` +
              `📅 Due date: ${formatDate(r.date)}\n` +
              `🕐 Your scheduled alert: ${r.alertTime || '09:00'}`
            );
          }
        }
      }

      // Also check Month Planner dues
      const planner = S.planner || [];
      for (const p of planner) {
        if (p.paid || !p.dueDate) continue;
        const daysLeft = daysDiff(p.dueDate, today);
        if (daysLeft === 2) {
          alerts.push(
            `📅 <b>SpendWise — Planned Payment in 2 Days</b>\n\n` +
            `📌 <b>${p.desc}</b>\n` +
            `💰 Amount: <b>₹${formatAmt(p.amount)}</b>\n` +
            `📅 Due: ${formatDate(p.dueDate)}`
          );
        }
        if (daysLeft === 0) {
          alerts.push(
            `📅 <b>SpendWise — Planned Payment Due TODAY</b>\n\n` +
            `📌 <b>${p.desc}</b>\n` +
            `💰 Amount: <b>₹${formatAmt(p.amount)}</b>\n` +
            `📅 Due: ${formatDate(p.dueDate)}`
          );
        }
        if (daysLeft < 0) {
          alerts.push(
            `⚠️ <b>SpendWise — Planned Payment OVERDUE</b>\n\n` +
            `📌 <b>${p.desc}</b>\n` +
            `💰 Amount: <b>₹${formatAmt(p.amount)}</b>\n` +
            `🔴 Overdue by ${Math.abs(daysLeft)} days`
          );
        }
      }

      // Send all alerts with delay between each
      for (let i = 0; i < alerts.length; i++) {
        await sendTelegram(tgToken, tgChatId, alerts[i]);
        results.push({ user: userDoc.id, msg: alerts[i].slice(0, 60) });
        // Small delay between messages
        if (i < alerts.length - 1) await sleep(500);
      }
    }

    console.log('[SpendWise] Alerts sent:', results.length);
    return res.status(200).json({
      success: true,
      time: new Date().toISOString(),
      alertsSent: results.length,
      results
    });

  } catch (err) {
    console.error('[SpendWise] Error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ──

async function sendTelegram(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage` +
    `?chat_id=${encodeURIComponent(chatId)}` +
    `&text=${encodeURIComponent(text)}` +
    `&parse_mode=HTML`;
  try {
    const res = await fetch(url);
    const d = await res.json();
    if (!d.ok) console.error('[SpendWise] Telegram error:', d.description);
    return d.ok;
  } catch(e) {
    console.error('[SpendWise] Telegram fetch error:', e.message);
    return false;
  }
}

function getISTToday() {
  // Get current date in IST (UTC+5:30)
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return dt.getFullYear() + '-' +
    String(dt.getMonth() + 1).padStart(2, '0') + '-' +
    String(dt.getDate()).padStart(2, '0');
}

function daysDiff(dateStr, fromStr) {
  const [y1, m1, d1] = dateStr.split('-').map(Number);
  const [y2, m2, d2] = fromStr.split('-').map(Number);
  return Math.round(
    (new Date(y1, m1-1, d1) - new Date(y2, m2-1, d2)) / (1000*60*60*24)
  );
}

function formatDate(str) {
  if (!str) return '';
  const [y, m, d] = str.split('-');
  return `${d}-${m}-${y}`;
}

function formatAmt(amt) {
  if (!amt) return '0';
  return Number(amt).toLocaleString('en-IN');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
