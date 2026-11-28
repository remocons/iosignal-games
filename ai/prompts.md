# AI로 IOSignal 게임 만들기: 프롬프트 예제

AI 도우미(Claude, ChatGPT, Copilot, Cursor 등)에게 IOSignal 멀티플레이 게임을 만들게 할 때 쓰는 프롬프트 모음입니다. 모든 예제는 맥락 파일 [`iosignal-game.md`](./iosignal-game.md)를 함께 준다고 가정합니다. 이 파일에 규칙, 정확한 API, 시험된 폴더 구조가 들어 있어서 AI가 API를 지어내지 않습니다.

## 준비

1. 시작점을 받습니다. 가장 작은 게임 `iosignal_star-chase`(약 220줄)를 복사해 고치는 것이 가장 빠릅니다. `game-kit/` 폴더도 옆에 함께 둡니다.
   ```sh
   git clone https://github.com/remocons/iosignal-games.git
   cp -R iosignal-games/iosignal_star-chase iosignal-games/my-game
   cd iosignal-games/my-game && npm install && npm test
   ```
2. AI에게 맥락 파일을 줍니다.
   - **코딩 에이전트(Claude Code, Cursor, Copilot 등):** `ai/iosignal-game.md`가 저장소 안에 있으므로 프롬프트에서 경로를 가리키면 됩니다. 계속 쓸 프로젝트라면 그 도구의 프로젝트 지침 파일(예: `CLAUDE.md`, `AGENTS.md`, `.cursor/rules`)에 "IOSignal 게임 작업 전에 `ai/iosignal-game.md`를 읽는다"를 적어 둡니다.
   - **채팅(웹):** 파일을 첨부하거나 내용을 붙여 넣습니다. 원본 주소: https://raw.githubusercontent.com/remocons/iosignal-games/main/ai/iosignal-game.md
3. 한 번에 다 만들게 하지 말고 **설계 → 규칙과 시험 → 서버 → 화면** 순서로 나눠 확인합니다. 아래 예제도 그렇게 나뉘어 있습니다.

## 1. 새 게임 만들기

**1단계: 설계만 받기**

```text
ai/iosignal-game.md를 읽고 그 규칙을 지켜 줘.
휴대폰 2~8명이 같은 화면에서 하는 "풍선 터뜨리기" 게임을 IOSignal로 만들 거야.
- 화면 가운데 풍선이 무작위로 나타나고, 먼저 누른 사람이 점수를 얻는다
- 한 판 60초, 끝나면 1~3등을 보여 주고 새 판
- 큰 화면(?watch)에는 전체 판과 순위, 휴대폰에는 내 점수와 누르는 화면

코드는 아직 쓰지 말고 다음만 제안해 줘:
1. 태그 표 (태그, 방향, 형식, 주기, own/inbound)
2. 입력 명령 목록 (OP와 인자, 검사 규칙)
3. 스냅샷 형식 (배열과 자리 상수)
4. game.mjs의 공개 메서드와 이벤트
5. 서버가 판정해야 하는 것과 화면이 그리기만 하는 것의 구분
```

**2단계: 규칙과 시험**

```text
설계대로 iosignal_star-chase를 복사한 my-game 폴더에서 시작해.
먼저 public/shared.js(TAGS, RULES, 입력 파서)와 src/game.mjs(네트워크 없는 규칙)만 만들고,
test/game.test.mjs에 시험을 써 줘: 입장, 점수, 동시에 누른 경우 먼저 온 입력만 인정, 판 종료와 초기화,
잘못된 입력 무시, 시간 초과 퇴장. random과 now는 인자로 받아서 시험이 항상 같은 결과가 나오게 해.
npm test가 통과할 때까지 고쳐.
```

**3단계: 서버와 호스트**

```text
이제 src/my-game-server.mjs와 server.mjs를 star-chase 구조 그대로 고쳐 줘.
server.host의 inbound/own은 설계한 태그 표와 정확히 같아야 해.
test/smoke.test.mjs에 실제 소켓 시험을 써 줘: 클라이언트 두 개가 입장하고, 한 명이 점수를 얻고,
클라이언트가 보낸 가짜 상태 태그는 다른 클라이언트에 오지 않고 hostDenied가 늘어나는 것까지.
```

**4단계: 화면**

```text
public/index.html(필요하면 app.js로 나눠도 돼)을 만들어 줘.
- 휴대폰: 큰 터치 영역, 내 점수, 입장 폼. 입력은 바뀔 때만 보내고 3초마다 하트비트
- ?watch: 전체 판, 순위, 게임 키트의 data-iok="card"로 QR 참여 카드
- 상단에 게임 키트 배지, 연결 상태, 참여 버튼 (ai/iosignal-game.md 7절)
- 연결이 끊겼다 붙으면 ready에서 다시 구독하고 다시 입장
- 스냅샷 사이를 보간해서 부드럽게 그리고, requestAnimationFrame은 그리기 함수 맨 앞에서 불러
끝나면 내가 확인할 방법(주소, 창 두 개로 해 볼 것)을 알려 줘.
```

## 2. 지금 있는 싱글 게임을 멀티플레이로

