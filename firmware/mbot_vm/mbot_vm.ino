/*
 * mbot_vm -- bytecode VM firmware for the mBot (mCore, ATmega328P). Spec: docs/vm.md,
 * opcodes and protocol: server/bytecode.py (keep in sync).
 *
 * The PC uploads a compiled program once; the board runs it on its own and reads its sensors itself.
 * Nothing in here blocks: waits are wake-up times, the ultrasonic sensor is timed by a pin-change
 * interrupt, and all output goes through a queue that only feeds the UART as far as it has room
 * (telemetry that doesn't fit is skipped). So STOP and remote control are handled within ~1 ms, always.
 *
 * Plain Arduino, no Makeblock library. Pins from MeMCore.h:
 *   M1 PWM D6 / DIR D7 = right wheel, M2 PWM D5 / DIR D4 = left wheel (this robot, see README), buzzer D8,
 *   line follower port 2 (D9, D10), ultrasonic port 3 (signal A3), light sensor A6, button A7.
 * left/right are logical: positive = forward = toward the face / ultrasonic / line sensor.
 */
#include <util/crc16.h>

#define FW_VERSION "2"     // = VERSION in server/bytecode.py
#define PROG_MAX 768
#define VARS_MAX 16
#define STACK_MAX 16
#define CALL_MAX 8        // return stack: sub-programs inside sub-programs
#define SLICE 64          // instructions per loop() pass before serial etc. get a turn
#define OUT_SIZE 160      // output queue

const uint8_t M1_PWM = 6, M1_DIR = 7;   // right wheel
const uint8_t M2_PWM = 5, M2_DIR = 4;   // left wheel
const uint8_t BUZZER = 8;
const uint8_t LINE_S1 = 9, LINE_S2 = 10;
const uint8_t LIGHT_PIN = A6, BUTTON_PIN = A7;
// ultrasonic on A3 = PC3 = PCINT11 (pin-change group 1)

enum : uint8_t {
  OP_HALT = 0x00, OP_PUSH8 = 0x01, OP_PUSH16 = 0x02, OP_PUSH32 = 0x03, OP_LOAD = 0x04, OP_STORE = 0x05, OP_DROP = 0x06,
  OP_ADD = 0x10, OP_SUB, OP_MUL, OP_DIV, OP_MOD, OP_NEG,
  OP_EQ = 0x18, OP_NE, OP_LT, OP_LE, OP_GT, OP_GE, OP_AND, OP_OR, OP_NOT, OP_RAND,
  OP_JMP = 0x28, OP_JZ, OP_JNZ, OP_LOOP, OP_CALL, OP_RET,
  OP_SENS = 0x30, OP_MOTORS, OP_WAIT, OP_TONE, OP_TRESET,
  OP_MOVE = 0x38, OP_NOTE,
  OP_COUNT
};
enum : uint8_t { S_LINE, S_LINE1, S_LINE2, S_DISTANCE, S_LIGHT, S_BUTTON, S_TIMER, S_MOTOR_LEFT, S_MOTOR_RIGHT, S_COUNT };
enum : uint8_t { MODE_IDLE, MODE_RUN, MODE_REMOTE };
enum : uint8_t { FAULT_OVERFLOW = 1, FAULT_UNDERFLOW = 2, FAULT_CALLS = 3, FAULT_RET = 4 };

// instruction length in bytes (0 = invalid opcode)
const uint8_t OP_LEN[OP_COUNT] PROGMEM = {
  1, 2, 3, 5, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,   // 00..0F
  1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1,   // 10..1F
  1, 1, 0, 0, 0, 0, 0, 0, 3, 3, 3, 4, 3, 1, 0, 0,   // 20..2F
  2, 1, 1, 1, 1, 0, 0, 0, 8, 5,                     // 30..39
};

// --- program + VM state ------------------------------------------------------

uint8_t prog[PROG_MAX];
uint16_t progLen = 0;
bool progValid = false;
uint8_t nVars = 0;
uint16_t loadLen = 0, loadPos = 0, loadCrc = 0;

