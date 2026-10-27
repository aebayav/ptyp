import { describe, expect, it } from 'vitest';
import {
  computeDtlMetraj,
  evaluateDecisionScorecard,
  evaluatePoleLocation,
  hammingDistanceHex,
  stripJpegExif,
} from '../src/pole-verifier';

describe('stripJpegExif', () => {
  it('removes APP1 (0xFFE1) EXIF/GPS segment from JPEG buffer while keeping image data', () => {
    const soi = Buffer.from([0xff, 0xd8]);
    // APP1 segment: 0xFFE1, length = 10 (2 bytes len + 8 bytes payload "Exif\0\0GP")
    const app1 = Buffer.from([0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50]);
    // APP0 (JFIF) segment: 0xFFE0, length = 4
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]);
    // SOS + body + EOI
    const sos = Buffer.from([0xff, 0xda, 0x01, 0x02, 0x03, 0xff, 0xd9]);

    const input = Buffer.concat([soi, app1, app0, sos]);
    const cleaned = stripJpegExif(input);

    expect(cleaned.includes(Buffer.from('Exif'))).toBe(false);
    expect(cleaned.equals(Buffer.concat([soi, app0, sos]))).toBe(true);
  });
});

describe('evaluatePoleLocation', () => {
  const poles = [
    { idx: 1, name: 'D-1', lat: 37.91, lon: 40.21 },
    { idx: 2, name: 'D-2', lat: 37.9125, lon: 40.21 }, // ~278m north
  ];

  it('approves location when capture is right next to target pole', () => {
    const res = evaluatePoleLocation(1, poles, 37.9101, 40.21);
    expect(res.has_gps).toBe(true);
    expect(res.gps_distance_m).toBeLessThan(20);
    expect(res.nearest_pole_idx).toBe(1);
    expect(res.wrong_pole_locked).toBe(false);
  });

  it('locks and flags wrong_pole_locked when standing next to D-1 but submitting for D-2', () => {
    const res = evaluatePoleLocation(2, poles, 37.9101, 40.21);
    expect(res.has_gps).toBe(true);
    expect(res.nearest_pole_idx).toBe(1);
    expect(res.nearest_pole_name).toBe('D-1');
    expect(res.wrong_pole_locked).toBe(true);
  });
});

describe('evaluateDecisionScorecard', () => {
  const targetPole = { idx: 2, name: 'D-2', lat: 37.9125, lon: 40.21, tower_type: 'PE1', pole_function: 'KD' };
  const baseVisual = {
    dhash: 'a1b2c3d4e5f60718',
    blur_score: 78,
    brightness: 130,
    contrast: 48,
    soil_ratio: 0.25,
    concrete_gray_ratio: 0.32,
    sky_ratio: 0.2,
    structural_line_score: 0.6,
    is_blank_or_uniform: false,
    claimed_affinity: 0.86,
  };

  it('returns auto_approved with high score when GPS, pHash, quality, and chronology are valid', () => {
    const loc = {
      has_gps: true,
      gps_distance_m: 14,
      nearest_pole_idx: 2,
      nearest_pole_name: 'D-2',
      nearest_distance_m: 14,
      wrong_pole_locked: false,
    };
    const card = evaluateDecisionScorecard({
      targetPole,
      claimedStage: 'foundation',
      previousStage: 'excavation',
      location: loc,
      visual: baseVisual,
      existingPhotos: [],
      sha256: 'deadbeef1234',
      checklistCompleted: ['Ankraj mastar kontrolü', 'Topraklama şeridi'],
    });

    expect(card.decision_status).toBe('auto_approved');
    expect(card.total_score).toBeGreaterThanOrEqual(85);
    expect(card.flags).toHaveLength(0);
  });

  it('rejects photo when perceptual hash matches another pole photo', () => {
    expect(hammingDistanceHex('a1b2c3d4e5f60718', 'a1b2c3d4e5f60719')).toBe(1);

    const loc = {
      has_gps: true,
      gps_distance_m: 12,
      nearest_pole_idx: 2,
      nearest_pole_name: 'D-2',
      nearest_distance_m: 12,
      wrong_pole_locked: false,
    };
    const card = evaluateDecisionScorecard({
      targetPole,
      claimedStage: 'foundation',
      previousStage: 'excavation',
      location: loc,
      visual: baseVisual,
      existingPhotos: [{ pole_idx: 1, pole_name: 'D-1', phash: 'a1b2c3d4e5f60719', sha256: 'other' }],
      sha256: 'newsha',
    });

    expect(card.decision_status).toBe('rejected');
    expect(card.duplicate_of_pole).toBe('D-1');
    expect(card.flags.some((f) => f.startsWith('DUPLICATE_PHOTO_OTHER_POLE'))).toBe(true);
  });
});

describe('computeDtlMetraj', () => {
  it('computes steel tonnage (kg) for erection and span length (m) for stringing', () => {
    const pole = { idx: 5, name: 'D-5', tower_type: 'PE1', meta: { function: 'KD', body_ext_m: 6, span_m: 312 } };
    const erection = computeDtlMetraj(pole, 'erection');
    expect(erection.unit).toBe('kg');
    expect(erection.qty).toBeGreaterThan(6500);

    const stringing = computeDtlMetraj(pole, 'stringing');
    expect(stringing.unit).toBe('m');
    expect(stringing.qty).toBe(312);
  });
});
