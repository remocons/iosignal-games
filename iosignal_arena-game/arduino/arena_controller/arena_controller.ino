/*
  IOSignal Arena — ESP32-C3 Super Mini button controller

  A screenless game controller: watch the shared screen (http://<PC>:5178/?watch)
  and play with 4 direction buttons + 1 action button.
  Feedback from the game host arrives as a direct signal (tag "@fx") and is
  shown with the onboard LED and a passive buzzer.

  Wiring (every button between the GPIO and GND, internal pull-up is used)
    UP     GPIO3        DOWN   GPIO0
    LEFT   GPIO2        RIGHT  GPIO1
    ACTION GPIO5        (onboard BOOT button GPIO9 also works as ACTION)
    Passive buzzer  GPIO4 -> buzzer (+), buzzer (-) -> GND   (100 ohm in series recommended)
    LED             GPIO6 -> 330 ohm -> LED (+), LED (-) -> GND   (active HIGH)
  GPIO2 is a strapping pin: do not hold LEFT while powering on or resetting.

  Arduino IDE
    Board: "ESP32C3 Dev Module" (esp32 core 3.x), Tools > USB CDC On Boot: Enabled
    Libraries: IOSignal (>= 9.13.0), Boho, Crypto, Bounce2

  Protocol (TEXT, see public/protocol.js)
    send "arena#in"  "J,ard,<name>"   join
                     "D,<U|D|L|R|0>"  held direction (0 = released)
                     "A"              dash
                     "H"              heartbeat every 2 s
    recv "@fx"       join coin it free bump wall dash nodash near start end win
  The server tells the game host which connection sent each input, so the CID is not sent.
  Sketches made for the old "<cid>,J,..." format must be updated.
*/

#include <WiFi.h>
#include <IOSignal.h>
#include <Bounce2.h>
#include <string.h>

// ---------------- user settings ----------------
const char* WIFI_SSID   = "WIFI_SSID";
const char* WIFI_PASS   = "WIFI_PASS";
const char* SERVER_HOST = "192.168.0.10";  // PC running `npm start` (printed as "Arduino SERVER_HOST")
const uint16_t SERVER_PORT = 55488;        // CONG_PORT of the arena server
const char* PLAYER_NAME = "";              // empty -> "esp-XXXX" from the MAC address

// ---------------- pins ----------------
const uint8_t PIN_UP = 3, PIN_DOWN = 0, PIN_LEFT = 2, PIN_RIGHT = 1;
const uint8_t PIN_ACTION = 5, PIN_BOOT = 9;
const uint8_t PIN_BUZZER = 4;
const uint8_t PIN_LED = 6;
const bool LED_ACTIVE_LOW = false;  // external LED to GND. Use true for the onboard GPIO8 LED

const char* TAG_IN = "arena#in";
const uint32_t HEARTBEAT_MS = 2000;

WiFiClient client;
IOSignal io;

Bounce2::Button btnDir[4];
const uint8_t DIR_PINS[4] = { PIN_UP, PIN_DOWN, PIN_LEFT, PIN_RIGHT };
const char DIR_CHARS[4] = { 'U', 'D', 'L', 'R' };
uint32_t pressedAt[4] = { 0, 0, 0, 0 };
Bounce2::Button btnAction, btnBoot;

char playerName[16];
char sentDir = '0';
bool joined = false;
bool isTagger = false;
uint32_t lastHeartbeat = 0;
uint32_t wifiRetry = 0;

// ================= feedback: non-blocking buzzer melody + LED pattern =================
struct Note { uint16_t freq; uint16_t ms; };  // freq 0 = rest

const Note M_JOIN[]   = { {523, 90}, {659, 90}, {784, 160} };
const Note M_COIN[]   = { {1976, 60}, {2637, 140} };
const Note M_IT[]     = { {880, 150}, {440, 150}, {880, 150}, {440, 150}, {880, 220} };
const Note M_FREE[]   = { {523, 80}, {784, 160} };
const Note M_BUMP[]   = { {150, 70} };
const Note M_WALL[]   = { {100, 35} };
const Note M_DASH[]   = { {600, 25}, {900, 25}, {1200, 25}, {1600, 40} };
const Note M_NODASH[] = { {220, 50} };
const Note M_NEAR[]   = { {330, 35} };
const Note M_START[]  = { {392, 90}, {523, 90}, {659, 90}, {784, 200} };
const Note M_END[]    = { {784, 120}, {659, 120}, {523, 260} };
const Note M_WIN[]    = { {784, 110}, {659, 110}, {784, 110}, {1047, 400} };
const Note M_ONLINE[] = { {1047, 50}, {0, 40}, {1047, 50} };

const Note* melody = nullptr;
uint8_t melodyLen = 0, melodyIdx = 0;
uint32_t noteEndsAt = 0;

uint8_t blinkLeft = 0;  // remaining on/off toggles
uint16_t blinkMs = 0;
uint32_t blinkNextAt = 0;
bool blinkOn = false;

#define PLAY(m) play(m, sizeof(m) / sizeof(Note))

void play(const Note* m, uint8_t len) {
  melody = m; melodyLen = len; melodyIdx = 0; noteEndsAt = 0;
}

void blink(uint8_t times, uint16_t ms) {
  blinkLeft = times * 2; blinkMs = ms; blinkNextAt = 0;
}

void setLed(bool on) { digitalWrite(PIN_LED, on != LED_ACTIVE_LOW ? HIGH : LOW); }

