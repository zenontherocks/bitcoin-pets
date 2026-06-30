(function () {
  const style = document.createElement('style');
  style.textContent = [
    'nav{background:#1a1a1a;padding:0 2rem;display:flex;align-items:center;justify-content:space-between;height:60px;position:sticky;top:0;z-index:100;}',
    '.nav-logo{font-size:1.3rem;font-weight:700;color:#f7931a;text-decoration:none;letter-spacing:-0.5px;}',
    '.nav-logo span{color:#fff;}',
    '.nav-tagline{font-size:0.7rem;color:#777;font-style:italic;white-space:nowrap;margin-left:0.6rem;}',
    '.nav-links{list-style:none;display:flex;gap:0.25rem;align-items:center;}',
    '.nav-links a{color:#ccc;text-decoration:none;font-size:0.9rem;padding:0.4rem 0.75rem;border-radius:8px;transition:color 0.15s,background 0.15s;}',
    '.nav-links a:hover{color:#fff;background:#2e2e2e;}',
    '.nav-currency-toggle{display:flex;align-items:center;gap:0;background:#2e2e2e;border-radius:8px;overflow:hidden;margin-left:0.5rem;}',
    '.nav-currency-toggle button{background:none;border:none;color:#aaa;font-size:0.8rem;font-weight:700;padding:0.35rem 0.65rem;cursor:pointer;transition:background 0.15s,color 0.15s;font-family:inherit;}',
    '.nav-currency-toggle button.active{background:#f7931a;color:#fff;}',
    '.nav-toggle{display:none;flex-direction:column;gap:5px;cursor:pointer;padding:0.4rem;background:none;border:none;}',
    '.nav-toggle span{display:block;width:22px;height:2px;background:#fff;border-radius:2px;}',
    '@media(max-width:640px){',
    '  .nav-tagline{display:none;}',
    '  nav{height:auto!important;min-height:56px;position:relative;padding:0 1rem;}',
    '  .nav-toggle{display:flex;}',
    '  .nav-links{display:none;position:absolute;top:100%;left:0;right:0;flex-direction:column;background:#1a1a1a;padding:0.5rem 1rem 1rem;gap:0;border-top:1px solid #2e2e2e;z-index:99;}',
    '  .nav-links.open{display:flex;}',
    '  .nav-links li{width:100%;}',
    '  .nav-links a{display:block;padding:0.75rem 0.5rem;font-size:1rem;}',
    '}',
  ].join('\n');
  document.head.appendChild(style);

  // Currency preference stored in localStorage; default USD
  window.BP_CURRENCY = localStorage.getItem('bp_currency') || 'usd';

  function setCurrency(c) {
    window.BP_CURRENCY = c;
    localStorage.setItem('bp_currency', c);
    document.querySelectorAll('.nav-currency-toggle button').forEach(b => {
      b.classList.toggle('active', b.dataset.currency === c);
    });
    window.dispatchEvent(new CustomEvent('bp:currency', { detail: c }));
  }

  document.addEventListener('DOMContentLoaded', function () {
    const nav = document.createElement('nav');
    nav.innerHTML =
      '<a href="/" class="nav-logo">&#8383;<span>itcoin Pets</span></a>' +
      '<span class="nav-tagline">Buy pets with Bitcoin</span>' +
      '<button class="nav-toggle" aria-label="Toggle menu" onclick="this.closest(\'nav\').querySelector(\'.nav-links\').classList.toggle(\'open\')"><span></span><span></span><span></span></button>' +
      '<ul class="nav-links">' +
        '<li><a href="/browse">Browse Pets</a></li>' +
        '<li><a href="/how-it-works">How It Works</a></li>' +
        '<li><a href="/about">About</a></li>' +
        '<li><div class="nav-currency-toggle">' +
          '<button data-currency="usd">USD</button>' +
          '<button data-currency="btc">BTC</button>' +
        '</div></li>' +
      '</ul>';
    document.body.insertAdjacentElement('afterbegin', nav);

    nav.querySelectorAll('.nav-currency-toggle button').forEach(b => {
      b.classList.toggle('active', b.dataset.currency === window.BP_CURRENCY);
      b.addEventListener('click', () => setCurrency(b.dataset.currency));
    });
  });
}());
