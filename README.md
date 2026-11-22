# IOSignal Games

[IOSignal](https://iosignal.net)로 만든 **멀티유저 네트워크 게임** 예제 모음입니다. 큰 화면 하나를 띄워 두고, 참가자는 각자의 스마트폰으로 QR 코드를 찍어 들어옵니다. 앱 설치는 필요 없습니다. 일부 게임은 아두이노 버튼 컨트롤러로도 함께 할 수 있습니다.

자기 게임에 IOSignal을 붙이려는 개발자가 그대로 읽고 고쳐 쓸 수 있도록, 모든 게임을 같은 구조로 만들었습니다. AI 도우미로 만들 때 쓰는 맥락 파일과 프롬프트 예제도 함께 있습니다.

| 게임 | 내용 | 참가 기기 | IOSignal에서 볼 것 | 바로 해 보기 |
|---|---|---|---|---|
| [Star Chase](./iosignal_star-chase/README.md) | 별 먼저 먹기 (약 220줄) | 브라우저, 스마트폰 | **자기 게임의 시작점.** 판정·위조 차단·보관 태그·한 사람에게 보내기·재접속의 최소 형태 | 로컬에서 `npm start` |
| [Arena](./iosignal_arena-game/README.md) | 미로 코인 술래잡기 | 브라우저, 스마트폰, ESP32-C3 버튼 컨트롤러 | 아두이노 TCP 연결, 장치 하나에만 보내는 피드백(`@fx`), 변화 즉시 + 15Hz 스냅샷 | [lab.iosignal.net/games/arena/](https://lab.iosignal.net/games/arena/) |
| [범퍼카](./iosignal_bumper-cars/README.md) | 부딪치면 점수 나는 범퍼카 | 스마트폰(조이스틱), PC | 서버 안의 30Hz 물리 루프(`host.loop`), 봇, 한 스텝의 이벤트를 메시지 하나로 | [lab.iosignal.net/games/bumper-cars/](https://lab.iosignal.net/games/bumper-cars/) |
| [동물원 생존하기](./iosignal_zoo-survival/README.md) | 아이소메트릭 복셀 탈출 게임 | 스마트폰, PC, ESP8266(D1 mini) 컨트롤러 | 보관 태그(`$roster`)로 늦게 온 화면도 바로 명단 받기, 아두이노 OLED 피드백 | [lab.iosignal.net/games/zoo-survival/](https://lab.iosignal.net/games/zoo-survival/) |

## 빠른 시작

Node.js 22.16 이상이 필요합니다.

```sh
git clone https://github.com/remocons/iosignal-games.git
cd iosignal-games/iosignal_bumper-cars
npm ci
npm start
```

터미널에 나오는 주소를 PC에서 `?watch`를 붙여 열면 큰 화면이 되고, 옆에 나오는 QR 코드를 같은 Wi-Fi의 스마트폰으로 찍으면 참가합니다. 혼자 시험할 때는 다른 터미널에서 `npm run bots`(Arena, 동물원)로 봇을 넣습니다.

## 게임 하나의 구조

모든 게임이 같은 방식으로 나뉘어 있습니다. 새 게임을 만들 때 이 틀을 따르면 됩니다.

```
 스마트폰·PC 브라우저 ── WebSocket /ws ──┐
 아두이노 컨트롤러 ───── TCP ────────────┤
                                         IOSignal Server (한 Node.js 프로세스, HTTP와 같은 포트)
                                          └─ server.host('<game>')  ← 판정은 여기서만
                                               <game>#in      클라이언트 → 호스트: 입력 "OP,args" (보낸 CID는 서버가 알려 줌)
                                               <game>#state   호스트 → 모두: 스냅샷 (주기적으로)
                                               <game>#$roster 호스트 → 모두: 명단 ('$'라서 서버가 보관)
                                               <game>#evt     호스트 → 모두: 충돌·점수 같은 이벤트
                                               @fx            호스트 → 장치 하나: 피드백
```

| 파일 | 역할 |
|---|---|
| `src/game.mjs` | 게임 규칙. 네트워크를 모르는 순수 로직이라 단위 시험이 쉽습니다 |
| `src/*-server.mjs` | HTTP 정적 서버 + IOSignal `Server` + `server.host()`. 입력을 규칙에 넘기고 결과를 방송합니다 |
| `public/shared.js` (Arena는 `protocol.js`) | 서버와 브라우저가 함께 쓰는 태그, 수치, 입력 형식 |
| `public/app.js` | 화면: 연결, 보간, 그리기, 조작, 소리 |
| `test/` | 규칙 단위 시험, 실제 소켓으로 접속하는 시험(입력·출력 위조가 막히는지 포함) |

핵심은 **클라이언트는 입력만 보내고, 판정은 서버 안의 호스트가 한다**는 점입니다. 호스트는 입력마다 서버가 확인한 보낸 사람(`from.cid`)을 받고, 출력 태그(`own`)는 호스트만 보낼 수 있어서 클라이언트가 점수나 상태를 위조할 수 없습니다. 자세한 설명은 [게임 시작하기](https://docs.iosignal.net/docs/game) 문서에 있습니다.

## AI로 만들기 (`ai/`)

AI 도우미로 자기 게임을 만들 때 쓰는 자료입니다. [ai/README.md](./ai/README.md)

- [`ai/iosignal-game.md`](./ai/iosignal-game.md): AI에게 통째로 주는 맥락 파일. 규칙, 정확한 API, 폴더 구조, 시험 방법, 흔한 실수
- [`ai/prompts.md`](./ai/prompts.md): 단계별 프롬프트 예제(새 게임, 싱글 게임을 멀티로, 휴대폰 컨트롤러, 아두이노, 봇, 문제 해결, 검토)
- 시작점은 `iosignal_star-chase`를 복사하는 것입니다.

## 게임 키트 (`game-kit/`)

모든 게임이 같은 모양으로 쓰는 공통 요소입니다: 상단의 IOSignal 배지, 연결 상태(서버 왕복 시간, 참가자 수), 📱 참여 버튼(QR 코드, 주소, 공유), 큰 화면용 QR 카드. 게임은 `../../game-kit/server.mjs`로 불러오므로, **게임 폴더 하나만 복사할 때는 `game-kit/`도 그 옆에 함께 두세요.** 사용법은 [game-kit/README.md](./game-kit/README.md).

## 더 보기

- [IOSignal 문서](https://docs.iosignal.net) · [게임 시작하기](https://docs.iosignal.net/docs/game)
- [iosignal-examples](https://github.com/remocons/iosignal-examples): 채팅, WebRTC, 서버가 채점하는 퀴즈(Host Quiz)
- [IOSignal Arduino 라이브러리](https://github.com/remocons/iosignal-arduino)

## 라이선스

MIT
