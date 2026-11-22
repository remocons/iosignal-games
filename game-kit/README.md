# IOSignal 게임 키트

모든 게임이 같은 모양으로 보여 주는 공통 요소입니다. 일반 웹게임과 달리 **IOSignal로 연결된 네트워크 멀티플레이**이고 **스마트폰으로 바로 참여**할 수 있다는 점을 화면마다 같은 자리에서 알립니다.

| 요소 | 자리 | 내용 |
|---|---|---|
| 브랜드 배지 `data-iok="brand"` | 상단 바 맨 앞 | 글자 "IOSignal"(로고 그림은 쓰지 않음), iosignal.net 링크 |
| 연결 칩 `data-iok="net"` | 상단 바 | 연결 상태, 서버까지 왕복 시간(`io.pingServer()`, 4초마다), 참가자 수(👥), 아두이노 수(🔌). 마우스를 올리면 자세히(봇 수, 내 CID) |
| 참여 버튼 `data-iok="join"` | 상단 바 | 누르면 참여 창: QR 코드, 주소, 주소 복사, 공유하기(Web Share, 휴대폰), 큰 화면으로 열기 |
| 큰 화면 카드 `data-iok="card"` | 관전 화면(`?watch`) 옆 패널 | QR 코드, "스캔해서 참여", 주소 |
| 시작 화면 머리글 `.iok-kicker` | 게임 제목 위 | "IOSignal 실시간 멀티플레이" |

폭 560px 이하(휴대폰)에서는 연결 칩은 점·왕복 시간·인원만, 참여 버튼은 📱만 보입니다.

## 쓰는 법

서버(`src/*-server.mjs`):

```js
import QRCode from 'qrcode';
import { createGameKit } from '../../game-kit/server.mjs';

const kit = createGameKit({ title: '범퍼카', port: () => httpServer.address().port, publicUrl, QRCode });
// HTTP 핸들러에서, 정적 파일보다 먼저
if (await kit.handle(pathname, res)) return; // /join, /qr.svg, /kit/*
```

- `/join`: `{ url, lan, title }`. `url`은 `publicUrl`(프록시 뒤, 예: `https://lab.iosignal.net/games/<이름>/`)이 있으면 그것, 없으면 이 PC의 LAN 주소입니다. `lan`이면 참여 창에 "같은 Wi-Fi" 안내가 나옵니다.
- `/qr.svg`: 그 주소의 QR 코드. `qrcode` 패키지는 게임이 넘겨 줍니다(키트 자체는 의존성 없음).
- `/kit/*`: `public/`의 `kit.js`, `kit.css`.

페이지(`public/index.html`):

```html
<link rel="stylesheet" href="kit/kit.css">
…
<header>
  <a data-iok="brand"></a> <b>게임 이름</b> <span data-iok="net"></span> … <button data-iok="join"></button>
</header>
<aside><div data-iok="card"></div> …</aside>
```

```js
import { mountGameKit } from './kit/kit.js';
const kit = mountGameKit({ io, title: '범퍼카' }); // io를 나중에 만들면 kit.attach(io)
// 명단(roster)을 받을 때마다 각 참가자의 종류('web' | 'ard' | 'bot')
kit.setRoster(players.map((p) => p.kind));
```

모든 주소는 페이지 기준 상대 경로라 프록시 하위 경로(`/games/<이름>/`)에서도 그대로 동작합니다.

## 배치

게임은 `../../game-kit/server.mjs`로 이 폴더를 불러옵니다. 게임 폴더 하나만 복사해 쓸 때는 `game-kit/` 폴더도 그 옆에 함께 둡니다.

## 다음 단계 후보

- 큰 화면 대기 화면(사람이 없을 때 큰 QR), 기기별 입장 알림(📱 스마트폰, 💻 PC, 🔌 아두이노). 입장 메시지에 기기 종류를 더해야 함
- "IOSignal 보기" 오버레이: 입력(`<game>#in`)과 상태(`<game>#state`)의 흐름, 초당 메시지 수, 위조 차단 횟수
- 라운드 끝 화면의 "어떻게 만들었나" 카드, lab.iosignal.net/games/ 모음 페이지
