// shared.js — Utilities loaded on every page (like navbar.js).
// Provides: escHtml, formatBtc, formatUsd, formatSats, SPECIES_ICON, footer year.

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function formatBtc(n) {
  var num = parseFloat(n);
  if (isNaN(num)) return '\u2014';
  return num.toLocaleString('en-US', { maximumFractionDigits: 8 }) + ' BTC';
}

function formatUsd(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatSats(btc) {
  return Math.round(Number(btc) * 1e8).toLocaleString('en-US') + ' sats';
}

var SPECIES_ICON = {
  dog: '&#128054;', cat: '&#128049;', bird: '&#128038;', reptile: '&#129422;',
  'small animal': '&#128057;', fish: '&#128032;', horse: '&#128052;', other: '&#128062;'
};

// Auto-fill footer year on every page
document.addEventListener('DOMContentLoaded', function () {
  var el = document.getElementById('year');
  if (el) el.textContent = new Date().getFullYear();
});
