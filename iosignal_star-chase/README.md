# Star Chase — 가장 작은 IOSignal 멀티플레이 게임

별(⭐)에 먼저 닿으면 1점. 규칙은 단순하지만 IOSignal 멀티플레이 게임에 필요한 것이 모두 들어 있습니다: 서버 안의 판정(`server.host()`), 보낸 사람 확인(`from.cid`), 위조 차단(`own`), 보관 태그(`$roster`), 한 사람에게만 보내기(`host.to`), 재접속, 시간 초과, 게임 키트(QR 참여). 전체 약 220줄이라 **자기 게임의 시작점**으로 복사해 쓰기 좋습니다. AI로 만들 때는 [AI 자료](../ai/)를 함께 보세요.

## 실행

Node.js 22.16 이상이 필요합니다. `game-kit/` 폴더가 이 폴더 옆에 있어야 합니다.

```sh
npm install
npm start
```

`http://localhost:5201`을 창 두 개 이상에서 열고 닉네임으로 입장합니다. 같은 Wi-Fi의 휴대폰은 📱 참여하기의 QR 코드로 들어옵니다. 방향키나 화면의 버튼으로 움직입니다. 포트는 `PORT=6000 npm start`.

## 구조

| 파일 | 줄 | 역할 |
|---|---|---|
| `public/shared.js` | 13 | 태그, 수치, 입력 파서. 서버와 브라우저가 함께 씀 |
| `src/game.mjs` | 44 | 규칙(네트워크 없음): 입장, 이동, 점수, 퇴장, 시간 초과, 명단·스냅샷 |
| `src/star-server.mjs` | 65 | HTTP + IOSignal `Server` + `server.host('star')` + 게임 키트 |
| `server.mjs` | 19 | 실행 진입점 |
| `public/index.html` | 80 | 화면: 연결, 입장, 입력, 그리기 |
| `test/` | | 규칙 시험, 실제 소켓 두 개로 점수와 위조 차단 시험 |

| 태그 | 방향 | 내용 |
|---|---|---|
| `star#in` | 클라이언트 → 호스트 | TEXT `J,<이름>` 입장, `M,<dx>,<dy>` 한 칸 이동, `H` 하트비트 |
| `star#state` | 호스트 → 모두 | `{ s: [별x, 별y], p: [[cid, x, y, 점수], …] }`, 10Hz |
| `star#$roster` | 호스트 → 모두 | `{ p: [[cid, 이름], …] }`, 바뀔 때만. 서버가 보관 |
| `@star.you` | 호스트 → 한 명 | `{ got: true, score }` 별을 먹었을 때 |

## 고쳐 쓰는 순서

1. `public/shared.js`의 태그 이름(`star` → 내 게임 이름)과 입력 명령을 정합니다.
2. `src/game.mjs`에 규칙을 쓰고 `test/game.test.mjs`로 시험합니다.
3. `src/star-server.mjs`의 `server.host()` `inbound`/`own`을 태그와 맞춥니다.
4. `public/index.html`의 그리기와 조작을 바꿉니다.
5. `npm test`(소켓 시험 포함)와 창 두 개로 확인합니다.
