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
    '.chat-box{display:flex;flex-direction:column;height:420px;border:1px solid var(--border,#ddd);border-radius:var(--radius,8px);background:var(--white,#fff);overflow:hidden;}',
    '.chat-messages{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:0.6rem;}',
    '.chat-bubble{max-width:80%;padding:0.55rem 0.85rem;border-radius:14px;font-size:0.9rem;line-height:1.4;word-wrap:break-word;white-space:pre-wrap;}',
    '.chat-bubble.sent{align-self:flex-end;background:var(--orange,#f7931a);color:#fff;border-bottom-right-radius:4px;}',
    '.chat-bubble.recv{align-self:flex-start;background:var(--light-gray,#f0f0f0);color:var(--dark,#1a1a1a);border-bottom-left-radius:4px;}',
    '.chat-status{font-size:0.8rem;color:#999;text-align:center;padding:0.5rem;}',
    '.chat-input-row{display:flex;border-top:1px solid var(--border,#ddd);}',
    '.chat-input-row input{flex:1;border:none;padding:0.75rem;font-size:0.9rem;font-family:inherit;outline:none;}',
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
  const { generateSecretKey, getPublicKey, finalizeEvent, nip17, SimplePool } = nostrTools;

  let skHex = localStorage.getItem('bp_nostr_sk');
  if (!skHex) {
    skHex = bytesToHex(generateSecretKey());
    localStorage.setItem('bp_nostr_sk', skHex);
  }
  const skBytes = hexToBytes(skHex);
  const pubkey = getPublicKey(skBytes);

  function addBubble(text, kind) {
    if (statusEl && statusEl.parentNode) statusEl.remove();
    const el = document.createElement('div');
    el.className = 'chat-bubble ' + kind;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  const pool = new SimplePool();

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
  } catch {
    // Discovery is best-effort; fall back to the default relay list.
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
    pool.publish(dmRelays, ownDmList);
  } catch {
    // Non-fatal — worst case the owner's client falls back to its own relays.
  }

  async function send(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const wrap = nip17.wrapEvent(skBytes, { publicKey: OWNER_PUBKEY_HEX, relayUrl: RELAYS[0] }, trimmed);
    await Promise.allSettled(pool.publish(dmRelays, wrap));
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

  pool.subscribeMany(dmRelays, { kinds: [1059], '#p': [pubkey] }, {
    onevent: (event) => {
      try {
        const rumor = nip17.unwrapEvent(event, skBytes);
        if (rumor.pubkey === OWNER_PUBKEY_HEX) addBubble(rumor.content, 'recv');
      } catch {
        // Not a valid gift wrap for us — ignore.
      }
    },
  });

  statusEl.textContent = 'Connected — say hello!';
  inputEl.disabled = false;
  sendBtn.disabled = false;
  inputEl.focus();

  if (petId) {
    await send(`Someone opened a chat about ${petName || 'a listing'}: ${location.origin}/pet?id=${petId}`);
  }
}
