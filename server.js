process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 소상공인시장진흥공단 상가(상권)정보 API (B553077)
const SDSC2_BASE = 'http://apis.data.go.kr/B553077/api/open/sdsc2';
const STORE_LIST_URL = `${SDSC2_BASE}/storeListInUpjong`;
const LARGE_UPJONG_URL = `${SDSC2_BASE}/largeUpjongList`;
const MIDDLE_UPJONG_URL = `${SDSC2_BASE}/middleUpjongList`;
const SMALL_UPJONG_URL = `${SDSC2_BASE}/smallUpjongList`;
const STORES_FILE_PATH = path.join(__dirname, 'stores.json');

// 실제 API가 죽었을 때 지도 UI만 확인해보고 싶을 때 쓰는 샘플 데이터.
// 절대 실제 결과인 것처럼 위장하지 않는다 (header.resultMsg에 SAMPLE임을 명시).
const FALLBACK_STORES = [
  { bizesNm: '스타벅스 강남점', indsSclsNm: '커피숍/카페', rdnmAdr: '서울특별시 강남구 강남대로 390', lon: 127.0276, lat: 37.4979 },
  { bizesNm: '투썸플레이스 역삼점', indsSclsNm: '커피숍/카페', rdnmAdr: '서울특별시 강남구 테헤란로 134', lon: 127.0357, lat: 37.5006 },
  { bizesNm: '이디야커피 선릉점', indsSclsNm: '커피숍/카페', rdnmAdr: '서울특별시 강남구 선릉로 428', lon: 127.0489, lat: 37.5044 },
  { bizesNm: '빽다방 대치점', indsSclsNm: '커피숍/카페', rdnmAdr: '서울특별시 강남구 도곡로 401', lon: 127.0559, lat: 37.4945 },
  { bizesNm: '커피빈 삼성점', indsSclsNm: '커피숍/카페', rdnmAdr: '서울특별시 강남구 영동대로 513', lon: 127.0621, lat: 37.5089 },
];

app.get('/api/config', (req, res) => {
  res.json({ kakaoJsKey: process.env.KAKAO_JS_KEY || '' });
});

// ------------------------------------------------------------
// 업종 분류 조회 (대/중/소) - 코드를 하드코딩하지 않고 API에서 그대로 가져온다.
// ------------------------------------------------------------

function requireServiceKey(res) {
  const serviceKey = process.env.PUBLIC_API_KEY;
  if (!serviceKey) {
    res.status(500).json({ error: '서버에 공공데이터 API 인증키(PUBLIC_API_KEY)가 설정되지 않았습니다.' });
    return null;
  }
  return serviceKey;
}

app.get('/api/upjong/large', async (req, res) => {
  const serviceKey = requireServiceKey(res);
  if (!serviceKey) return;
  try {
    const url = `${LARGE_UPJONG_URL}?${new URLSearchParams({ serviceKey, numOfRows: '50', pageNo: '1', type: 'json' })}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    if (data?.header?.resultCode !== '00') {
      console.log('🔍 [대분류 조회 실패 응답]', JSON.stringify(data));
      return res.status(502).json({ error: '대분류 조회 실패', header: data?.header });
    }
    res.json({ items: data?.body?.items ?? [] });
  } catch (err) {
    console.warn('⚠️ 대분류 조회 통신 오류:', err.message);
    res.status(502).json({ error: '대분류 조회 통신 오류', detail: err.message });
  }
});

app.get('/api/upjong/middle', async (req, res) => {
  const serviceKey = requireServiceKey(res);
  if (!serviceKey) return;
  const { indsLclsCd } = req.query;
  if (!indsLclsCd) return res.status(400).json({ error: 'indsLclsCd는 필수입니다.' });
  try {
    const url = `${MIDDLE_UPJONG_URL}?${new URLSearchParams({ serviceKey, indsLclsCd, numOfRows: '100', pageNo: '1', type: 'json' })}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    if (data?.header?.resultCode !== '00') {
      console.log('🔍 [중분류 조회 실패 응답]', JSON.stringify(data));
      return res.status(502).json({ error: '중분류 조회 실패', header: data?.header });
    }
    res.json({ items: data?.body?.items ?? [] });
  } catch (err) {
    console.warn('⚠️ 중분류 조회 통신 오류:', err.message);
    res.status(502).json({ error: '중분류 조회 통신 오류', detail: err.message });
  }
});

