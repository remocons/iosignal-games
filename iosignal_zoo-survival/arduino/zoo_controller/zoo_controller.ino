/*
  동물원 생존하기 (Zoo Survival) — Remocon8266 board (D1 mini, ESP8266) controller

  Watch the whole map on a big screen (http://<PC>:5190/?watch) and play with the board:
    four direction buttons move along the map GRID, D6 jumps, D8 lays a mine.
    On the isometric screen (not turned) the grid runs diagonally:
      UP = up-right, RIGHT = down-right, DOWN = down-left, LEFT = up-left.
    Reach the glowing exit first to escape: everyone moves to the next area.
  Feedback from the game host arrives as a direct signal (tag "@fx") and is shown on the
  board's OLED and the onboard LED.

  Pins (the Remocon8266 board; see iosignal/examples/Remocon8266-basic in IOSignal Arduino for its schematic)
    UP     D0 (GPIO16)  board's SW1, external pull-up (GPIO16 has no internal one)
    LEFT   D3 (GPIO0)   board's SW2, internal pull-up   (do not hold it while powering on)
    DOWN   D5 (GPIO14)  board's SW3, internal pull-up
    RIGHT  D7 (GPIO13)  board's SW4, internal pull-up
    JUMP   D6 (GPIO12)  button to GND, internal pull-up
    MINE   D8 (GPIO15)  button to 3V3: GPIO15 has a pull-down on the D1 mini (it must be LOW
                        at boot), so this button reads HIGH when pressed. Not to GND.
    OLED   SSD1306 I2C on GPIO4 (SDA) / GPIO5 (SCL)
    LED    onboard LED on GPIO2, active LOW

  Arduino IDE / arduino-cli
    Board "LOLIN(WEMOS) D1 R2 & mini" (esp8266:esp8266:d1_mini)
    Libraries: IOSignal (>= 9.13.0), Boho, Crypto, Bounce2, U8g2

  Wi-Fi and the server: set WIFI_SSID, WIFI_PASS and SERVER_HOST below, or over USB on
  https://arduino.iosignal.net/wifi/ (the board keeps them). SERVER_HOST is the PC running
  `npm start` (it prints its LAN address); the port is 55490.

  Protocol (TEXT, see public/shared.js)
    send "zoo#in"  "J,ard,<name>"   join (again after every reconnect: a new CID)
                   "W,<gx>,<gy>"    held buttons as a map-grid direction, -100..100
                   "U"              jump        "B"  mine        "H"  heartbeat every 3 s
    recv "@fx"     join spawn jump mine nomine boom die near escape next stage
  The server tells the game host which connection sent each input, so the CID is not sent.
*/

#include <ESP8266WiFi.h>
#include <IOSignal.h>
#include <IOSignalConfig.h>
#include <Bounce2.h>
#include <U8g2lib.h>
#include <Wire.h>
#include <string.h>

const char* WIFI_SSID = "WIFI_SSID";
const char* WIFI_PASS = "WIFI_PASS";
const char* SERVER_HOST = "192.168.0.10";  // the PC running the game server
const uint16_t SERVER_PORT = 55490;
const char* TAG_IN = "zoo#in";

#define PIN_UP     16  // D0
#define PIN_LEFT    0  // D3
#define PIN_DOWN   14  // D5
#define PIN_RIGHT  13  // D7
#define PIN_JUMP   12  // D6, to GND
#define PIN_MINE   15  // D8, to 3V3 (active HIGH)
#define PIN_LED     2  // onboard, active LOW

WiFiClient client;
IOSignal io;
IOSignalConfig config;
IOSignalSetting playerName(config, "name", "Player name (empty: esp-xxxx)", "", IOSignalSetting::TEXT);
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, /* reset=*/U8X8_PIN_NONE);

Bounce bUp, bLeft, bDown, bRight, bJump, bMine;
int sentX = 0, sentY = 0;
unsigned long lastSend = 0, lastHeartbeat = 0, ledOffAt = 0, deadUntil = 0;
char name[16];
char lastFx[12] = "";
bool joined = false;

// ---------------------------------------------------------------- display
void show() {
  oled.clearBuffer();
  oled.setFont(u8g2_font_6x10_mr);
  oled.setFontPosTop();
  oled.setCursor(0, 0);
  oled.print("ZOO SURVIVAL");
  oled.setCursor(0, 14);
  if (!config.connected()) oled.print("Wi-Fi..");
  else if (io.state != IO_READY) oled.print("Connecting..");
  else { oled.print(name); oled.print(' '); oled.print(io.cid); }
  oled.setFont(u8g2_font_10x20_mr);
  oled.setCursor(0, 32);
  if (deadUntil && millis() < deadUntil) {
    oled.print("DEAD ");
    oled.print((deadUntil - millis()) / 1000 + 1);
  } else if (lastFx[0]) {
    oled.print(lastFx);
  } else if (joined) {
    oled.print("PLAY!");
  }
  oled.sendBuffer();
}

void blink(unsigned long ms) {
  digitalWrite(PIN_LED, LOW);
  ledOffAt = millis() + ms;
}

// ---------------------------------------------------------------- IOSignal
void sendInput(const char* text) {
  if (io.state == IO_READY) io.signal(TAG_IN, text);  // TEXT payload -> string on the JS side
}

