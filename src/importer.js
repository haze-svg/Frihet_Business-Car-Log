// 기존 엑셀(SV팀 차량 운행일지 / 직원점검 관리일지)에서 추출·정규화한 이관 데이터(JSON) 적재
// - 같은 파일을 다시 올리면 기존 엑셀 이관분(source='excel')을 지우고 다시 적재 (중복 방지)
// - 웹에서 직접 입력한 기록(source='web')은 건드리지 않음
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const { pool } = require('./db');

const normPlate = (p) => String(p || '').replace(/\s/g, '');

// 지원 형식: .json / .json.gz (데이터만) / .zip (legacy.json + img/*.jpg 영수증 사진 포함)
function parsePayload(buf) {
  let raw; let zip = null;
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    zip = new AdmZip(buf);
    const entry = zip.getEntry('legacy.json');
    if (!entry) throw Object.assign(new Error('패키지에 legacy.json이 없습니다'), { status: 400 });
    raw = entry.getData();
  } else raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  const data = JSON.parse(raw.toString('utf8'));
  if (![1, 2].includes(data.version) || !Array.isArray(data.trips)) throw Object.assign(new Error('이관 데이터 형식이 올바르지 않습니다'), { status: 400 });
  data.readFile = (p) => {
    const e = zip && zip.getEntry(p);
    return e ? e.getData() : null;
  };
  return data;
}