void updateFeedback() {
  uint32_t now = millis();
  // melody
  if (melody && now >= noteEndsAt) {
    if (melodyIdx < melodyLen) {
      const Note& n = melody[melodyIdx++];
      if (n.freq) tone(PIN_BUZZER, n.freq); else noTone(PIN_BUZZER);
      noteEndsAt = now + n.ms;
    } else {
      noTone(PIN_BUZZER);
      melody = nullptr;
    }
  }
  // LED: blink pattern > tagger (solid on) > connection state
  if (blinkLeft && now >= blinkNextAt) {
    blinkOn = !blinkOn;
    blinkLeft--;
    blinkNextAt = now + blinkMs;
  }
  if (blinkLeft) setLed(isTagger ? !blinkOn : blinkOn);
  else if (isTagger) setLed(true);
  else if (io.state != IO_READY) setLed((now / 500) % 2);  // slow blink while offline
  else setLed(false);
}

void onFx(const char* fx) {
  if      (!strcmp(fx, "join"))   { PLAY(M_JOIN);   blink(2, 80); }
  else if (!strcmp(fx, "coin"))   { PLAY(M_COIN);   blink(1, 60); }
  else if (!strcmp(fx, "it"))     { PLAY(M_IT);     isTagger = true;  blink(4, 70); }
  else if (!strcmp(fx, "free"))   { PLAY(M_FREE);   isTagger = false; blink(2, 60); }
  else if (!strcmp(fx, "bump"))   { PLAY(M_BUMP);   blink(1, 40); }
  else if (!strcmp(fx, "wall"))   { PLAY(M_WALL); }
  else if (!strcmp(fx, "dash"))   { PLAY(M_DASH);   blink(1, 100); }
  else if (!strcmp(fx, "nodash")) { PLAY(M_NODASH); }
  else if (!strcmp(fx, "near"))   { PLAY(M_NEAR);   blink(1, 30); }
  else if (!strcmp(fx, "start"))  { PLAY(M_START);  isTagger = false; blink(3, 100); }
  else if (!strcmp(fx, "end"))    { PLAY(M_END);    isTagger = false; }
  else if (!strcmp(fx, "win"))    { PLAY(M_WIN);    isTagger = false; blink(6, 120); }
}

// ================= IOSignal =================
void sendInput(const char* op, const char* arg = nullptr) {
  if (io.state != IO_READY) return;
  char buf[48];
  if (arg) snprintf(buf, sizeof(buf), "%s,%s", op, arg);
  else     snprintf(buf, sizeof(buf), "%s", op);
  io.signal(TAG_IN, buf);  // TEXT payload -> string on the JS side
}

void onReady() {
  Serial.print("[io] ready cid=");
  Serial.println(io.cid);
  char arg[24];
  snprintf(arg, sizeof(arg), "ard,%s", playerName);
  sendInput("J", arg);  // a new CID after every reconnect -> join again
  joined = true;
  isTagger = false;
  sentDir = '0';
  lastHeartbeat = millis();
  PLAY(M_ONLINE);
}

void onMessage(char* tag, uint8_t type, uint8_t* payload, size_t size) {
  // Direct signals arrive without subscribing; the tag is "@fx".
  if (strcmp(tag, "@fx") != 0) return;
  if (type != IOSignal::PAYLOAD_TYPE::TEXT || !size || !memchr(payload, 0, size)) return;
  Serial.print("[fx] ");
  Serial.println((char*)payload);
  onFx((char*)payload);
}

// ================= buttons =================
void setupButton(Bounce2::Button& b, uint8_t pin) {
  b.attach(pin, INPUT_PULLUP);
  b.interval(10);
  b.setPressedState(LOW);
}

void updateButtons() {
  bool dirChanged = false;
  for (uint8_t i = 0; i < 4; i++) {
    btnDir[i].update();
    if (btnDir[i].pressed())  { pressedAt[i] = millis() | 1; dirChanged = true; }
    if (btnDir[i].released()) { pressedAt[i] = 0; dirChanged = true; }
  }
  if (dirChanged) {
    // the most recently pressed button that is still held wins
    char want = '0';
    uint32_t latest = 0;
    for (uint8_t i = 0; i < 4; i++) {
      if (pressedAt[i] && pressedAt[i] >= latest) { latest = pressedAt[i]; want = DIR_CHARS[i]; }
    }
    if (want != sentDir) {
      char arg[2] = { want, 0 };
      sendInput("D", arg);
      sentDir = want;
      Serial.print("[in] D ");
      Serial.println(want);
    }
  }
  btnAction.update();
  btnBoot.update();
  if (btnAction.pressed() || btnBoot.pressed()) {
    sendInput("A");
    Serial.println("[in] A");
  }
}

// ================= setup / loop =================
void setup() {
  Serial.begin(115200);
  pinMode(PIN_LED, OUTPUT);
  setLed(false);
  pinMode(PIN_BUZZER, OUTPUT);
  for (uint8_t i = 0; i < 4; i++) setupButton(btnDir[i], DIR_PINS[i]);
  setupButton(btnAction, PIN_ACTION);
  setupButton(btnBoot, PIN_BOOT);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  if (PLAYER_NAME[0]) {
    strncpy(playerName, PLAYER_NAME, 12);
    playerName[12] = 0;
  } else {
    uint8_t mac[6];
    WiFi.macAddress(mac);
    snprintf(playerName, sizeof(playerName), "esp-%02x%02x", mac[4], mac[5]);
  }
  Serial.print("\n[arena] player ");
  Serial.println(playerName);

  io.setRxBuffer(256);
  io.onReady(onReady);
  io.onMessage(onMessage);
  io.begin(&client, SERVER_HOST, SERVER_PORT);
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    io.loop();
  } else if (millis() - wifiRetry >= 10000) {
    wifiRetry = millis();
    WiFi.reconnect();
  }
  if (io.state != IO_READY) joined = false;

  updateButtons();
  updateFeedback();

  if (joined && millis() - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = millis();
    sendInput("H");
  }
}
