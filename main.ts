// Tiny stack VM for make.fun tiny-stack-vm-01-run-20261122 (ISA v1): runs every
// program.bin in /input/<id>/ on its input.bin, writes /output/<id>/stdout.bin + exit.txt.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const enc = new TextEncoder();

// Runs one program on one input. Returns [bytes written, exit code 0-255].
function run(P: Uint8Array, N: Uint8Array): [Uint8Array, number] {
  const n = P.length;
  const D = new Int32Array(256); // data stack
  const C = new Int32Array(64); // call stack
  const M = new Int32Array(256); // memory
  const out = new Uint8Array(65536);
  let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, st = 0;
  const end = (e: number): [Uint8Array, number] => [out.subarray(0, ol), e];
  for (;;) {
    if (st === 1000000) return end(10); // step limit
    if (pc < 0 || pc >= n) return end(9); // pc outside program
    const op = P[pc];
    const im = op === 1 ? 1 : op === 2 ? 4 : op >= 48 && op <= 51 ? 2 : 0;
    const ok = op <= 7 || (op >= 16 && op <= 30) || (op >= 32 && op <= 34) ||
      (op >= 48 && op <= 52) || op === 64 || op === 65 || (op >= 80 && op <= 83);
    if (!ok) return end(5); // unknown opcode
    if (pc + im >= n) return end(9); // immediate cut off by end of program
    st++;
    const nx = pc + 1 + im;
    pc = nx;
    switch (op) {
      case 0: return end(0); // HALT
      case 1: // PUSH8, sign-extended
        if (sp >= 256) return end(3);
        D[sp++] = (P[nx - 1] << 24) >> 24;
        break;
      case 2: // PUSH32, little-endian signed
        if (sp >= 256) return end(3);
        D[sp++] = P[nx - 4] | (P[nx - 3] << 8) | (P[nx - 2] << 16) | (P[nx - 1] << 24);
        break;
      case 3: // POP
        if (sp < 1) return end(2);
        sp--;
        break;
      case 4: // DUP
        if (sp < 1) return end(2);
        if (sp >= 256) return end(3);
        D[sp] = D[sp - 1];
        sp++;
        break;
      case 5: { // SWAP
        if (sp < 2) return end(2);
        const t = D[sp - 1];
        D[sp - 1] = D[sp - 2];
        D[sp - 2] = t;
        break;
      }
      case 6: // OVER
        if (sp < 2) return end(2);
        if (sp >= 256) return end(3);
        D[sp] = D[sp - 2];
        sp++;
        break;
      case 7: { // ROT: ( a b c -- b c a )
        if (sp < 3) return end(2);
        const a = D[sp - 3];
        D[sp - 3] = D[sp - 2];
        D[sp - 2] = D[sp - 1];
        D[sp - 1] = a;
        break;
      }
      case 23: // NEG
        if (sp < 1) return end(2);
        D[sp - 1] = -D[sp - 1] | 0;
        break;
      case 27: // NOT
        if (sp < 1) return end(2);
        D[sp - 1] = ~D[sp - 1];
        break;
      case 48: // JMP: signed 16-bit offset from next instruction
        pc = nx + (((P[nx - 2] | (P[nx - 1] << 8)) << 16) >> 16);
        break;
      case 49: // JZ
      case 50: { // JNZ
        if (sp < 1) return end(2);
        const v = D[--sp];
        if ((op === 49) === (v === 0)) pc = nx + (((P[nx - 2] | (P[nx - 1] << 8)) << 16) >> 16);
        break;
      }
      case 51: // CALL: unsigned 16-bit target
        if (cp === 64) return end(7);
        C[cp++] = nx;
        pc = P[nx - 2] | (P[nx - 1] << 8);
        break;
      case 52: // RET
        if (cp === 0) return end(8);
        pc = C[--cp];
        break;
      case 64: { // LOAD
        if (sp < 1) return end(2);
        const a = D[sp - 1];
        if (a < 0 || a >= 256) return end(6);
        D[sp - 1] = M[a];
        break;
      }
      case 65: { // STORE: ( v addr -- )
        if (sp < 2) return end(2);
        const a = D[sp - 1];
        if (a < 0 || a >= 256) return end(6);
        sp -= 2;
        M[a] = D[sp];
        break;
      }
      case 80: { // PRINT: decimal ASCII, no newline
        if (sp < 1) return end(2);
        const b = enc.encode(String(D[sp - 1]));
        if (ol + b.length > 65536) return end(11);
        sp--;
        out.set(b, ol);
        ol += b.length;
        break;
      }
      case 81: // PUTC: one byte, v AND 255
        if (sp < 1) return end(2);
        if (ol + 1 > 65536) return end(11);
        out[ol++] = D[--sp] & 255;
        break;
      case 82: // IN: next input byte, -1 once exhausted
        if (sp >= 256) return end(3);
        D[sp++] = ip < N.length ? N[ip++] : -1;
        break;
      case 83: // EXIT: code is v AND 255
        if (sp < 1) return end(2);
        return end(D[--sp] & 255);
      default: { // binary ops: ADD SUB MUL DIV MOD DIVU MODU AND OR XOR SHL SHR SHRU EQ LT LTU
        if (sp < 2) return end(2);
        const b = D[sp - 1];
        const a = D[sp - 2];
        let r = 0;
        if (op === 16) r = (a + b) | 0;
        else if (op === 17) r = (a - b) | 0;
        else if (op === 18) r = Math.imul(a, b);
        else if (op === 19) {
          if (b === 0) return end(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 20) {
          if (b === 0) return end(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 21) {
          if (b === 0) return end(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 22) {
          if (b === 0) return end(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 24) r = a & b;
        else if (op === 25) r = a | b;
        else if (op === 26) r = a ^ b;
        else if (op === 28) r = a << (b & 31);
        else if (op === 29) r = a >> (b & 31);
        else if (op === 30) r = (a >>> (b & 31)) | 0;
        else if (op === 32) r = a === b ? 1 : 0;
        else if (op === 33) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
        sp -= 2;
        D[sp++] = r;
        break;
      }
    }
  }
}

// Driver: answer every instance in /input/<id>/, one run for the whole set.
for (const id of readdirSync(I).sort()) {
  const P = readFileSync(join(I, id, 'program.bin'));
  const N = readFileSync(join(I, id, 'input.bin'));
  const [stdout, exit] = run(P, N);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), stdout);
  writeFileSync(join(O, id, 'exit.txt'), String(exit) + '\n');
}
