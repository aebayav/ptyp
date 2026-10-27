// Geç kalmış görev filtresi — TEK yerde tanımlı SQL parçası.
// due_date DATE tipinde: metin karşılaştırması ('' / to_char) PostgreSQL'de
// "invalid input syntax for type date" hatası üretir. Bu parçayı kullanan
// tüm sorgular aynı yerden beslenir (workgroups GET+PUT, overview).
export const LATE_TASK_SQL = `status != 'done' AND due_date IS NOT NULL AND due_date < CURRENT_DATE`;
