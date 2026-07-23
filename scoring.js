// scoring.js — Badges, Trust-Faktor und erfahrungsabhängige Auszahlungsquote.
const { db } = require("./db");

function completedCount(userId) {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM jobs WHERE accepted_by_id = ? AND status = 'erledigt'"
    )
    .get(userId);
  return row.c;
}

function expiredCount(userId) {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM jobs WHERE accepted_by_id = ? AND status = 'abgelaufen'"
    )
    .get(userId);
  return row.c;
}

function postedCount(userId) {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM jobs WHERE poster_id = ?")
    .get(userId);
  return row.c;
}

function trustFactor(userId) {
  const completed = completedCount(userId);
  const expired = expiredCount(userId);
  const total = completed + expired;
  if (total === 0) return null;
  return Math.round((completed / total) * 100);
}

function tierBadge(count) {
  if (count >= 20) return "gold";
  if (count >= 10) return "silber";
  if (count >= 5) return "bronze";
  return null;
}

function payoutRate(userId) {
  const completed = completedCount(userId);
  const trust = trustFactor(userId);
  const experienced = completed >= 5 && (trust === null || trust >= 90);
  return experienced ? 1.0 : 0.8;
}

function userStats(userId) {
  const completed = completedCount(userId);
  return {
    completedJobs: completed,
    expiredJobs: expiredCount(userId),
    postedJobs: postedCount(userId),
    trustFactor: trustFactor(userId),
    tierBadge: tierBadge(completed),
    payoutRate: payoutRate(userId),
  };
}

module.exports = {
  completedCount,
  expiredCount,
  postedCount,
  trustFactor,
  tierBadge,
  payoutRate,
  userStats,
};
