// 외부 API: 카카오 로컬(장소검색), 카카오모빌리티(경로거리·통행료), 오피넷(유가)
const { q } = require('./db');

async function getSetting(key) {
  const envKey = { kakao_rest_key: 'KAKAO_REST_KEY', opinet_key: 'OPINET_KEY' }[key];
  if (envKey && process.env[envKey]) return process.env[envKey];
  const r = await q('SELECT value FROM settings WHERE key=$1', [key]);
  return r.rows[0]?.value || null;
}

async function kakaoGet(path, key) {
  const res = await fetch('https://dapi.kakao.com' + path, { headers: { Authorization: 'KakaoAK ' + key } });
  if (!res.ok) throw Object.assign(new Error('카카오 장소검색 실패: HTTP ' + res.status), { status: 502 });
  return res.json();
}

// 장소명(키워드) 검색 + 도로명/지번 주소 검색을 함께 수행 (주소만 입력해도 결과가 나오도록)
async function searchPlaces(query) {
  const key = await getSetting('kakao_rest_key');
  if (!key) throw Object.assign(new Error('카카오 REST API 키 미설정 (설정 메뉴에서 등록 필요)'), { status: 503 });
  const qs = encodeURIComponent(query);
  const [kw, addr] = await Promise.all([
    kakaoGet('/v2/local/search/keyword.json?size=10&query=' + qs, key).catch(() => ({ documents: [] })),
    kakaoGet('/v2/local/search/address.json?size=5&query=' + qs, key).catch(() => ({ documents: [] })),
  ]);
  const out = [];
  for (const d of addr.documents || []) {
    const road = d.road_address;
    out.push({
      name: road?.building_name ? `${road.building_name} (${road.address_name})` : (road?.address_name || d.address_name),
      address: road?.address_name || d.address_name,
      x: Number(d.x), y: Number(d.y), category: '주소',
    });
  }
  for (const d of kw.documents || []) {
    out.push({
      name: d.place_name,
      address: d.road_address_name || d.address_name,
      x: Number(d.x), y: Number(d.y),
      category: d.category_group_name || '',
    });
  }
  return out.slice(0, 12);
}

async function route(sx, sy, ex, ey) {
  const key = await getSetting('kakao_rest_key');
  if (!key) throw Object.assign(new Error('카카오 REST API 키 미설정 (설정 메뉴에서 등록 필요)'), { status: 503 });
  const url = `https://apis-navi.kakaomobility.com/v1/directions?origin=${sx},${sy}&destination=${ex},${ey}&priority=RECOMMEND&car_fuel=GASOLINE&car_hipass=true&summary=true`;
  const res = await fetch(url, { headers: { Authorization: 'KakaoAK ' + key } });
  if (!res.ok) throw Object.assign(new Error('카카오모빌리티 경로조회 실패: HTTP ' + res.status), { status: 502 });
  const data = await res.json();
  const r0 = data.routes?.[0];
  if (!r0 || r0.result_code !== 0) {
    throw Object.assign(new Error('경로 탐색 결과 없음: ' + (r0?.result_msg || '알 수 없음')), { status: 422 });
  }
  return {
    distance_km: Math.round((r0.summary.distance / 1000) * 10) / 10,
    toll_won: r0.summary.fare?.toll || 0,
    duration_min: Math.round(r0.summary.duration / 60),
  };
}

// 오피넷 전국 평균가: B027=휘발유, D047=경유, K015=LPG(자동차용부탄)
const OPINET_CODES = { gasoline: 'B027', diesel: 'D047', lpg: 'K015' };
const MANUAL_KEYS = {
  gasoline: 'price_gasoline', diesel: 'price_diesel', lpg: 'price_lpg', ev: 'price_ev', hybrid: 'price_gasoline',
};

// 오피넷 전국평균 조회 (https → http 순서로 시도, 실패 사유 기록)
async function fetchOpinet(key) {
  const attempts = [];
  for (const proto of ['https', 'http']) {
    const url = `${proto}://www.opinet.co.kr/api/avgAllPrice.do?out=json&certkey=${encodeURIComponent(key)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const text = await res.text();
      let rows = null;
      try { rows = JSON.parse(text)?.RESULT?.OIL || null; } catch (_) { /* not json */ }
      if (res.ok && Array.isArray(rows) && rows.length) return { ok: true, rows, attempts };
      attempts.push({ proto, status: res.status, body: text.slice(0, 200) });
    } catch (e) {
      attempts.push({ proto, error: String(e.cause?.code || e.cause?.message || e.message) });
    }
  }
  return { ok: false, attempts };
}

async function fuelPrice(fuelType) {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const lookupType = fuelType === 'hybrid' ? 'gasoline' : fuelType;
  const cached = await q('SELECT price_won, source FROM fuel_prices WHERE price_date=$1 AND fuel_type=$2', [today, lookupType]);
  if (cached.rows[0]) return { price: Number(cached.rows[0].price_won), source: cached.rows[0].source, date: today };

  const key = await getSetting('opinet_key');
  if (key && OPINET_CODES[lookupType]) {
    const t = await fetchOpinet(key);
    if (t.ok) {
      for (const [ft, code] of Object.entries(OPINET_CODES)) {
        const row = t.rows.find((o) => o.PRODCD === code);
        if (row) {
          await q(
            `INSERT INTO fuel_prices(price_date,fuel_type,price_won,source) VALUES($1,$2,$3,'opinet')
             ON CONFLICT (price_date,fuel_type) DO UPDATE SET price_won=EXCLUDED.price_won, source='opinet'`,
            [today, ft, Number(row.PRICE)]
          );
        }
      }
      const again = await q('SELECT price_won FROM fuel_prices WHERE price_date=$1 AND fuel_type=$2', [today, lookupType]);
      if (again.rows[0]) return { price: Number(again.rows[0].price_won), source: 'opinet', date: today };
    } else {
      console.warn('[opinet] 조회 실패:', JSON.stringify(t.attempts));
    }
  }
  const manual = await getSetting(MANUAL_KEYS[fuelType] || 'price_gasoline');
  if (manual) return { price: Number(manual), source: 'manual', date: today };
  return { price: null, source: 'none', date: today };
}

module.exports = { searchPlaces, route, fuelPrice, getSetting, fetchOpinet };