int32_t vars[VARS_MAX];
int32_t stack[STACK_MAX];
uint8_t sp = 0;
uint16_t calls[CALL_MAX];       // return addresses
uint8_t csp = 0;
uint16_t pc = 0, curPc = 0;     // curPc: the instruction we are in (telemetry)
uint8_t mode = MODE_IDLE;
bool sleeping = false;
unsigned long wakeAt = 0;
uint8_t moveStage = 0;
unsigned long timerStart = 0;
unsigned long remoteUntil = 0;

int16_t motorL = 0, motorR = 0;

// --- output queue: never blocks ---------------------------------------------

char outq[OUT_SIZE];
uint8_t outHead = 0, outTail = 0;      // write at head, drain from tail

static uint8_t outFree() {
  return OUT_SIZE - 1 - (uint8_t)((outHead + OUT_SIZE - outTail) % OUT_SIZE);
}

static void outPump() {
  int room = Serial.availableForWrite();
  while (room-- > 0 && outTail != outHead) {
    Serial.write(outq[outTail]);
    outTail = (outTail + 1) % OUT_SIZE;
  }
}

// Queues a whole line or nothing. Replies are tiny; if the queue were ever full, drain it (blocks < 15 ms).
static bool outLine(const char *s, uint8_t n, bool optional) {
  if (outFree() < n + 1) {
    if (optional) return false;
    while (outFree() < n + 1) outPump();
  }
  for (uint8_t i = 0; i < n; i++) { outq[outHead] = s[i]; outHead = (outHead + 1) % OUT_SIZE; }
  outq[outHead] = '\n';
  outHead = (outHead + 1) % OUT_SIZE;
  return true;
}

// small line builder (no printf: smaller and no RAM for format strings)
char lb[96];
uint8_t lbn = 0;
static void lbP(const char *p) { char c; while ((c = pgm_read_byte(p++)) && lbn < sizeof(lb)) lb[lbn++] = c; }
static bool lbNum(int32_t v) {      // false (and nothing added) if it doesn't fit
  char tmp[12];
  ltoa(v, tmp, 10);
  uint8_t l = strlen(tmp);
  if (lbn + l + 1 > sizeof(lb)) return false;
  lb[lbn++] = ' ';
  memcpy(lb + lbn, tmp, l);
  lbn += l;
  return true;
}
static void reply(const char *p) { lbn = 0; lbP(p); outLine(lb, lbn, false); }

// --- motors / buzzer ----------------------------------------------------------

static void setMotor(uint8_t pwm, uint8_t dir, int16_t v) {
  digitalWrite(dir, v >= 0 ? HIGH : LOW);
  analogWrite(pwm, v >= 0 ? v : -v);
}

static void drive(int32_t left, int32_t right) {
  motorL = constrain(left, -255, 255);
  motorR = constrain(right, -255, 255);
  setMotor(M1_PWM, M1_DIR, motorR);
  setMotor(M2_PWM, M2_DIR, -motorL);
}

static void stopAll() {
  drive(0, 0);
  noTone(BUZZER);
}

// --- sensors -----------------------------------------------------------------

volatile unsigned long usRise = 0;
volatile unsigned long usEcho = 0;
volatile bool usHigh = false, usDone = false;
uint16_t distCm = 400;
unsigned long usLast = 0;
int16_t light = 0;
bool button = false;
unsigned long analogLast = 0;

ISR(PCINT1_vect) {
  unsigned long t = micros();
  if (PINC & _BV(PC3)) { usRise = t; usHigh = true; }
  else if (usHigh) { usEcho = t - usRise; usHigh = false; usDone = true; }
}

// every 30 ms: take the last echo, fire the next ping (12 us busy, the only "blocking" bit)
static void ultrasonicTick(unsigned long now) {
  if (now - usLast < 30) return;
  usLast = now;
  noInterrupts();
  bool done = usDone;
  unsigned long echo = usEcho;
  interrupts();
  uint32_t cm = done ? echo / 58 : 400;
  distCm = (cm == 0 || cm > 400) ? 400 : cm;
  PCMSK1 &= ~_BV(PCINT11);
  pinMode(A3, OUTPUT);
  digitalWrite(A3, LOW);
  delayMicroseconds(2);
  digitalWrite(A3, HIGH);
  delayMicroseconds(10);
  digitalWrite(A3, LOW);
  pinMode(A3, INPUT);
  usDone = false;
  usHigh = false;
  PCIFR = _BV(PCIF1);
  PCMSK1 |= _BV(PCINT11);
}

