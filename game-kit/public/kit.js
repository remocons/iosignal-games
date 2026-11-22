// IOSignal game kit, browser side. The same brand, connection status and "join with your phone"
// parts in every game. A page puts placeholders where it wants them and calls mountGameKit():
//
//   <a data-iok="brand"></a>            IOSignal badge, links to iosignal.net
//   <span data-iok="net"></span>        connection: state, round trip to the server, players by device
//   <button data-iok="join"></button>   opens the join dialog: QR code, address, copy, share
//   <div data-iok="card"></div>         a QR card for the big screen (?watch)
//
//   const kit = mountGameKit({ io, title: '범퍼카' });
//   kit.setRoster(['web', 'ard', 'bot', ...]);   // each player's kind, from the game's roster
//
// The server side (game-kit/server.mjs) serves 'join' (address JSON), 'qr.svg' and 'kit/*',
// relative to the page, so it works under a proxy sub path too.

const SITE = 'https://iosignal.net';
const PING_MS = 4000;

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) el.append(kid);
  return el;
};
const shortUrl = (url) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

function loadCss() {
  if (document.querySelector('link[data-iok-css]')) return;
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('kit.css', import.meta.url).href, 'data-iok-css': '' }));
}

/**
 * io: the page's IOSignal client (or call kit.attach(io) later). title: the game's name.
 * watch: false hides the "big screen" link in the join dialog.
 */