void onReady() {
  Serial.print("[io] ready cid=");
  Serial.println(io.cid);
  char buf[32];
  snprintf(buf, sizeof(buf), "J,ard,%s", name);
  sendInput(buf);  // a new CID after every reconnect -> join again
  joined = true;
  sentX = sentY = 0;
  lastHeartbeat = millis();
  show();
}

void onMessage(char* tag, uint8_t type, uint8_t* payload, size_t size) {
  // Direct signals arrive without subscribing; the tag is "@fx".
  if (strcmp(tag, "@fx") != 0 || type != IOSignal::TEXT || !payload || !size || !memchr(payload, 0, size)) return;
  const char* fx = (const char*)payload;
  Serial.print("[fx] ");
  Serial.println(fx);
  if (!strcmp(fx, "die")) { deadUntil = millis() + 3000; strcpy(lastFx, "BOOM!"); blink(1500); }
  else if (!strcmp(fx, "spawn")) { deadUntil = 0; strcpy(lastFx, "GO!"); blink(300); }
  else if (!strcmp(fx, "boom")) { strcpy(lastFx, "HIT!"); blink(400); }
  else if (!strcmp(fx, "mine")) { strcpy(lastFx, "MINE"); blink(80); }
  else if (!strcmp(fx, "nomine")) { strcpy(lastFx, "NO MINE"); }
  else if (!strcmp(fx, "jump")) { strcpy(lastFx, "JUMP"); }
  else if (!strcmp(fx, "near")) { strcpy(lastFx, "DANGER"); blink(60); }
  else if (!strcmp(fx, "join")) { strcpy(lastFx, "HELLO"); blink(200); }
  else if (!strcmp(fx, "escape")) { strcpy(lastFx, "ESCAPE!"); blink(1200); }
  else if (!strcmp(fx, "next")) { strcpy(lastFx, "NEXT.."); blink(300); }
  else if (!strcmp(fx, "stage")) { strcpy(lastFx, "NEW MAP"); blink(300); }
  show();
}

// ---------------------------------------------------------------- buttons
void setupButton(Bounce& b, int pin, int mode) {
  b.attach(pin, mode);
  b.interval(8);
}

// The held direction buttons as a map-grid vector; sent when it changes (and every 0.5 s while held).
void readStick() {
  const bool up = bUp.read() == LOW, down = bDown.read() == LOW;
  const bool left = bLeft.read() == LOW, right = bRight.read() == LOW;
  int x = (right ? 100 : 0) - (left ? 100 : 0);
  int y = (down ? 100 : 0) - (up ? 100 : 0);
  const unsigned long now = millis();
  if (x != sentX || y != sentY || ((x || y) && now - lastSend > 500)) {
    char buf[20];
    snprintf(buf, sizeof(buf), "W,%d,%d", x, y);
    sendInput(buf);
    sentX = x; sentY = y; lastSend = now;
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println();
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, HIGH);
  oled.begin();

  setupButton(bUp, PIN_UP, INPUT);              // external pull-up on the board
  setupButton(bLeft, PIN_LEFT, INPUT_PULLUP);
  setupButton(bDown, PIN_DOWN, INPUT_PULLUP);
  setupButton(bRight, PIN_RIGHT, INPUT_PULLUP);
  setupButton(bJump, PIN_JUMP, INPUT_PULLUP);
  setupButton(bMine, PIN_MINE, INPUT);           // board pull-down, pressed = HIGH

  // Wi-Fi, server and name: set over USB, or the sketch values.
  config.begin(Serial, "Zoo Survival", WIFI_SSID, WIFI_PASS);
  config.setServer(SERVER_HOST, SERVER_PORT);
  config.printServer();
  playerName.maxLength(10);
  if (playerName.value()[0]) snprintf(name, sizeof(name), "%s", playerName.value());
  else snprintf(name, sizeof(name), "esp-%04x", (unsigned)(ESP.getChipId() & 0xffff));
  for (char* c = name; *c; c++) if (*c == ',' || *c == ';') *c = '_';  // ',' separates input fields
  show();

  io.setLog([](const char* line) { Serial.println(line); });
  io.onReady(onReady);
  io.onMessage(onMessage);
  io.begin(&client, config.host(), config.port());
}

bool wasConnected = false;
unsigned long lastShow = 0;

void loop() {
  config.loop();  // USB setup requests, Wi-Fi reconnect
  const bool connected = config.connected();
  if (connected != wasConnected) { wasConnected = connected; show(); }
  if (connected) io.loop();

  bUp.update(); bLeft.update(); bDown.update(); bRight.update(); bJump.update(); bMine.update();
  if (io.state == IO_READY && joined) {
    readStick();
    if (bJump.fell()) sendInput("U");
    if (bMine.rose()) sendInput("B");  // active HIGH
    if (millis() - lastHeartbeat > 3000) { sendInput("H"); lastHeartbeat = millis(); }
  }
  if (ledOffAt && millis() > ledOffAt) { digitalWrite(PIN_LED, HIGH); ledOffAt = 0; }
  if (deadUntil && millis() - lastShow > 250) { lastShow = millis(); show(); }
}
