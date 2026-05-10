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
    const snap = await db.collection('spendwise_alerts').get();
    const results = [];
    const today = getISTToday();
    const nowIST = getISTNow();

    for (const doc of snap.docs) {
      const data = doc.data();
      const tgToken = data.tgToken;
      const tgChatId = data.tgChatId;
      if (!tgToken || !tgChatId) continue;

      // Load already fired alerts log
      const firedRef = db.collection('spendwise_fired').doc(doc.id);
      const firedSnap = await firedRef.get();
      const fired = firedSnap.exists ? (firedSnap.data().keys || []) : [];

      let reminders = [];
      let planner = [];
      try { reminders = JSON.parse(data.reminders || '[]'); } catch(e) {}
      try { planner = JSON.parse(data.planner || '[]'); } catch(e) {}

      const newFired = [...fired];

      for (const r of reminders) {
        if (!r.date || !r.id) continue;
        const daysLeft = daysDiff(r.date, today);

        // CUSTOM TIME ALERT — fires ONCE at exact time (within 30 min window)
        if (r.customAlertOn && r.alertDate) {
          const alertDate = (r.alertDate||'').trim().slice(0,10);
          const fireKey = `custom_${r.id}_${alertDate}`;
          if (alertDate === today && !fired.includes(fireKey)) {
            const { hh, mm } = parseTime(r.alertTime || '09:00');
            const alertMins = hh * 60 + mm;
            const nowMins = nowIST.hh * 60 + nowIST.mm;
            if (nowMins >= alertMins && nowMins < alertMins + 30) {
              await sendTelegram(tgToken, tgChatId,
                `🔔 <b>SpendWise Custom Alert</b>

📌 <b>${r.title}</b>
💰 Amount: <b>₹${fmt(r.amount)}</b>
📅 Due: ${formatDate(r.date)}
🕐 Scheduled: ${r.alertTime}`
              );
              newFired.push(fireKey);
              results.push({ type: 'custom', title: r.title });
            }
          }
        }

        // 2 DAYS BEFORE — fires ONCE
        if (r.autoAlert !== false) {
          const twoDayKey = `2day_${r.id}_${today}`;
          if (addDays(r.date, -2) === today && !fired.includes(twoDayKey)) {
            await sendTelegram(tgToken, tgChatId,
              `⏰ <b>SpendWise — Due in 2 Days!</b>

📌 <b>${r.title}</b>
💰 Amount: <b>₹${fmt(r.amount)}</b>
📅 Due on: ${formatDate(r.date)}`
            );
            newFired.push(twoDayKey);
            results.push({ type: '2day', title: r.title });
          }

          // DUE TODAY — fires ONCE
          const todayKey = `today_${r.id}_${today}`;
          if (r.date === today && !fired.includes(todayKey)) {
            await sendTelegram(tgToken, tgChatId,
              `🔴 <b>SpendWise — Due TODAY!</b>

📌 <b>${r.title}</b>
💰 Amount: <b>₹${fmt(r.amount)}</b>
📅 Please pay today!`
            );
            newFired.push(todayKey);
            results.push({ type: 'today', title: r.title });
          }
        }

        // OVERDUE — fires ONCE per day at morning (8-9 AM IST only)
        if (daysLeft < 0 && nowIST.hh >= 8 && nowIST.hh < 9) {
          const overdueKey = `overdue_${r.id}_${today}`;
          if (!fired.includes(overdueKey)) {
            await sendTelegram(tgToken, tgChatId,
              `⚠️ <b>SpendWise — OVERDUE!</b>

📌 <b>${r.title}</b>
💰 Amount: <b>₹${fmt(r.amount)}</b>
🔴 Overdue by <b>${Math.abs(daysLeft)} day${Math.abs(daysLeft)>1?'s':''}</b>`
            );
            newFired.push(overdueKey);
            results.push({ type: 'overdue', title: r.title });
          }
        }
      }

      // PLANNER — fires ONCE
      for (const p of planner) {
        if (p.paid || !p.dueDate || !p.id) continue;
        const daysLeft = daysDiff(p.dueDate, today);
        const planKey = `planner_${p.id}_${today}`;
        if ((daysLeft === 2 || daysLeft === 0) && !fired.includes(planKey)) {
          await sendTelegram(tgToken, tgChatId,
            `📅 <b>SpendWise — Planned Payment ${daysLeft===0?'TODAY':'in 2 Days'}</b>

📌 <b>${p.desc}</b>
💰 Amount: <b>₹${fmt(p.amount)}</b>
📅 Due: ${formatDate(p.dueDate)}`
          );
          newFired.push(planKey);
          results.push({ type: 'planner', title: p.desc });
        }
      }

      // Save fired log — clean old keys (keep only last 7 days)
      if (newFired.length > fired.length) {
        const cleanFired = newFired.filter(k => {
          const parts = k.split('_');
          const dateStr = parts[parts.length-1];
          if (!dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) return true;
          return daysDiff(today, dateStr) <= 7;
        });
        await firedRef.set({ keys: cleanFired, updatedAt: new Date().toISOString() });
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