export function mountGameKit({ io = null, title = document.title, watch = true } = {}) {
  loadCss();
  const fallbackUrl = location.href.replace(/[?#].*$/, '');
  let join = { url: fallbackUrl, lan: !location.protocol.startsWith('https'), title };
  const joinReady = fetch('join', { cache: 'no-store' }).then((r) => r.json())
    .then((j) => { if (j?.url) join = j; }).catch(() => {});

  const people = { web: 0, ard: 0, bot: 0 };
  let rtt = null;
  let client = null;

  // ------------------------------------------------ brand badge
  for (const el of document.querySelectorAll('[data-iok="brand"]')) {
    el.classList.add('iok-brand');
    if (el.tagName === 'A') { el.href = SITE; el.target = '_blank'; el.rel = 'noopener'; }
    el.title = 'IOSignal로 만든 실시간 네트워크 멀티플레이 게임';
    el.textContent = 'IOSignal';
  }

  // ------------------------------------------------ connection chip
  const nets = [...document.querySelectorAll('[data-iok="net"]')];
  for (const el of nets) el.classList.add('iok-net');
  function renderNet() {
    const state = client?.stateName ?? 'connecting';
    const label = state === 'ready' ? '온라인' : state === 'closed' ? '연결 끊김' : '연결 중';
    const n = people.web + people.ard;
    const tip = [`IOSignal 서버: ${label}`];
    if (rtt != null && state === 'ready') tip.push(`왕복 ${Math.round(rtt)} ms`);
    tip.push(`참가자 ${n}명` + (people.ard ? ` (아두이노 ${people.ard})` : '') + (people.bot ? `, 봇 ${people.bot}` : ''));
    if (client?.cid) tip.push(`내 CID ${client.cid}`);
    for (const el of nets) {
      el.dataset.state = state;
      el.title = tip.join(' · ');
      const kids = [
        h('i', { class: 'iok-dot' }),
        h('span', { class: 'iok-state', text: label }),
        h('span', { class: 'iok-people', text: `👥 ${n}` }),
      ];
      if (state === 'ready' && rtt != null) kids.splice(2, 0, h('span', { class: 'iok-rtt', text: `${Math.round(rtt)}ms` }));
      if (people.ard) kids.push(h('span', { class: 'iok-ard', text: `🔌 ${people.ard}` }));
      el.replaceChildren(...kids);
    }
  }

  function attach(next) {
    client = next;
    if (!client) return;
    client.on('change', renderNet);
    client.on('ready', () => { rtt = null; measure(); renderNet(); });
    renderNet();
  }
  function measure() {
    if (client?.stateName !== 'ready' || typeof client.pingServer !== 'function') return;
    client.pingServer().then((ms) => { rtt = ms; renderNet(); }).catch(() => {});
  }
  setInterval(measure, PING_MS);

  // ------------------------------------------------ join dialog
  let dialog = null;
  function buildDialog() {
    const url = h('code', { class: 'iok-url' });
    const note = h('p', { class: 'iok-note' });
    const copyBtn = h('button', { type: 'button', text: '주소 복사' });
    const shareBtn = h('button', { type: 'button', class: 'iok-primary', text: '공유하기' });
    const watchLink = watch ? h('a', { class: 'iok-watch', target: '_blank', rel: 'noopener', text: '🖥 큰 화면으로 열기' }) : null;
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(join.url); copyBtn.textContent = '복사했어요'; }
      catch { getSelection()?.selectAllChildren(url); copyBtn.textContent = '선택했어요'; }
      setTimeout(() => { copyBtn.textContent = '주소 복사'; }, 1500);
    });
    shareBtn.addEventListener('click', async () => {
      try { await navigator.share({ title: join.title || title, text: `${join.title || title} — 같이 해요! (IOSignal 멀티플레이 게임)`, url: join.url }); }
      catch { /* cancelled */ }
    });
    if (!navigator.share) shareBtn.hidden = true;

    dialog = h('dialog', { class: 'iok-dialog', 'aria-label': '스마트폰으로 참여하기' },
      h('button', { type: 'button', class: 'iok-close', 'aria-label': '닫기', text: '✕', onclick: () => dialog.close() }),
      h('h2', { text: '📱 스마트폰으로 함께하기' }),
      h('p', { class: 'iok-lead', text: `이 게임은 IOSignal 서버로 연결된 네트워크 멀티플레이 게임입니다. QR 코드를 찍거나 주소를 열면 바로 같은 판에 들어옵니다.` }),
      h('img', { class: 'iok-qr', alt: '참여 주소 QR 코드', width: '220', height: '220' }),
      url, note,
      h('div', { class: 'iok-actions' }, copyBtn, shareBtn),
      watchLink,
      h('a', { class: 'iok-powered', href: SITE, target: '_blank', rel: 'noopener' },
        'Powered by ', h('b', { text: 'IOSignal' })),
    );
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // backdrop
    document.body.append(dialog);
    dialog.fill = () => {
      dialog.querySelector('.iok-qr').src = `qr.svg?t=${Date.now()}`;
      url.textContent = shortUrl(join.url);
      note.textContent = join.lan
        ? '같은 Wi-Fi(공유기)에 연결된 스마트폰에서 열 수 있습니다.'
        : '어디서나 스마트폰 브라우저로 열 수 있습니다. 앱 설치는 필요 없습니다.';
      if (watchLink) watchLink.href = `${join.url}${join.url.includes('?') ? '&' : '?'}watch`;
    };
  }
  async function openJoin() {
    if (!dialog) buildDialog();
    await joinReady;
    dialog.fill();
    dialog.showModal();
  }
  for (const el of document.querySelectorAll('[data-iok="join"]')) {
    el.classList.add('iok-join');
    el.type = 'button';
    el.title = '스마트폰으로 참여하기 (QR 코드)';
    el.replaceChildren(h('span', { text: '📱' }), h('span', { class: 'iok-join-text', text: '참여하기' }));
    el.addEventListener('click', openJoin);
  }

  // ------------------------------------------------ big-screen card
  const cards = [...document.querySelectorAll('[data-iok="card"]')];
  function renderCards() {
    for (const el of cards) {
      el.classList.add('iok-card');
      el.replaceChildren(
        h('div', { class: 'iok-card-head', text: 'IOSignal 멀티플레이' }),
        h('img', { class: 'iok-qr', src: `qr.svg?t=${Date.now()}`, alt: '스마트폰 접속 QR 코드', width: '200', height: '200' }),
        h('p', { class: 'iok-cta', text: '📱 스캔해서 참여' }),
        h('code', { class: 'iok-url', text: shortUrl(join.url) }),
        h('p', { class: 'iok-note', text: join.lan ? '같은 Wi-Fi의 스마트폰으로' : '스마트폰 브라우저로, 설치 없이' }),
      );
    }
  }
  if (cards.length) { renderCards(); joinReady.then(renderCards); }

  if (io) attach(io); else renderNet();

  return {
    attach,
    /** kinds: each player's kind ('web' | 'ard' | 'bot'), from the game's roster. */
    setRoster(kinds) {
      people.web = 0; people.ard = 0; people.bot = 0;
      for (const k of kinds) people[k === 'ard' || k === 'bot' ? k : 'web']++;
      renderNet();
    },
    openJoin,
    /** Re-render the big-screen card (e.g. after it was shown again). */
    refreshCard: renderCards,
  };
}