static void analogTick(unsigned long now) {
  if (now - analogLast < 5) return;
  analogLast = now;
  light = analogRead(LIGHT_PIN);
  button = analogRead(BUTTON_PIN) < 100;    // as in Makeblock's firmware
}

static uint8_t lineRaw() { return (digitalRead(LINE_S1) << 1) | digitalRead(LINE_S2); }

static int32_t sensor(uint8_t id) {
  switch (id) {
    case S_LINE:    return lineRaw();
    case S_LINE1:   return digitalRead(LINE_S1);
    case S_LINE2:   return digitalRead(LINE_S2);
    case S_DISTANCE:    return distCm;
    case S_LIGHT:   return light;
    case S_BUTTON:  return button;
    case S_TIMER:   return millis() - timerStart;
    case S_MOTOR_LEFT: return motorL;
    case S_MOTOR_RIGHT: return motorR;
  }
  return 0;
}

// --- VM ------------------------------------------------------------------------

static int16_t rd16(uint16_t a) { return (int16_t)(prog[a] | (prog[a + 1] << 8)); }
static uint16_t rdu16(uint16_t a) { return prog[a] | (prog[a + 1] << 8); }
static int32_t rd32(uint16_t a) {
  return (int32_t)((uint32_t)prog[a] | ((uint32_t)prog[a + 1] << 8) | ((uint32_t)prog[a + 2] << 16) | ((uint32_t)prog[a + 3] << 24));
}

static void endProgram(const char *msg) {
  mode = MODE_IDLE;
  stopAll();
  reply(msg);
}

static void fault(uint8_t code) {
  mode = MODE_IDLE;
  stopAll();
  lbn = 0;
  lbP(PSTR("FAULT"));
  lbNum(code);
  lbNum(curPc);
  outLine(lb, lbn, false);
}

static void sleepFor(uint32_t ms) {
  sleeping = true;
  wakeAt = millis() + ms;
}