async function importLegacy(buf, { dryRun = false } = {}) {
  const data = parsePayload(buf);
  const client = await pool.connect();
  const rep = { vehicles_created: 0, vehicles_updated: 0, trips: 0, expenses: 0, maintenance: 0, receipt_groups: 0, photos: 0, missing_photos: 0, unmatched_names: {}, dry_run: dryRun };
  try {
    await client.query('BEGIN');
    const users = (await client.query('SELECT id, name FROM users')).rows;
    const uid = (name) => {
      if (!name) return null;
      const u = users.find((x) => x.name === name);
      if (!u) rep.unmatched_names[name] = (rep.unmatched_names[name] || 0) + 1;
      return u ? u.id : null;
    };

    // 차량
    const vehicles = (await client.query('SELECT id, plate FROM vehicles')).rows;
    const vid = {};
    for (const v of vehicles) vid[normPlate(v.plate)] = v.id;
    for (const v of data.vehicles) {
      const key = normPlate(v.plate);
      const owner = uid(v.owner);
      const vals = [owner, v.ownership === 'personal' ? 'personal' : 'corporate', v.plate, v.model || null, v.fuel_type || 'gasoline', v.efficiency_km_l || null, v.active !== false];
      if (vid[key]) {
        await client.query(
          `UPDATE vehicles SET user_id=COALESCE($1,user_id), ownership=$2, plate=$3, model=COALESCE($4,model), fuel_type=$5,
             efficiency_km_l=COALESCE($6,efficiency_km_l), active=$7 WHERE id=$8`, [...vals, vid[key]]);
        rep.vehicles_updated++;
      } else {
        const r = await client.query(
          'INSERT INTO vehicles(user_id,ownership,plate,model,fuel_type,efficiency_km_l,active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', vals);
        vid[key] = r.rows[0].id;
        rep.vehicles_created++;
      }
    }

    await client.query("DELETE FROM photos WHERE owner_type='expense' AND owner_id IN (SELECT id FROM expenses WHERE source='excel')");
    await client.query("DELETE FROM photos WHERE owner_type='maintenance' AND owner_id IN (SELECT id FROM maintenance WHERE source='excel')");
    await client.query("DELETE FROM trips WHERE source='excel'");
    await client.query("DELETE FROM expenses WHERE source='excel'");
    await client.query("DELETE FROM maintenance WHERE source='excel'");

    for (const t of data.trips) {
      const u = uid(t.name);
      if (!u) continue;
      await client.query(
        `INSERT INTO trips(user_id,vehicle_id,trip_date,purpose,start_name,end_name,distance_km,toll_won,fuel_price_won,efficiency_km_l,fuel_cost_won,memo,source)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'excel')`,
        [u, vid[normPlate(t.plate)] || null, t.date, t.route || null, t.start || null, t.end || null, t.km || 0, t.toll || 0,
          t.price || null, t.eff || null, t.fuel_cost || 0, `엑셀 이관 (${t.sheet})`]
      );
      rep.trips++;
    }
    for (const e of data.expenses) {
      const u = uid(e.name);
      if (!u) continue;
      await client.query(
        `INSERT INTO expenses(user_id,expense_date,card_type,category,purpose,amount,memo,source) VALUES($1,$2,$3,$4,$5,$6,$7,'excel')`,
        [u, e.date, e.card, e.category, e.purpose, e.amount, [e.memo, `엑셀 이관 (${e.sheet})`].filter(Boolean).join(' · ')]
      );
      rep.expenses++;
    }
    for (const m of data.maintenance) {
      const v = vid[normPlate(m.plate)];
      if (!v) continue;
      const owner = (await client.query('SELECT user_id FROM vehicles WHERE id=$1', [v])).rows[0]?.user_id || null;
      await client.query(
        `INSERT INTO maintenance(vehicle_id,user_id,maint_date,maint_type,odometer_km,description,amount,memo,source)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'excel')`,
        [v, owner, m.date, m.type, m.odometer || null, m.description, m.amount || 0, [m.memo, `엑셀 이관 (${m.src})`].filter(Boolean).join(' · ')]
      );
      rep.maintenance++;
    }
    const addPhoto = async (ownerType, ownerId, path) => {
      const b = data.readFile(path);
      if (!b) { rep.missing_photos++; return; }
      await client.query('INSERT INTO photos(owner_type,owner_id,filename,mime,size,data) VALUES($1,$2,$3,$4,$5,$6)',
        [ownerType, ownerId, path.split('/').pop(), 'image/jpeg', b.length, b]);
      rep.photos++;
    };
    // 월별 영수증 일괄 첨부 (금액 0, 합계 미반영)
    for (const g of data.receipt_groups || []) {
      const u = uid(g.name);
      if (!u) continue;
      const r = await client.query(
        `INSERT INTO expenses(user_id,expense_date,card_type,category,purpose,amount,memo,source)
         VALUES($1,$2,'receipt','영수증(이관)',$3,0,$4,'excel') RETURNING id`,
        [u, g.month + '-01', `${g.month} 엑셀 영수증 일괄 (${g.files.length}장)`, `엑셀 이관 (${g.sheet}) · 건별 구분 불가로 월 단위 첨부`]
      );
      for (const f of g.files) await addPhoto('expense', r.rows[0].id, f);
      rep.receipt_groups++;
    }
    // 정비 내역서 사진: 같은 차량·같은 일자 기록에 첨부, 없으면 기록 생성
    for (const g of data.maint_photo_groups || []) {
      const v = vid[normPlate(g.plate)];
      if (!v) continue;
      let id = null;
      if (g.date) {
        const ex = await client.query("SELECT id FROM maintenance WHERE vehicle_id=$1 AND maint_date=$2 AND source='excel' ORDER BY id LIMIT 1", [v, g.date]);
        id = ex.rows[0]?.id || null;
      }
      if (!id) {
        const owner = (await client.query('SELECT user_id FROM vehicles WHERE id=$1', [v])).rows[0]?.user_id || null;
        const r = await client.query(
          `INSERT INTO maintenance(vehicle_id,user_id,maint_date,maint_type,description,amount,memo,source)
           VALUES($1,$2,$3,'수리',$4,0,'엑셀 이관 (일자별 수리내역서)','excel') RETURNING id`,
          [v, owner, g.date || '2026-01-01', g.title]
        );
        id = r.rows[0].id;
        rep.maintenance++;
      }
      for (const f of g.files) await addPhoto('maintenance', id, f);
    }

    if (dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');
    return rep;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { importLegacy };