```text
ai/iosignal-game.md를 읽어 줘. 내 게임은 src/의 브라우저 싱글 게임(캔버스, 키보드 조작)이야.
이걸 IOSignal 멀티플레이로 바꾸고 싶어. 코드를 고치기 전에:
1. 지금 게임 상태 중 서버(호스트)가 가져야 할 것과 각 화면에만 있으면 되는 것(효과, 카메라, 소리)을 나눠 줘
2. 키 입력을 어떤 입력 명령으로 바꿀지 정해 줘
3. 게임 루프를 서버의 host.loop로 옮길 때 바뀌는 점(시간, 난수, 여러 명)을 정리해 줘
내가 확인하면 iosignal_star-chase 구조에 맞춰 규칙을 src/game.mjs로 옮기는 것부터 해.
```

## 3. 휴대폰 컨트롤러 + 큰 화면

```text
지금 게임에 "큰 화면 하나 + 휴대폰 컨트롤러" 모드를 더해 줘.
- 주소에 ?watch가 있으면 큰 화면: 전체 판, 순위, 소식, QR 카드(data-iok="card")
- 휴대폰은 판을 그리지 않고 조이스틱과 버튼만, 대신 내 상태(점수, 남은 시간)는 @<game>.you로 받는다
- 조이스틱은 각도와 세기를 정수로 줄여서 값이 바뀔 때만 보내 (예: "S,<각도 0-359>,<세기 0-9>")
태그를 더하면 호스트의 own에도 넣고 시험에 추가해.
```

## 4. 아두이노 버튼 컨트롤러 붙이기

```text
ai/iosignal-game.md의 5절(Arduino)과 iosignal_arena-game/arduino/ 스케치를 참고해서
ESP32-C3 버튼 4개짜리 컨트롤러로 이 게임에 참가하게 해 줘.
- 서버: new Server에 congPort를 열고, 입장 명령에 종류(web|ard)를 받아 명단에 넣어
- 아두이노에는 큰 스냅샷을 보내지 말고 host.to로 짧은 TEXT 피드백만 (예: "hit", "win")
- 스케치의 WIFI_SSID, WIFI_PASS, SERVER_HOST는 자리표시자로 두고 README에 바꾸는 법을 적어
- 게임 키트의 setRoster에 'ard'를 넘겨서 연결 칩에 🔌 수가 나오게
```

## 5. 봇

```text
사람이 1명일 때만 봇 2대가 들어오고 2명 이상이면 봇이 나가게 해 줘.
봇은 src/game.mjs 안에서 사람과 같은 입력 함수를 거쳐 움직이게 하고(서버 밖에서 따로 접속하지 않게),
화면에서는 회색 톤과 🤖 이름표로 사람과 구분해. 순위에서도 흐리게.
봇 수 규칙을 시험으로 확인해: 0명→0대, 1명→2대, 2명→0대, 다시 1명→2대.
```

## 6. 문제가 생겼을 때

```text
ai/iosignal-game.md 9절을 기준으로 이 게임을 점검해 줘.
증상: 휴대폰 여러 대가 들어오면 가끔 입력이 무시되고 움직임이 끊긴다.
확인할 것: 입력을 보내는 빈도(변할 때와 몇 초마다 한 번), 스냅샷 크기와 주기, 구독을 ready마다 다시 하는지,
재접속 뒤 다시 입장하는지, 호스트 처리 시간(host.loop, 대시보드).
원인 후보를 근거(코드 줄)와 함께 먼저 보여 주고, 고치기 전에 확인받아.
```

```text
서버 대시보드를 켜서(new Server({ ..., dashboard: true })) 틱 간격과 초당 입력, 위조 차단을 볼 수 있게 하고,
host.report로 게임 정보(참가자 수, 1등, 남은 시간)를 보여 줘. 끄는 환경 변수(DASHBOARD=off)도 만들어.
```

## 7. 검토 받기

```text
ai/iosignal-game.md 2절의 MUST 규칙 8개를 기준으로 이 저장소를 검토해 줘.
규칙마다 지키는지, 어기는 곳이 있으면 파일과 줄, 고칠 방법을 표로. 코드는 아직 고치지 마.
특히: 클라이언트가 위치나 점수를 보내는 곳, payload의 id를 믿는 곳, own에 빠진 출력 태그,
requestAnimationFrame마다 보내는 입력.
```

## 프롬프트를 잘 쓰는 요령

- **설계를 먼저 받고 확인합니다.** 태그 표가 정해지면 나머지는 거의 따라옵니다.
- **시험을 요구합니다.** "npm test가 통과할 때까지"와 "위조 태그가 막히는 시험"을 꼭 넣습니다.
- **확인 방법을 묻습니다.** AI가 "됐다"고 하면 창 두 개(또는 휴대폰 하나와 PC)로 직접 해 봅니다.
- **한 번에 한 기능.** 봇, 아두이노, 큰 화면은 기본 게임이 돌아간 뒤에 하나씩 더합니다.
- **버전을 적어 둡니다.** 맥락 파일은 `iosignal` 10.3.0 기준입니다. 다른 버전이면 프롬프트에 버전을 쓰고, AI에게 설치된 패키지의 타입과 소스를 확인하라고 합니다.