// One instruction. Returns false if the program ended or faulted.
static bool step() {
  if (pc >= progLen) { endProgram(PSTR("DONE")); return false; }
  curPc = pc;
  uint8_t op = prog[pc];
  uint8_t need = 0, give = 0;     // stack effect, checked up front
  switch (op) {
    case OP_PUSH8: case OP_PUSH16: case OP_PUSH32: case OP_LOAD: case OP_SENS: give = 1; break;
    case OP_STORE: case OP_DROP: case OP_JZ: case OP_JNZ: case OP_WAIT: case OP_NEG: case OP_NOT: need = 1; break;
    case OP_MOTORS: case OP_TONE: need = 2; break;
    default: if (op >= OP_ADD && op <= OP_RAND && op != OP_NEG && op != OP_NOT) need = 2; break;
  }
  if (sp < need) { fault(FAULT_UNDERFLOW); return false; }
  if (sp - need + give > STACK_MAX) { fault(FAULT_OVERFLOW); return false; }
  uint16_t next = pc + pgm_read_byte(&OP_LEN[op]);
  int32_t a, b;
  switch (op) {
    case OP_HALT: endProgram(PSTR("DONE")); return false;
    case OP_PUSH8:  stack[sp++] = (int8_t)prog[pc + 1]; break;
    case OP_PUSH16: stack[sp++] = rd16(pc + 1); break;
    case OP_PUSH32: stack[sp++] = rd32(pc + 1); break;
    case OP_LOAD:   stack[sp++] = vars[prog[pc + 1]]; break;
    case OP_STORE:  vars[prog[pc + 1]] = stack[--sp]; break;
    case OP_DROP:   sp--; break;
    case OP_NEG:    stack[sp - 1] = -stack[sp - 1]; break;
    case OP_NOT:    stack[sp - 1] = !stack[sp - 1]; break;
    case OP_ADD: case OP_SUB: case OP_MUL: case OP_DIV: case OP_MOD:
    case OP_EQ: case OP_NE: case OP_LT: case OP_LE: case OP_GT: case OP_GE:
    case OP_AND: case OP_OR: case OP_RAND:
      b = stack[--sp];
      a = stack[sp - 1];
      switch (op) {
        case OP_ADD: a += b; break;
        case OP_SUB: a -= b; break;
        case OP_MUL: a *= b; break;
        case OP_DIV: a = b == 0 ? 0 : (b == -1 ? -a : a / b); break;
        case OP_MOD: a = (b == 0 || b == -1) ? 0 : a % b; break;
        case OP_EQ:  a = a == b; break;
        case OP_NE:  a = a != b; break;
        case OP_LT:  a = a < b; break;
        case OP_LE:  a = a <= b; break;
        case OP_GT:  a = a > b; break;
        case OP_GE:  a = a >= b; break;
        case OP_AND: a = a && b; break;
        case OP_OR:  a = a || b; break;
        case OP_RAND: if (a > b) { int32_t t = a; a = b; b = t; } a = random(a, b + 1); break;
      }
      stack[sp - 1] = a;
      break;
    case OP_JMP: next = rdu16(pc + 1); break;
    case OP_JZ:  if (stack[--sp] == 0) next = rdu16(pc + 1); break;
    case OP_JNZ: if (stack[--sp] != 0) next = rdu16(pc + 1); break;
    case OP_LOOP:
      if (--vars[prog[pc + 1]] > 0) next = rdu16(pc + 2);
      break;
    case OP_CALL:
      if (csp >= CALL_MAX) { fault(FAULT_CALLS); return false; }
      calls[csp++] = next;
      next = rdu16(pc + 1);
      break;
    case OP_RET:
      if (csp == 0) { fault(FAULT_RET); return false; }
      next = calls[--csp];
      break;
    case OP_SENS:   stack[sp++] = sensor(prog[pc + 1]); break;
    case OP_MOTORS: b = stack[--sp]; a = stack[--sp]; drive(a, b); break;
    case OP_WAIT:
      a = stack[--sp];
      pc = next;
      if (a > 0) { sleepFor(min(a, 3600000L)); return true; }
      return true;
    case OP_TONE:
      b = stack[--sp]; a = stack[--sp];
      if (a > 0 && b > 0) tone(BUZZER, constrain(a, 31, 20000), min(b, 60000L)); else noTone(BUZZER);
      break;
    case OP_TRESET: timerStart = millis(); break;
    case OP_MOVE: {
      uint8_t pause = prog[pc + 7];
      if (moveStage == 0) {                      // drive
        drive(rd16(pc + 1), rd16(pc + 3));
        moveStage = 1;
        sleepFor(rdu16(pc + 5));
        return true;                             // pc stays: we come back here
      }
      if (moveStage == 1 && pause != 255) {      // stop and let the robot come to rest
        drive(0, 0);
        moveStage = 2;
        if (pause) { sleepFor(pause * 10UL); return true; }
      }
      moveStage = 0;
      break;
    }
    case OP_NOTE:                                // play and wait; pc stays until the note is over
      if (moveStage == 0) {
        tone(BUZZER, constrain(rdu16(pc + 1), 31, 20000), rdu16(pc + 3));
        moveStage = 1;
        sleepFor(rdu16(pc + 3));
        return true;
      }
      moveStage = 0;
      break;
  }
  pc = next;
  return true;
}

static void vmTick(unsigned long now) {
  if (mode != MODE_RUN) return;
  if (sleeping) {
    if ((long)(now - wakeAt) < 0) return;
    sleeping = false;
  }
  for (uint8_t n = 0; n < SLICE && mode == MODE_RUN && !sleeping; n++) {
    if (!step()) break;
  }
}

static void startProgram() {
  memset(vars, 0, sizeof(vars));
  sp = 0;
  csp = 0;
  pc = curPc = 0;
  moveStage = 0;
  sleeping = false;
  timerStart = millis();
  mode = MODE_RUN;
}

