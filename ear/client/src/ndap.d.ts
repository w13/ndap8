// Type declarations for the embedded NDAP-8 codec (./ndap.js).
// The codec itself is the conformance-proven ES module, embedded whole;
// only the surface the Ear uses is declared here.

export const SR: number;
export const SND_LEN: number;
export const MINI_LEN: number;

export interface ToneFeats {
  median_snr_db: number;
  p10_snr_db: number;
  min_rel_gain: number;
  frac_below_6db: number;
  frac_below_0db: number;
}

export interface ChannelAnalysis {
  snr_db: Float64Array;
  rel_gain: Float64Array;
  c_snr_db: Float64Array;
  c_rel_gain: Float64Array;
  A: ToneFeats;
  B: ToneFeats;
  C: ToneFeats;
  recommendation: string;
  degenerate?: boolean;
}

export interface DecodeReport {
  ok: boolean;
  data: Uint8Array | null;
  mode: string | null;
  session: number | null;
  segments: Array<{ index: number; ok: boolean; error: string | null }>;
  failed_segments: number[];
  ok_segments: number[];
  error: string | null;
  version: number;
  next_speaker: number;
  final_seen: boolean;
  house_token_ok?: boolean;
}

export function sounding_burst(): Float64Array;
export function analyze_channel(samples: ArrayLike<number>): ChannelAnalysis;
export function recommend_mode(ana: ChannelAnalysis): string;
export function crc32(d: Uint8Array): number;
export function encode_adaptive(
  data: Uint8Array,
  mode: string,
  opts?: {
    analysis?: ChannelAnalysis | null;
    session_id?: number | null;
    house_secret?: Uint8Array | null;
    next_speaker?: number;
  },
): Float64Array;
export function encode_auto(
  data: Uint8Array,
  sounding_samples: ArrayLike<number>,
): [Float64Array | null, string];
export function decode_adaptive_report(
  samples: ArrayLike<number>,
  start?: number | null,
  house_secret?: Uint8Array | null,
): DecodeReport;
export function decode_adaptive(samples: ArrayLike<number>, start?: number | null): Uint8Array;