app.get('/api/upjong/small', async (req, res) => {
  const serviceKey = requireServiceKey(res);
  if (!serviceKey) return;
  const { indsLclsCd, indsMclsCd } = req.query;
  if (!indsLclsCd || !indsMclsCd) return res.status(400).json({ error: 'indsLclsCd, indsMclsCd는 필수입니다.' });
  try {
    const url = `${SMALL_UPJONG_URL}?${new URLSearchParams({ serviceKey, indsLclsCd, indsMclsCd, numOfRows: '200', pageNo: '1', type: 'json' })}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    if (data?.header?.resultCode !== '00') {
      console.log('🔍 [소분류 조회 실패 응답]', JSON.stringify(data));
      return res.status(502).json({ error: '소분류 조회 실패', header: data?.header });
    }
    res.json({ items: data?.body?.items ?? [] });
  } catch (err) {
    console.warn('⚠️ 소분류 조회 통신 오류:', err.message);
    res.status(502).json({ error: '소분류 조회 통신 오류', detail: err.message });
  }
});

// ------------------------------------------------------------
// 상가업소 목록 조회
// ------------------------------------------------------------
app.get('/api/franchises', async (req, res) => {
  const serviceKey = requireServiceKey(res);
  if (!serviceKey) return;

  // useFallback=1일 때만 명시적으로 샘플 데이터를 내려준다.
  // (실패를 성공처럼 위장하지 않기 위해, 자동 폴백은 하지 않는다)
  if (req.query.useFallback === '1') {
    console.log('🧪 [샘플 데이터 요청] useFallback=1 명시적 호출');
    fs.writeFileSync(STORES_FILE_PATH, JSON.stringify(FALLBACK_STORES, null, 2), 'utf-8');
    return res.json({
      header: { resultCode: 'SAMPLE', resultMsg: '실제 API 응답이 아닌 샘플 데이터입니다.' },
      body: { items: FALLBACK_STORES, totalCount: FALLBACK_STORES.length },
    });
  }

  const indsLclsCd = req.query.indsLclsCd; // 필수
  const indsMclsCd = req.query.indsMclsCd; // 선택
  const indsSclsCd = req.query.indsSclsCd; // 선택
  const numOfRows = req.query.numOfRows || 100;

  if (!indsLclsCd) {
    return res.status(400).json({ error: 'indsLclsCd(업종 대분류 코드)는 필수 파라미터입니다.' });
  }

  console.log(`🌐 [공공데이터 API 호출] indsLclsCd=${indsLclsCd} indsMclsCd=${indsMclsCd || '-'} indsSclsCd=${indsSclsCd || '-'}`);

  try {
    const params = new URLSearchParams({
      serviceKey,
      indsLclsCd,
      pageNo: '1',
      numOfRows: String(numOfRows),
      type: 'json',
    });
    if (indsMclsCd) params.set('indsMclsCd', indsMclsCd);
    if (indsSclsCd) params.set('indsSclsCd', indsSclsCd);

    const response = await axios.get(`${STORE_LIST_URL}?${params.toString()}`, { timeout: 10000 });
    const data = response.data;

    // 실패도 실패 그대로 프론트에 전달한다. 여기서 조용히 성공처럼 바꿔치기하지 않는다.
    if (data?.header?.resultCode !== '00') {
      console.log('🔍 [진단] 공공데이터 API 원본 응답:', JSON.stringify(data, null, 2));
      return res.status(502).json({
        error: '공공데이터 API가 정상 응답을 반환하지 않았습니다.',
        header: data?.header,
      });
    }

    const items = data.body?.items ?? [];
    const withCoords = items.filter((it) => it.lon && it.lat);
    if (withCoords.length < items.length) {
      console.log(`⚠️ 좌표 누락 ${items.length - withCoords.length}건 (전체 ${items.length}건 중)`);
    }

    const totalCount = data.body?.totalCount ?? items.length;
    console.log(`📊 조회된 데이터 건수: ${totalCount}건 (좌표 보유 ${withCoords.length}건)`);
    fs.writeFileSync(STORES_FILE_PATH, JSON.stringify(items, null, 2), 'utf-8');

    res.json({ header: data.header, body: { items, totalCount } });
  } catch (error) {
    // 네트워크 자체가 죽은 경우도 마찬가지로 에러를 그대로 전달한다.
    console.warn('⚠️ 공공데이터 통신 중 예외 발생:', error.message);
    res.status(502).json({
      error: '공공데이터 API 통신 중 오류가 발생했습니다.',
      detail: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 정상적으로 실행 중입니다.`);
});