// Every instruction valid and complete, jumps on instruction starts, variable slots in range.
static bool verify(uint16_t *badPc) {
  uint8_t starts[(PROG_MAX + 7) / 8];
  memset(starts, 0, sizeof(starts));
  uint16_t a = 0;
  while (a < progLen) {
    uint8_t op = prog[a];
    uint8_t len = op < OP_COUNT ? pgm_read_byte(&OP_LEN[op]) : 0;
    if (len == 0 || a + len > progLen) { *badPc = a; return false; }
    if ((op == OP_LOAD || op == OP_STORE || op == OP_LOOP) && prog[a + 1] >= nVars) { *badPc = a; return false; }
    if (op == OP_SENS && prog[a + 1] >= S_COUNT) { *badPc = a; return false; }
    starts[a >> 3] |= 1 << (a & 7);
    a += len;
  }
  for (a = 0; a < progLen; a += pgm_read_byte(&OP_LEN[prog[a]])) {
    uint8_t op = prog[a];
    if (op >= OP_JMP && op <= OP_CALL) {
      uint16_t t = rdu16(a + (op == OP_LOOP ? 2 : 1));
      if (t >= progLen || !(starts[t >> 3] & (1 << (t & 7)))) { *badPc = a; return false; }
    }
  }
  return true;
}

// --- telemetry ---------------------------------------------------------------------

uint16_t telPeriod = 50;
unsigned long telLast = 0;
uint8_t vNext = 0;

static void telemetryTick(unsigned long now) {
  if (!telPeriod || now - telLast < telPeriod) return;
  telLast = now;
  lbn = 0;
  lbP(PSTR("T"));
  lbNum(mode);
  lbNum(curPc);
  lbNum(lineRaw());
  lbNum(distCm);
  lbNum(light);
  lbNum(button);
  lbNum(motorL);
  lbNum(motorR);
  lbNum(mode == MODE_RUN ? (int32_t)(now - timerStart) : 0);
  lbNum(csp ? calls[0] - 3 : curPc);          // the outermost sub-program call (the simple mode lights that up)
  if (!outLine(lb, lbn, true)) return;
  if (nVars == 0 || !progValid) return;
  // "V <first> <values…>": as many as fit in one line; the rest follow in the next ticks
  lbn = 0;
  lbP(PSTR("V"));
  lbNum(vNext);
  uint8_t i = vNext;
  while (i < nVars && lbNum(vars[i])) i++;
  if (outLine(lb, lbn, true)) vNext = i >= nVars ? 0 : i;
}

// --- commands ------------------------------------------------------------------------

char line[64];
uint8_t len = 0;

static uint8_t tokenize(char **tok, uint8_t max) {
  uint8_t n = 0;
  char *p = line;
  while (*p && n < max) {
    while (*p == ' ') p++;
    if (!*p) break;
    tok[n++] = p;
    while (*p && *p != ' ') p++;
    if (*p) *p++ = 0;
  }
  return n;
}

