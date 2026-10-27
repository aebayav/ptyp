// Gecikmiş görev SQL koşulu — tek kaynak: overview.ts ve workgroups.ts buradan alır.
// due_date sütunu gerçek DATE tipindedir (migrasyon #2); boş tarih NULL olarak tutulur.
// DİKKAT: JOIN'li sorgularda (ör. work_groups w LEFT JOIN tasks t) hem w hem t tablosunda
// `status` sütunu bulunduğundan "column reference 'status' is ambiguous" hatasını önlemek
// için sütunlar her zaman tablo takma adıyla (`t.`) nitelendirilir.
export function lateTaskSql(alias = 't'): string {
  const p = alias ? `${alias}.` : '';
  return `${p}status != 'done' AND ${p}due_date IS NOT NULL AND ${p}due_date < CURRENT_DATE`;
}

export const LATE_TASK_SQL = lateTaskSql('t');
