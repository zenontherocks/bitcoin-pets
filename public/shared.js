// shared.js — Utilities loaded on every page (like navbar.js).
// Provides: escHtml, formatBtc, formatUsd, SPECIES_ICON, footer year.

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function formatBtc(n) {
  var num = Number(n);
  if (isNaN(num)) return '\u2014';
  var str = num.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  if (str.indexOf('0.') === 0) str = str.slice(1);
  return '\u20bf' + str;
}

function formatUsd(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ageFromDob(dob) {
  if (!dob) return null;
  var birth = new Date(dob);
  var now = new Date();
  var years = now.getFullYear() - birth.getFullYear();
  var months = now.getMonth() - birth.getMonth();
  if (months < 0) { years--; months += 12; }
  if (years > 0) return years + ' yr' + (years > 1 ? 's' : '') + (months > 0 ? ', ' + months + ' mo' : '');
  if (months > 0) return months + ' month' + (months > 1 ? 's' : '');
  return 'Less than 1 month';
}

var SPECIES_ICON = {
  dog: '&#128054;', cat: '&#128049;', bird: '&#128038;', reptile: '&#129422;',
  'small animal': '&#128057;', fish: '&#128032;', horse: '&#128052;', other: '&#128062;'
};

// Auto-fill footer year on every page
document.addEventListener('DOMContentLoaded', function () {
  var el = document.getElementById('year');
  if (el) el.textContent = new Date().getFullYear();

  var notice = document.getElementById('cookieNotice');
  if (notice) {
    if (localStorage.getItem('cookieNoticeChoice')) {
      notice.style.display = 'none';
    } else {
      notice.querySelectorAll('.cookie-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          localStorage.setItem('cookieNoticeChoice', btn.dataset.choice);
          notice.style.display = 'none';
        });
      });
    }
  }
});