static int8_t hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static void handleLine() {
  char *t[5];
  uint8_t n = tokenize(t, 5);
  if (n == 0) return;
  const char *c = t[0];

  if (!strcmp_P(c, PSTR("M")) && n >= 4) {            // remote control first: it's the hot path
    if (mode == MODE_RUN) endProgram(PSTR("STOPPED"));
    int32_t ttl = atol(t[3]);
    drive(atol(t[1]), atol(t[2]));
    if (ttl > 0 && (motorL || motorR)) { mode = MODE_REMOTE; remoteUntil = millis() + min(ttl, 5000L); }
    else if (mode == MODE_REMOTE) mode = MODE_IDLE;
  } else if (!strcmp_P(c, PSTR("H")) && n >= 3) {
    int32_t hz = atol(t[1]), ms = atol(t[2]);
    if (hz > 0 && ms > 0) tone(BUZZER, constrain(hz, 31, 20000), min(ms, 5000L)); else noTone(BUZZER);
  } else if (!strcmp_P(c, PSTR("STOP"))) {
    loadLen = 0;
    endProgram(PSTR("STOPPED"));
  } else if (!strcmp_P(c, PSTR("PING"))) {
    lbn = 0;
    lbP(PSTR("PONG mbot_vm " FW_VERSION));
    lbNum(PROG_MAX);
    lbNum(VARS_MAX);
    outLine(lb, lbn, false);
  } else if (!strcmp_P(c, PSTR("LOAD")) && n >= 3) {
    if (mode != MODE_IDLE) { mode = MODE_IDLE; stopAll(); }
    long l = atol(t[1]), v = atol(t[2]);
    if (l < 1 || l > PROG_MAX || v < 0 || v > VARS_MAX) { reply(PSTR("ERR size")); return; }
    progValid = false;
    loadLen = l; loadPos = 0; loadCrc = 0xFFFF;
    nVars = v;
    reply(PSTR("OK"));
  } else if (!strcmp_P(c, PSTR("W")) && n >= 2) {
    if (!loadLen) { reply(PSTR("ERR noload")); return; }
    for (const char *h = t[1]; h[0] && h[1]; h += 2) {
      int8_t hi = hexval(h[0]), lo = hexval(h[1]);
      if (hi < 0 || lo < 0) { loadLen = 0; reply(PSTR("ERR hex")); return; }
      if (loadPos >= loadLen) { loadLen = 0; reply(PSTR("ERR len")); return; }
      uint8_t byte = (hi << 4) | lo;
      prog[loadPos++] = byte;
      loadCrc = _crc_xmodem_update(loadCrc, byte);
    }
    reply(PSTR("OK"));
  } else if (!strcmp_P(c, PSTR("END")) && n >= 2) {
    if (!loadLen || loadPos != loadLen) { loadLen = 0; reply(PSTR("ERR len")); return; }
    uint16_t want = strtoul(t[1], NULL, 16);
    progLen = loadLen;
    loadLen = 0;
    if (want != loadCrc) { progLen = 0; reply(PSTR("ERR crc")); return; }
    uint16_t bad;
    if (!verify(&bad)) {
      progLen = 0;
      lbn = 0; lbP(PSTR("ERR verify")); lbNum(bad);
      outLine(lb, lbn, false);
      return;
    }
    progValid = true;
    reply(PSTR("OK"));
  } else if (!strcmp_P(c, PSTR("RUN"))) {
    if (!progValid) { reply(PSTR("ERR empty")); return; }
    reply(PSTR("OK"));
    stopAll();
    startProgram();
  } else if (!strcmp_P(c, PSTR("TEL")) && n >= 2) {
    telPeriod = constrain(atol(t[1]), 0, 10000);
    reply(PSTR("OK"));
  } else {
    reply(PSTR("ERR cmd"));
  }
}

static void readSerial() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (len > 0) {
        line[len] = 0;
        len = 0;
        handleLine();
      }
    } else if (ch >= 0x20 && ch < 0x7f) {               // BLE junk and other noise is ignored
      if (len < sizeof(line) - 1) line[len++] = ch; else len = 0;   // overlong line: drop it
    }
  }
}

void setup() {
  pinMode(M1_DIR, OUTPUT);
  pinMode(M2_DIR, OUTPUT);
  pinMode(LINE_S1, INPUT);
  pinMode(LINE_S2, INPUT);
  stopAll();
  PCICR |= _BV(PCIE1);          // pin-change interrupts for A0..A5; ultrasonicTick() unmasks A3 only
  Serial.begin(115200);
  randomSeed(analogRead(LIGHT_PIN) ^ micros());
  tone(BUZZER, 880, 120);       // short "I'm alive" beep
  reply(PSTR("READY mbot_vm " FW_VERSION));
}

void loop() {
  unsigned long now = millis();
  readSerial();
  if (mode == MODE_REMOTE && (long)(now - remoteUntil) >= 0) {   // deadman: no renewal, no driving
    mode = MODE_IDLE;
    drive(0, 0);
  }
  vmTick(now);
  ultrasonicTick(now);
  analogTick(now);
  telemetryTick(now);
  outPump();
}
