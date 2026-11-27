/**
 * Audio format conversion helpers for bridging Twilio Media Streams
 * (8 kHz, 8-bit G.711 mu-law mono) with Gemini Live API
 * (16 kHz input / 24 kHz output, 16-bit signed little-endian PCM).
 */

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

const MULAW_TO_PCM16 = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const mu = ~i & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  const magnitude = ((mantissa << 3) + MULAW_BIAS) << exponent;
  MULAW_TO_PCM16[i] = sign ? MULAW_BIAS - magnitude : magnitude - MULAW_BIAS;
}

const EXP_TABLE = [
  0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
];

export function pcm16SampleToMulaw(sample: number): number {
  let sign = 0;
  let mag = sample;
  if (mag < 0) {
    sign = 0x80;
    mag = -mag;
  }
  if (mag > MULAW_CLIP) {
    mag = MULAW_CLIP;
  }
  mag += MULAW_BIAS;
  const exponent = EXP_TABLE[(mag >> 7) & 0xff];
  const mantissa = (mag >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export class TwilioGeminiAudioConverter {
  private lastInboundSample = 0;
  private outboundCarryBytes: number[] = [];

  /**
   * Decodes Twilio base64 8 kHz G.711 mu-law payload and linearly upsamples 2x
   * to 16 kHz 16-bit little-endian PCM encoded as base64 for Gemini Live API.
   */
  public mulaw8kBase64ToPcm16kBase64(mulawBase64: string): string {
    const mulawBuf = Buffer.from(mulawBase64, "base64");
    if (mulawBuf.length === 0) return "";

    const pcm16k = Buffer.allocUnsafe(mulawBuf.length * 4);
    let prev = this.lastInboundSample;

    for (let i = 0; i < mulawBuf.length; i++) {
      const curr = MULAW_TO_PCM16[mulawBuf[i]];
      const mid = (prev + curr) >> 1;
      const offset = i * 4;
      pcm16k.writeInt16LE(mid, offset);
      pcm16k.writeInt16LE(curr, offset + 2);
      prev = curr;
    }

    this.lastInboundSample = prev;
    return pcm16k.toString("base64");
  }

  /**
   * Decodes Gemini Live 24 kHz 16-bit little-endian PCM base64 audio,
   * downsamples 3:1 to 8 kHz with a 3-tap averaging anti-alias filter,
   * encodes to G.711 mu-law, and splits into 20 ms (160-byte) base64 frames.
   */
  public pcm24kBase64ToMulaw8kFrames(pcm24kBase64: string): string[] {
    const raw = Buffer.from(pcm24kBase64, "base64");
    if (raw.length === 0) return [];

    // Combine any leftover bytes from the previous chunk so 6-byte (3 int16 samples) groups stay aligned
    let combined: Buffer;
    if (this.outboundCarryBytes.length > 0) {
      combined = Buffer.concat([Buffer.from(this.outboundCarryBytes), raw]);
      this.outboundCarryBytes = [];
    } else {
      combined = raw;
    }

    const usableBytes = Math.floor(combined.length / 6) * 6;
    if (usableBytes < combined.length) {
      for (let i = usableBytes; i < combined.length; i++) {
        this.outboundCarryBytes.push(combined[i]);
      }
    }

    if (usableBytes === 0) return [];

    const mulawCount = usableBytes / 6;
    const mulawBuf = Buffer.allocUnsafe(mulawCount);
    for (let i = 0; i < mulawCount; i++) {
      const byteOffset = i * 6;
      const s0 = combined.readInt16LE(byteOffset);
      const s1 = combined.readInt16LE(byteOffset + 2);
      const s2 = combined.readInt16LE(byteOffset + 4);
      const avg = Math.round((s0 + s1 + s2) / 3);
      mulawBuf[i] = pcm16SampleToMulaw(avg);
    }

    // Emit 20 ms (160-byte) chunks for smooth Twilio Media Streams playback
    const frames: string[] = [];
    for (let offset = 0; offset < mulawBuf.length; offset += 160) {
      const slice = mulawBuf.subarray(offset, Math.min(offset + 160, mulawBuf.length));
      frames.push(slice.toString("base64"));
    }
    return frames;
  }

  public resetOutboundCarry(): void {
    this.outboundCarryBytes = [];
  }
}
