import { describe, expect, it } from 'vitest';
import { poleNumberFromName, poleStageProgress } from '../src/pole-statuses';
import {
  PHASE_TEMPLATES,
  computeCantonReadiness,
  computePoleParcelBlockers,
  detectCantons,
} from '../src/work-plan-generator';

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

describe('detectCantons', () => {
  it('treats only anchor/dead-end towers (N, D, KD) as canton boundaries, not suspension (T, KT)', () => {
    const poles = [
      { idx: 1, name: 'D-1', meta: { function: 'N', tower_type: 'PF', style: 'dead' } },
      { idx: 2, name: 'D-2', meta: { function: 'T', tower_type: 'PB1', style: 'tower' } },
      { idx: 3, name: 'D-3', meta: { function: 'KT', tower_type: 'PB2', style: 'tower' } },
      { idx: 4, name: 'D-4', meta: { function: 'KD', tower_type: 'PE1', style: 'dead' } },
      { idx: 5, name: 'D-5', meta: { function: 'T', tower_type: 'PB1', style: 'tower' } },
      { idx: 6, name: 'D-6', meta: { function: 'N', tower_type: 'PF', style: 'dead' } },
    ];
    const cantons = detectCantons(poles, []);
    expect(cantons).toHaveLength(2);
    expect(cantons[0]).toMatchObject({ fromNum: 1, toNum: 4, poleCount: 4 });
    expect(cantons[1]).toMatchObject({ fromNum: 4, toNum: 6, poleCount: 3 });
  });
});

describe('computePoleParcelBlockers & computeCantonReadiness', () => {
  const poles = [
    { idx: 0, name: 'D-1', status: 'erection', meta: { function: 'N', tower_type: 'PF', style: 'dead' } },
    { idx: 1, name: 'D-2', status: 'erection', meta: { function: 'T', tower_type: 'PB1', style: 'tower' } },
    { idx: 2, name: 'D-3', status: 'foundation', meta: { function: 'KT', tower_type: 'PB2', style: 'tower' } },
    { idx: 3, name: 'D-4', status: 'erection', meta: { function: 'KD', tower_type: 'PE1', style: 'dead' } },
    { idx: 4, name: 'D-5', status: 'erection', meta: { function: 'T', tower_type: 'PB1', style: 'tower' } },
    { idx: 5, name: 'D-6', status: 'fittings', meta: { function: 'N', tower_type: 'PF', style: 'dead' } },
  ];

  const parcels = [
    {
      id: 10,
      pole_from_idx: 1,
      pole_to_idx: 2,
      parcel_no: '105/4',
      owner_name: 'Mehmet Demir',
      easement_status: 'izinsiz',
      legal_status: 'dava',
    },
    {
      id: 11,
      pole_from_idx: 4,
      pole_to_idx: 5,
      parcel_no: '208/1',
      owner_name: 'Ayşe Kaya',
      easement_status: 'izinli',
      legal_status: 'anlasma',
    },
  ];

  it('flags poles inside unpermitted parcel spans with severity and summary', () => {
    const blockers = computePoleParcelBlockers(poles, parcels);
    expect(blockers[0]).toBeUndefined();
    expect(blockers[1]).toBeDefined();
    expect(blockers[1].severity).toBe('izinsiz');
    expect(blockers[1].summary_text).toContain('105/4');
    expect(blockers[2]).toBeDefined();
    expect(blockers[2].severity).toBe('izinsiz');
    expect(blockers[4]).toBeUndefined();
  });

  it('marks canton 1 as blocked due to izinsiz parcel and canton 2 as ready_for_stringing when all poles are erected and permitted', () => {
    const readiness = computeCantonReadiness(poles, [], parcels);
    expect(readiness.cantons).toHaveLength(2);
    expect(readiness.cantons[0].readiness_status).toBe('blocked');
    expect(readiness.cantons[0].izinsiz_count).toBe(1);
    expect(readiness.cantons[1].readiness_status).toBe('ready_for_stringing');
    expect(readiness.cantons[1].izinsiz_count).toBe(0);
    expect(readiness.summary.open_canton_count).toBe(1);
    expect(readiness.summary.blocked_canton_count).toBe(1);
  });
});


