import { describe, expect, it } from 'vitest';
import { poleNumberFromName, poleStageProgress } from '../src/pole-statuses';
import { PHASE_TEMPLATES } from '../src/work-plan-generator';

describe('poleNumberFromName', () => {
  it('parses standard and annotated pole labels', () => {
    expect(poleNumberFromName('D-14')).toBe(14);
    expect(poleNumberFromName('D14')).toBe(14);
    expect(poleNumberFromName('14(S)')).toBe(14);
    expect(poleNumberFromName('Direk 42')).toBe(42);
    expect(poleNumberFromName('P_7')).toBe(7);
  });

  it('returns null for portal or non-numeric labels', () => {
    expect(poleNumberFromName('Portal-Başlangıç')).toBeNull();
    expect(poleNumberFromName('TM-Giriş')).toBeNull();
    expect(poleNumberFromName('')).toBeNull();
  });
});

describe('poleStageProgress', () => {
  it('returns raw pole progress when sahaStage is empty or all', () => {
    expect(poleStageProgress('excavation', '')).toBe(15);
    expect(poleStageProgress('erection', 'all')).toBe(50);
  });

  it('returns 100 when pole has reached or passed the linked stage, 0 otherwise', () => {
    expect(poleStageProgress('none', 'excavation')).toBe(0);
    expect(poleStageProgress('excavation', 'excavation')).toBe(100);
    expect(poleStageProgress('foundation', 'excavation')).toBe(100);
    expect(poleStageProgress('excavation', 'erection')).toBe(0);
    expect(poleStageProgress('erection', 'erection')).toBe(100);
    expect(poleStageProgress('stringing', 'erection')).toBe(100);
    expect(poleStageProgress('stringing', 'completed')).toBe(0);
    expect(poleStageProgress('completed', 'completed')).toBe(100);
  });
});

describe('PHASE_TEMPLATES', () => {
  it('defines ENH, TM, GES, and RES templates whose weights each sum to 100', () => {
    for (const key of ['enh', 'tm', 'ges', 'res']) {
      const phases = PHASE_TEMPLATES[key];
      expect(phases?.length).toBeGreaterThanOrEqual(4);
      const totalWeight = phases.reduce((sum, p) => sum + p.weight, 0);
      expect(totalWeight).toBe(100);
      for (const p of phases) {
        expect(p.startFrac).toBeGreaterThanOrEqual(0);
        expect(p.endFrac).toBeLessThanOrEqual(1);
        expect(p.endFrac).toBeGreaterThan(p.startFrac);
      }
    }
  });
});
