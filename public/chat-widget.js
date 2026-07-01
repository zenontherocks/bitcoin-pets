// chat-widget.js — Nostr-based live chat, loaded only on /contact.
// Visitors get a throwaway keypair (persisted in localStorage) and DM the
// site owner's npub over public relays using NIP-17 gift-wrapped private
// messages (the format modern clients like 0xChat, Amethyst, and Primal
// actually send/expect — legacy NIP-04 kind-4 DMs are not reliably readable
// or repliable-to in those clients). No backend involved.
//
// nostr-tools is imported dynamically (not as a static top-level import) so
// that a failure to reach the CDN degrades to a friendly message instead of
// silently breaking the whole module (and anything else on the page that
// depends on it, like the "chatting about" banner in contact.html).
const NOSTR_TOOLS_URL = 'https://esm.sh/nostr-tools@2';

const OWNER_PUBKEY_HEX = '148f4cf17719a3f4f07e6f3f1a900bf440adb681049d40a216e54f976de4345d';
const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
];
// Relays used only to look up relay-list metadata (NIP-65 kind 10002, NIP-17
// kind 10050) for the owner's pubkey.
const DISCOVERY_RELAYS = ['wss://purplepag.es', 'wss://relay.nostr.band'];

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

export async function initChat(container, { petId, petName } = {}) {
  const style = document.createElement('style');
  style.textContent = [
    '.chat-box{display:flex;flex-direction:column;height:420px;border:1px solid var(--border,#ddd);border-radius:var(--radius,8px);background:var(--surface,var(--white,#fff));overflow:hidden;}',
    '.chat-messages{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:0.6rem;}',
    '.chat-bubble{max-width:80%;padding:0.55rem 0.85rem;border-radius:14px;font-size:0.9rem;line-height:1.4;word-wrap:break-word;white-space:pre-wrap;}',
    '.chat-bubble.sent{align-self:flex-end;background:var(--orange,#f7931a);color:#fff;border-bottom-right-radius:4px;}',
    '.chat-bubble.recv{align-self:flex-start;background:var(--bg,var(--light-gray,#f0f0f0));color:var(--text,var(--dark,#1a1a1a));border-bottom-left-radius:4px;}',
    '.chat-status{font-size:0.8rem;color:#999;text-align:center;padding:0.5rem;}',
    '.chat-input-row{display:flex;border-top:1px solid var(--border,#ddd);}',
    '.chat-input-row input{flex:1;border:none;padding:0.75rem;font-size:0.9rem;font-family:inherit;outline:none;background:var(--surface,var(--white,#fff));color:var(--text,var(--dark,#1a1a1a));}',
    '.chat-input-row button{border:none;background:var(--orange,#f7931a);color:#fff;padding:0 1.25rem;font-weight:700;cursor:pointer;}',
    '.chat-input-row button:hover{background:var(--orange-dark,#d97b0e);}',
    '.chat-input-row button:disabled{opacity:0.5;cursor:default;}',
  ].join('\n');
  document.head.appendChild(style);

  container.innerHTML =
    '<div class="chat-box">' +
      '<div class="chat-messages" id="chatMessages"><div class="chat-status" id="chatStatus">Connecting…</div></div>' +
      '<div class="chat-input-row">' +
        '<input type="text" id="chatInput" placeholder="Type a message…" disabled />' +
        '<button id="chatSend" disabled>Send</button>' +
      '</div>' +
    '</div>';

  const messagesEl = container.querySelector('#chatMessages');
  const statusEl = container.querySelector('#chatStatus');
  const inputEl = container.querySelector('#chatInput');
  const sendBtn = container.querySelector('#chatSend');

  let nostrTools;
  try {
    nostrTools = await import(/* @vite-ignore */ NOSTR_TOOLS_URL);
  } catch {
    statusEl.textContent = 'Live chat is temporarily unavailable. Please try again later.';
    return;
  }
  const { generateSecretKey, getPublicKey, finalizeEvent, nip17, nip19, SimplePool } = nostrTools;

  let skHex = localStorage.getItem('bp_nostr_sk');
  if (!skHex) {
    skHex = bytesToHex(generateSecretKey());
    localStorage.setItem('bp_nostr_sk', skHex);
  }
  const skBytes = hexToBytes(skHex);
  const pubkey = getPublicKey(skBytes);

  const showNsecBtn = document.getElementById('showNsecBtn');
  const nsecReveal = document.getElementById('nsecReveal');
  if (showNsecBtn && nsecReveal) {
    showNsecBtn.addEventListener('click', () => {
      const nsec = nip19.nsecEncode(skBytes);
      const code = document.createElement('code');
      code.textContent = nsec;
      const actions = document.createElement('div');
      actions.className = 'nsec-reveal-actions';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(nsec).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        });
      });
      const hideBtn = document.createElement('button');
      hideBtn.type = 'button';
      hideBtn.textContent = 'Hide';
      hideBtn.addEventListener('click', () => {
        nsecReveal.style.display = 'none';
        nsecReveal.replaceChildren();
      });
      actions.append(copyBtn, hideBtn);
      nsecReveal.replaceChildren(code, actions);
      nsecReveal.style.display = 'flex';
    });
  }

  function addBubble(text, kind) {
    if (statusEl && statusEl.parentNode) statusEl.remove();
    const el = document.createElement('div');
    el.className = 'chat-bubble ' + kind;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Avoids showing the same message twice across the three ways it can
  // arrive: the initial history load, the live subscription, and the
  // focus-triggered refetch.
  const seenEventIds = new Set();

  // Some relays require NIP-42 auth before they'll deliver DM-related event
  // kinds (to stop third parties from scraping who's messaging whom) —
  // auto-respond to any auth challenge using our own throwaway key. Also keep
  // the connection alive and auto-reconnect: both default to off, so a tab
  // left idle (e.g. while switching over to reply from a phone app) silently
  // drops its WebSocket and never sees anything sent after that point.
  const pool = new SimplePool({
    automaticallyAuth: () => (authEvent) => Promise.resolve(finalizeEvent(authEvent, skBytes)),
    enablePing: true,
    enableReconnect: true,
  });

  // Find where the owner actually wants DMs delivered: their NIP-17 "DM
  // relay list" (kind 10050) if published, falling back to their general
  // NIP-65 relay list (kind 10002), merged with our own defaults.
  let dmRelays = RELAYS;
  try {
    const lookupRelays = [...RELAYS, ...DISCOVERY_RELAYS];
    const [dmListEvent, generalListEvent] = await Promise.all([
      pool.get(lookupRelays, { kinds: [10050], authors: [OWNER_PUBKEY_HEX] }),
      pool.get(lookupRelays, { kinds: [10002], authors: [OWNER_PUBKEY_HEX] }),
    ]);
    const fromTags = (event, tagName) =>
      event ? event.tags.filter(t => t[0] === tagName && t[1] && t[2] !== 'read').map(t => t[1]) : [];
    dmRelays = Array.from(new Set([...RELAYS, ...fromTags(dmListEvent, 'relay'), ...fromTags(generalListEvent, 'r')]));
    console.log('[chat] owner kind10050 found:', !!dmListEvent, 'kind10002 found:', !!generalListEvent, 'dmRelays:', dmRelays);
  } catch (err) {
    console.log('[chat] relay discovery failed, using defaults:', err);
  }

  // Publish our own DM relay list so the owner's client knows where to send
  // gift-wrapped replies to this throwaway visitor identity.
  try {
    const ownDmList = finalizeEvent({
      kind: 10050,
      created_at: Math.floor(Date.now() / 1000),
      tags: RELAYS.map(url => ['relay', url]),
      content: '',
    }, skBytes);
    const results = await Promise.allSettled(pool.publish(dmRelays, ownDmList));
    console.log('[chat] published own kind10050 relay list:', results.map(r => r.status));
  } catch (err) {
    console.log('[chat] failed to publish own kind10050:', err);
  }

  setTimeout(() => {
    console.log('[chat] relay connection status:', Object.fromEntries(pool.listConnectionStatus()));
  }, 4000);

  // NIP-17 lets a message be wrapped once per recipient, including the
  // sender themselves — so our own sent messages become recoverable from
  // the relays too (not just an in-memory echo lost on reload).
  async function send(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const wraps = nip17.wrapManyEvents(skBytes, [{ publicKey: OWNER_PUBKEY_HEX, relayUrl: RELAYS[0] }], trimmed);
    wraps.forEach(w => seenEventIds.add(w.id));
    await Promise.allSettled(wraps.flatMap(w => pool.publish(dmRelays, w)));
    addBubble(trimmed, 'sent');
  }

  function handleSend() {
    const text = inputEl.value;
    inputEl.value = '';
    send(text);
  }

  sendBtn.addEventListener('click', handleSend);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSend();
  });

  function unwrapValid(event) {
    try {
      const rumor = nip17.unwrapEvent(event, skBytes);
      if (rumor.pubkey === OWNER_PUBKEY_HEX || rumor.pubkey === pubkey) return rumor;
    } catch (err) {
      console.log('[chat] failed to unwrap event:', err);
    }
    return null;
  }

  function displayRumor(rumor) {
    addBubble(rumor.content, rumor.pubkey === pubkey ? 'sent' : 'recv');
  }

  function handleIncomingWrap(event) {
    if (seenEventIds.has(event.id)) return;
    seenEventIds.add(event.id);
    const rumor = unwrapValid(event);
    if (rumor) displayRumor(rumor);
  }

  // Gift-wrap timestamps are deliberately randomized (NIP-59) for privacy,
  // so history has to be sorted by the rumor's real created_at, not the
  // order events happen to arrive in.
  async function loadHistory() {
    const stored = await pool.querySync(dmRelays, { kinds: [1059], '#p': [pubkey] });
    console.log('[chat] loaded', stored.length, 'stored gift wraps');
    const rumors = [];
    for (const event of stored) {
      if (seenEventIds.has(event.id)) continue;
      seenEventIds.add(event.id);
      const rumor = unwrapValid(event);
      if (rumor) rumors.push(rumor);
    }
    rumors.sort((a, b) => a.created_at - b.created_at);
    rumors.forEach(displayRumor);
  }

  await loadHistory();

  console.log('[chat] subscribing for gift wraps addressed to', pubkey, 'on', dmRelays);
  pool.subscribeMany(dmRelays, { kinds: [1059], '#p': [pubkey] }, {
    onevent: handleIncomingWrap,
    onclose: (reasons) => console.log('[chat] subscription closed:', reasons),
  });

  // Backgrounded tabs get their JS timers throttled by the browser, which
  // can silently stall the subscription's WebSocket (and even the ping/
  // reconnect logic meant to fix that, since it also runs on a timer). The
  // fix isn't a better timer — it's re-checking as soon as the tab is
  // visible again, which `visibilitychange` reports reliably regardless of
  // throttling.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    loadHistory().catch(err => console.log('[chat] refetch on focus failed:', err));
  });

  statusEl.textContent = 'Connected — say hello!';
  inputEl.disabled = false;
  sendBtn.disabled = false;
  inputEl.focus();

  if (petId) {
    await send(`Someone opened a chat about ${petName || 'a listing'}: ${location.origin}/pet?id=${petId}`);
  }
}
