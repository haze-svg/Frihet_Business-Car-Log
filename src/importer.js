// 기존 엑셀(운행일지 / 관리점검일지) 가져오기
// 실제 엑셀 양식 확인 후 시트·열 매핑을 확정한다. (현재: 헤더 자동 인식 방식)
const XLSX = require('xlsx');
const { q, pool } = require('./db');

const pick = (row, keys) => {
  for (const k of Object.keys(row)) {
    const nk = k.replace(/\s/g, '');
    if (keys.some((x) => nk.includes(x))) return row[k];
  }
  return undefined;
};
const toDate = (v) => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const m = String(v || '').match(/(\d{4})[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};
const n = (v) => {
  const x = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(x) ? x : 0;
};

async function importWorkbook(buffer, { kind, userId, dryRun }) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const report = { sheets: [], inserted: 0, skipped: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
      let ins = 0;
      for (const r of rows) {
        const date = toDate(pick(r, ['일자', '날짜', '운행일', '사용일']));
        if (!date) { report.skipped++; continue; }
        if (kind === 'maintenance') {
          const vehicleId = Number(r.__vehicle_id) || null;
          if (!vehicleId) { report.skipped++; continue; }
          await client.query(
            `INSERT INTO maintenance(vehicle_id,user_id,maint_date,maint_type,odometer_km,description,vendor,amount,memo,source)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'excel')`,
            [vehicleId, userId, date, String(pick(r, ['구분', '항목']) || '점검'), n(pick(r, ['주행', '계기판', '누적'])) || null,
              String(pick(r, ['내용', '내역']) || ''), String(pick(r, ['업체', '정비소']) || ''), n(pick(r, ['금액', '비용'])),
              String(pick(r, ['비고']) || '')]
          );
        } else {
          if (!userId) throw Object.assign(new Error('운행일지 가져오기는 대상 직원을 선택해야 합니다'), { status: 400 });
          await client.query(
            `INSERT INTO trips(user_id,trip_date,purpose,start_name,end_name,distance_km,toll_won,fuel_cost_won,parking_won,memo,source)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'excel')`,
            [userId, date, String(pick(r, ['목적', '업무']) || ''), String(pick(r, ['출발']) || ''), String(pick(r, ['도착', '목적지']) || ''),
              n(pick(r, ['km', '거리', '키로'])), n(pick(r, ['통행료', '톨'])), n(pick(r, ['유류', '연료', '주유비'])),
              n(pick(r, ['주차'])), String(pick(r, ['비고']) || '')]
          );
        }
        ins++;
      }
      report.sheets.push({ name, rows: rows.length, inserted: ins });
      report.inserted += ins;
    }
    if (dryRun) await client.query('ROLLBACK'); else await client.query('COMMIT');
    report.dry_run = !!dryRun;
    return report;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

module.exports = { importWorkbook };
