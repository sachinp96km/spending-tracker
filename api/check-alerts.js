// api/check-alerts.js — Vercel Serverless Function
// cron-job.org pings every 30 min → checks reminders → fires Telegram

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

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
  // Security check
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Read from spendwise_alerts collection (no auth needed)
    const snap = await db.collection('spendwise_alerts').get();
    const results = [];
    const today = getISTToday();
    const nowIST = getISTNow();

    for (const doc of snap.docs) {
      const data = doc.data();
      const tgToken = data.tgToken;
      const tgChatId = data.tgChatId;
      if (!tgToken || !tgChatId) continue;

      let reminders = [];
      let planner = [];
      try { reminders = JSON.parse(data.reminders || '[]'); } catch(e) {}
      try { planner = JSON.parse(data.planner || '[]'); } catch(e) {}

      for (const r of reminders) {
        if (!r.date) continue;
        const daysLeft = daysDiff(r.date, today);

        // Custom time alert — check if today matches AND time is within 30 min window
        if (r.customAlertOn && r.alertDate) {
          const alertDate = (r.alertDate||'').trim().slice(0,10);
          if (alertDate === today) {
            const { hh, mm } = parseTime(r.alertTime || '09:00');
            const alertMins = hh * 60 + mm;
            const nowMins = nowIST.hh * 60 + nowIST.mm;
            // Fire if within 30 minute window
            if (nowMins >= alertMins && nowMins < alertMins + 30) {
              await sendTelegram(tgToken, tgChatId,
                `🔔 <b>SpendWise Alert</b>\n\n📌 <b>${r.title}</b>\n💰 Amount: <b>₹${fmt(r.amount)}</b>\n📅 Due: ${formatDate(r.date)}\n🕐 Scheduled at: ${r.alertTime}`
              );
              results.push({ type: 'custom', title: r.title });
            }
          }
        }

        // Auto advance — 2 days before
        if (r.autoAlert !== false) {
          if (addDays(r.date, -2) === today) {
            await sendTelegram(tgToken, tgChatId,
              `⏰ <b>SpendWise — Due in 2 Days!</b>\n\n📌 <b>${r.title}</b>\n💰 Amount: <b>₹${fmt(r.amount)}</b>\n📅 Due on: ${formatDate(r.date)}`
            );
            results.push({ type: '2day', title: r.title });
          }
          // Due today
          if (r.date === today) {
            await sendTelegram(tgToken, tgChatId,
              `🔴 <b>SpendWise — Due TODAY!</b>\n\n📌 <b>${r.title}</b>\n💰 Amount: <b>₹${fmt(r.amount)}</b>\n📅 Pay today!`
            );
            results.push({ type: 'today', title: r.title });
          }
        }

        // Overdue
        if (daysLeft < 0) {
          // Only send overdue once per day (morning ping)
          const nowH = nowIST.hh;
          if (nowH >= 8 && nowH < 9) { // only during 8-9 AM IST
            await sendTelegram(tgToken, tgChatId,
              `⚠️ <b>SpendWise — OVERDUE!</b>\n\n📌 <b>${r.title}</b>\n💰 Amount: <b>₹${fmt(r.amount)}</b>\n🔴 Overdue by <b>${Math.abs(daysLeft)} days</b>`
            );
            results.push({ type: 'overdue', title: r.title });
          }
        }
      }

      // Planner dues
      for (const p of planner) {
        if (p.paid || !p.dueDate) continue;
        const daysLeft = daysDiff(p.dueDate, today);
        if (daysLeft === 2) {
          await sendTelegram(tgToken, tgChatId,
            `📅 <b>SpendWise — Planned Payment in 2 Days</b>\n\n📌 <b>${p.desc}</b>\n💰 Amount: <b>₹${fmt(p.amount)}</b>\n📅 Due: ${formatDate(p.dueDate)}`
          );
          results.push({ type: 'planner', title: p.desc });
        }
      }
    }

    return res.status(200).json({
      success: true,
      time: new Date().toISOString(),
      istTime: `${nowIST.hh}:${String(nowIST.mm).padStart(2,'0')}`,
      alertsSent: results.length,
      results
    });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ──
async function sendTelegram(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${encodeURIComponent(chatId)}&text=${encodeURIComponent(text)}&parse_mode=HTML`;
  try {
    const res = await fetch(url);
    const d = await res.json();
    return d.ok;
  } catch(e) { return false; }
}

function getISTToday() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth()+1).padStart(2,'0')}-${String(ist.getUTCDate()).padStart(2,'0')}`;
}

function getISTNow() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return { hh: ist.getUTCHours(), mm: ist.getUTCMinutes() };
}

function parseTime(str) {
  str = (str||'').trim();
  const m12 = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let hh = parseInt(m12[1]), mm = parseInt(m12[2]);
    const ap = m12[3].toUpperCase();
    if (ap === 'AM' && hh === 12) hh = 0;
    if (ap === 'PM' && hh !== 12) hh += 12;
    return { hh, mm };
  }
  const m24 = str.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) return { hh: parseInt(m24[1]), mm: parseInt(m24[2]) };
  return { hh: 9, mm: 0 };
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

function daysDiff(a, b) {
  const [y1,m1,d1] = a.split('-').map(Number);
  const [y2,m2,d2] = b.split('-').map(Number);
  return Math.round((new Date(y1,m1-1,d1) - new Date(y2,m2-1,d2)) / 86400000);
}

function formatDate(s) {
  if (!s) return '';
  const [y,m,d] = s.split('-');
  return `${d}-${m}-${y}`;
}

function fmt(n) {
  return Number(n||0).toLocaleString('en-IN');
}
