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

// 소상공인시장진흥공단 상가(상권)정보 - 업종별 상가업소 조회
const API_BASE_URL = 'http://apis.data.go.kr/B553077/api/open/sdsc2/storeListInUpjong';
const STORES_FILE_PATH = path.join(__dirname, 'stores.json');

// 공공 API 장애 및 파라미터 인증 오류 시 안전하게 제공할 표준 샘플 데이터
// lon/lat을 포함해야 지도 표기가 가능하므로 폴백 데이터에도 좌표를 넣어둔다.
const FALLBACK_STORES = [
  { bizesNm: '스타벅스 강남점', indsSclsNm: '커피숍/카페', rdnmAdr: '서울특별시 강남구 강남대로 390', lon: 127.0276, lat: 37.4979 },
  { bizesNm: '투썸플레이스 역삼점', indsSclsNm: '커피숍/카페', rdnmAdr: '서울특별시 강남구 테헤란로 134', lon: 127.0357, lat: 37.5006 },
  { bizesNm: '이디야커피 선릉점', indsSclsNm: '커피숍/카페', rdnmAdr: '서울특별시 강남구 선릉로 428', lon: 127.0489, lat: 37.5044 },
  { bizesNm: '빽다방 대치점', indsSclsNm: '커피숍/카페', rdnmAdr: '서울특별시 강남구 도곡로 401', lon: 127.0559, lat: 37.4945 },
  { bizesNm: '커피빈 삼성점', indsSclsNm: '커피숍/카페', rdnmAdr: '서울특별시 강남구 영동대로 513', lon: 127.0621, lat: 37.5089 },
];

// 프론트에서 Kakao 지도 SDK를 로드하기 위한 JS 키 전달용.
// Kakao JS 키는 도메인 화이트리스트로 보호되므로 프론트에 노출되어도 무방하지만,
// 소스에 직접 하드코딩하지 않고 서버 env를 통해 내려준다.
app.get('/api/config', (req, res) => {
  res.json({ kakaoJsKey: process.env.KAKAO_JS_KEY || '' });
});

app.get('/api/franchises', async (req, res) => {
  try {
    const serviceKey = process.env.PUBLIC_API_KEY;

    // storeListInUpjong은 indsLclsCd(대분류)가 필수 파라미터다.
    // indsSclsCd(소분류)만 보내면 NO_MANDATORY_REQUEST_PARAMETERS_ERROR(resultCode 11)가 발생한다.
    // 대/중/소분류는 계층 관계이므로 세 값을 함께 보내야 정확히 좁혀진다.
    const indsLclsCd = req.query.indsLclsCd; // 필수
    const indsMclsCd = req.query.indsMclsCd; // 선택 (중분류로 좁힘)
    const indsSclsCd = req.query.indsSclsCd; // 선택 (소분류로 좁힘)
    const numOfRows = req.query.numOfRows || 100;

    if (!serviceKey) {
      console.error('❌ 에러: PUBLIC_API_KEY 환경변수가 설정되지 않았습니다.');
      return res.status(500).json({ error: '서버에 공공데이터 API 인증키가 설정되지 않았습니다.' });
    }

    if (!indsLclsCd) {
      return res.status(400).json({ error: 'indsLclsCd(업종 대분류 코드)는 필수 파라미터입니다.' });
    }

    console.log(`🌐 [공공데이터 API 호출] indsLclsCd=${indsLclsCd} indsMclsCd=${indsMclsCd || '-'} indsSclsCd=${indsSclsCd || '-'}`);

    const params = new URLSearchParams({
      serviceKey,
      indsLclsCd,
      pageNo: '1',
      numOfRows: String(numOfRows),
      type: 'json',
    });
    if (indsMclsCd) params.set('indsMclsCd', indsMclsCd);
    if (indsSclsCd) params.set('indsSclsCd', indsSclsCd);

    const requestUrl = `${API_BASE_URL}?${params.toString()}`;

    const response = await axios.get(requestUrl, { timeout: 10000 });
    const data = response.data;

    // 공공 API가 정상 응답을 주지 않거나 파라미터 에러를 뱉는 경우 안전하게 샘플 데이터 반환
    if (!data?.body?.items || data.body.items.length === 0) {
      // 원인 진단용: 실제 응답 원문을 그대로 출력 (에러코드/메시지가 여기 들어있음)
      console.log('🔍 [진단] 공공데이터 API 원본 응답:', JSON.stringify(data, null, 2));
      console.log('⚠️ 공공데이터 서버에서 유효한 데이터를 받지 못해 표준 상권 데이터를 로드합니다.');
      fs.writeFileSync(STORES_FILE_PATH, JSON.stringify(FALLBACK_STORES, null, 2), 'utf-8');
      return res.json({
        header: { resultCode: '00', resultMsg: 'NORMAL SERVICE (FALLBACK)' },
        body: { items: FALLBACK_STORES, totalCount: FALLBACK_STORES.length },
      });
    }

    // 공공 API 원본 필드명은 lon/lat (경도/위도). 좌표 없는 항목은 지도에 못 찍으므로 걸러서 카운트만 로그로 남긴다.
    const items = data.body.items;
    const withCoords = items.filter((it) => it.lon && it.lat);
    if (withCoords.length < items.length) {
      console.log(`⚠️ 좌표 누락 ${items.length - withCoords.length}건 (전체 ${items.length}건 중)`);
    }

    const totalCount = data.body.totalCount || items.length;

    console.log(`📊 조회된 데이터 건수: ${totalCount}건 (좌표 보유 ${withCoords.length}건)`);
    fs.writeFileSync(STORES_FILE_PATH, JSON.stringify(items, null, 2), 'utf-8');

    res.json({
      header: data.header || { resultCode: '00', resultMsg: 'NORMAL SERVICE' },
      body: { items, totalCount },
    });
  } catch (error) {
    console.warn('⚠️ 공공데이터 통신 중 예외 발생, 샘플 데이터를 대체 반환합니다:', error.message);

    // 예외 발생 시에도 중단 없이 프론트엔드가 정상 작동하도록 폴백 데이터 반환
    fs.writeFileSync(STORES_FILE_PATH, JSON.stringify(FALLBACK_STORES, null, 2), 'utf-8');
    res.json({
      header: { resultCode: '00', resultMsg: 'NORMAL SERVICE (FALLBACK)' },
      body: { items: FALLBACK_STORES, totalCount: FALLBACK_STORES.length },
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 정상적으로 실행 중입니다.`);
});
