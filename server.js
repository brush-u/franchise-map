const express = require('express');
const path = require('path');
const axios = require('axios');
const https = require('https');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// 공공데이터 API 인증키 — 반드시 환경변수로 관리한다.
// GitHub에 올릴 때 .env는 .gitignore에 포함되므로 키가 저장소에 노출되지 않는다.
// 배포 플랫폼(Render/Railway 등)의 환경변수 설정 화면에 SERVICE_KEY를 등록해야 한다.
// ------------------------------------------------------------
const SERVICE_KEY = process.env.SERVICE_KEY;

// 통계청 SGIS Open API 인증 정보 (Tier 2: 인구/가구 통계)
const SGIS_SERVICE_ID = process.env.SGIS_SERVICE_ID;
const SGIS_SECURITY_KEY = process.env.SGIS_SECURITY_KEY;

// 일부 공공데이터 API가 오래된 SSL 인증서 체인을 쓰는 경우가 있어 우회한다.
// (보안상 이상적이진 않지만 apis.data.go.kr 연동 시 흔히 필요한 우회임)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * 반경 내 상점 조회 API (소상공인시장진흥공단 실제 API 연동)
 * GET /api/stores/radius?cx=경도&cy=위도&radius=반경&pageNo=1&useFilter=auto|1|0
 *
 * 예전엔 이 엔드포인트 하나가 필요한 모든 페이지를 서버에서 끝까지 다 받아온 뒤
 * 한 번에 통째로 응답했다. 그러다 보니 업소가 많은 지역(제주/부산 관광지 등)에서는
 * 페이지를 여러 번 순차로 받아야 해서(요청 간 지연까지 포함) 화면에 아무것도 안 뜬 채로
 * 몇 초씩 기다려야 했다.
 *
 * 지금은 "한 번 호출 = 한 페이지"로 바꿨다. 프론트가 1페이지를 받으면 즉시 지도/목록에
 * 그리고, 필요하면 이어서 2페이지, 3페이지를 백그라운드로 계속 요청해서 추가한다.
 * 이러면 첫 결과가 훨씬 빨리 보이고, 나머지는 사용자가 보는 동안 뒤에서 채워진다.
 */
app.get('/api/stores/radius', async (req, res) => {
  try {
    const { cx, cy } = req.query;
    const pageNo = parseInt(req.query.pageNo, 10) || 1;

    if (!cx || !cy || !req.query.radius) {
      return res.status(400).json({
        success: false,
        message: '경도(cx), 위도(cy), 반경(radius) 값이 모두 필요합니다.',
      });
    }

    // 공식 명세서 확인: radius 최대 2000m. 넘겨도 API가 에러를 낼 수 있으니 여기서 안전하게 잘라준다.
    const radius = Math.min(parseInt(req.query.radius, 10) || 500, 2000);

    if (!SERVICE_KEY) {
      console.error('❌ SERVICE_KEY 환경변수가 설정되지 않았습니다.');
      return res.status(500).json({ success: false, message: '서버에 공공데이터 API 키가 설정되지 않았습니다.' });
    }

    const apiURL = 'https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRadius';
    // 공식 명세서 확인: numOfRows 최대 1000 (예전엔 500으로 알고 있었는데 명세상 1000까지 가능 —
    // 페이지당 2배씩 더 받을 수 있어서 필요한 페이지 수가 절반으로 줄어든다).
    const PAGE_SIZE = Math.min(parseInt(req.query.numOfRows, 10) || 1000, 1000);

    // ✅ indsLclsCd=I2(음식) — 사용자가 확보한 공식 오퍼레이션 명세서로 확정 검증됨.
    // 더 이상 추측/후보 테스트가 필요 없다. 무조건 이 값으로 필터를 걸어서 요청한다.
    const FOOD_INDS_LCLS_CD = 'I2';

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function fetchOnePage(retriesLeft = 2) {
      try {
        const params = {
          serviceKey: SERVICE_KEY,
          radius,
          cx,
          cy,
          type: 'json',
          numOfRows: PAGE_SIZE,
          pageNo,
          indsLclsCd: FOOD_INDS_LCLS_CD,
        };
        const response = await axios.get(apiURL, { httpsAgent, params });

        const resultCode = response.data?.header?.resultCode;
        if (resultCode !== undefined && resultCode !== '00') {
          console.error('🔍 [진단] 공공데이터 API 원본 응답:', JSON.stringify(response.data));
          const err = new Error(`공공데이터 API 오류 응답: ${response.data.header?.resultMsg || resultCode}`);
          err.apiHeader = response.data.header;
          err.isLogicalError = true;
          throw err;
        }
        return response;
      } catch (err) {
        const errMsg = err.response?.data?.OpenAPI_ServiceResponse?.cmmMsgHeader?.errMsg;
        const isRateLimited = errMsg && errMsg.includes('LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND');
        if (isRateLimited && retriesLeft > 0) {
          console.warn(`⏳ 초당 요청 제한에 걸려 1.2초 대기 후 재시도합니다 (남은 재시도: ${retriesLeft})`);
          await sleep(1200);
          return fetchOnePage(retriesLeft - 1);
        }
        throw err;
      }
    }

    let response;
    let items = [];
    let totalCount = 0;

    try {
      response = await fetchOnePage();
    } catch (err) {
      if (err.isLogicalError && err.apiHeader?.resultCode === '03') {
        // NODATA_ERROR = 이 좌표/반경 안에 진짜로 음식점이 0건이라는 뜻(파라미터 문제 아님, I2는 검증된 값).
        // 에러로 취급하지 않고 정상적으로 "0건"을 반환한다.
        console.log('ℹ️ 이 반경엔 음식점이 없습니다 (NODATA_ERROR, 정상 상황).');
        totalCount = 0;
        items = [];
        response = null;
      } else {
        throw err;
      }
    }

    const usedFilter = true;
    const usedFilterValue = FOOD_INDS_LCLS_CD;

    const dataBody = response?.data?.body;
    if (dataBody) {
      if (Array.isArray(dataBody.items)) {
        items = dataBody.items;
      } else if (dataBody.items && Array.isArray(dataBody.items.item)) {
        items = dataBody.items.item;
      }
      totalCount = Number(dataBody.totalCount) || items.length;
    }

    const hasMore = pageNo * PAGE_SIZE < totalCount;
    console.log(`[API 성공] (필터 ${usedFilter ? '적용(' + usedFilterValue + ')' : '미적용'}) 페이지 ${pageNo}: ${items.length}건 (전체 ${totalCount}건, 다음페이지: ${hasMore})`);

    return res.status(200).json({
      success: true,
      body: { items, totalCount, pageNo, pageSize: PAGE_SIZE, hasMore, usedFilter, usedFilterValue },
    });
  } catch (error) {
    const apiResponseData = error.response?.data;
    console.error('❌ 공공데이터 API 호출 실패:', error.message);
    if (apiResponseData) console.error('❌ 공공데이터 API 응답 원문:', JSON.stringify(apiResponseData).slice(0, 1000));

    return res.status(502).json({
      success: false,
      message: '공공데이터 API 호출에 실패했습니다.',
      error: error.message,
      apiResponse: apiResponseData || null,
      apiHeader: error.apiHeader || null,
    });
  }
});

// ══════════════════════════════════════════════════════════
// Tier 2: 통계청 SGIS Open API — 인구/가구 통계
// ══════════════════════════════════════════════════════════
// SGIS는 위경도 반경검색이 아니라 "행정동 코드 + 연도" 기반 조회라서,
// 좌표 → 행정동코드 변환(리버스 지오코딩) → 인구통계 조회, 2단계로 처리한다.

let sgisAccessToken = null;
let sgisTokenExpiresAt = 0; // epoch seconds

// SGIS는 인증키 발급이 아니라 "액세스 토큰" 발급 방식이라 매 요청마다 새로 받을 필요는 없고,
// 만료 전까지는 캐시해서 재사용한다 (불필요한 인증 호출을 줄인다).
async function getSgisAccessToken() {
  const nowSec = Math.floor(Date.now() / 1000);
  if (sgisAccessToken && nowSec < sgisTokenExpiresAt - 60) {
    return sgisAccessToken; // 아직 유효함 (여유 60초 두고 재사용)
  }
  // 복사/붙여넣기 시 앞뒤 공백이나 줄바꿈이 섞여 들어가는 경우가 흔해서 trim 처리한다.
  const consumerKey = (SGIS_SERVICE_ID || '').trim();
  const consumerSecret = (SGIS_SECURITY_KEY || '').trim();
  console.log(`🔑 [진단] SGIS 인증 시도 — consumer_key 앞 4자: ${consumerKey.slice(0, 4)}... (길이: ${consumerKey.length}), consumer_secret 길이: ${consumerSecret.length}`);

  const response = await axios.get('https://sgisapi.mods.go.kr/OpenAPI3/auth/authentication.json', {
    params: { consumer_key: consumerKey, consumer_secret: consumerSecret },
  });
  console.log('🔑 [진단] SGIS 인증 원본 응답:', JSON.stringify(response.data));
  if (response.data?.errCd !== 0 || !response.data?.result?.accessToken) {
    throw new Error(`SGIS 인증 실패: ${response.data?.errMsg || '알 수 없는 오류'}`);
  }
  sgisAccessToken = response.data.result.accessToken;
  // accessTimeout은 "발급시각+유효기간"의 초 단위 값. 정확한 유효기간을 문서에서 명시하지 않아
  // 넉넉하게 30분마다 갱신하는 것으로 안전하게 처리한다.
  sgisTokenExpiresAt = nowSec + 1800;
  return sgisAccessToken;
}

// 좌표(WGS84) -> 행정동 코드. addr_type=20은 "행정동(읍면동)" 기준.
async function coordsToAdmCode(lat, lng, accessToken) {
  const response = await axios.get('https://sgisapi.mods.go.kr/OpenAPI3/addr/rgeocodewgs84.json', {
    params: { accessToken, x_coor: lng, y_coor: lat, addr_type: 20 },
  });
  if (response.data?.errCd !== 0 || !response.data.result || response.data.result.length === 0) {
    console.error('🔍 [진단] SGIS 좌표변환 원본 응답:', JSON.stringify(response.data));
    throw new Error(`좌표→행정동 변환 실패: ${response.data?.errMsg || '결과 없음'}`);
  }
  const result = response.data.result[0];
  // sgg_cd(시군구, 3자리) + emdong_cd(읍면동, 3자리) 조합이 필요할 수 있어 문서 예시에 맞춰 조합한다.
  // 응답에 emdong_cd가 있으면 그걸 그대로 쓰고, 없으면 sido_cd+sgg_cd만으로 시군구 단위로 대체한다.
  return { admCd: result.emdong_cd || result.sgg_cd || result.sido_cd, admName: result.emdong_nm || result.sgg_nm || result.sido_nm, raw: result };
}

app.get('/api/population', async (req, res) => {
  try {
    if (!SGIS_SERVICE_ID || !SGIS_SECURITY_KEY) {
      return res.status(500).json({ success: false, message: 'SGIS 인증 정보가 서버에 설정되지 않았습니다.' });
    }
    const { lat, lng } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: '위도(lat), 경도(lng) 값이 필요합니다.' });
    }

    const accessToken = await getSgisAccessToken();
    const { admCd, admName } = await coordsToAdmCode(parseFloat(lat), parseFloat(lng), accessToken);

    const statsRes = await axios.get('https://sgisapi.mods.go.kr/OpenAPI3/stats/population.json', {
      params: { accessToken, year: 2024, adm_cd: admCd, low_search: 0 },
    });
    if (statsRes.data?.errCd !== 0 || !statsRes.data.result || statsRes.data.result.length === 0) {
      throw new Error(`인구통계 조회 실패: ${statsRes.data?.errMsg || '결과 없음'}`);
    }
    const stat = statsRes.data.result[0];

    return res.status(200).json({
      success: true,
      admCode: admCd,
      admName: admName || stat.adm_nm,
      year: 2024,
      totalPopulation: stat.tot_ppltn,
      populationDensity: stat.ppltn_dnsty, // 명/㎢
      totalHouseholds: stat.tot_family,
      avgHouseholdSize: stat.avg_fmember_cnt,
      avgAge: stat.avg_age,
    });
  } catch (error) {
    console.error('❌ SGIS 인구통계 조회 실패:', error.message);
    return res.status(502).json({ success: false, message: 'SGIS 인구통계 조회에 실패했습니다.', error: error.message });
  }
});

// ══════════════════════════════════════════════════════════
// Tier 2: 국토교통부 상업업무용 부동산 매매 실거래가
// ══════════════════════════════════════════════════════════
// 같은 공공데이터포털 계정으로 "상업업무용 부동산 매매 실거래가 자료" 활용신청을 별도로
// 하셔야 한다 (SERVICE_KEY 값 자체는 계정 공통이라 보통 동일한 키를 그대로 쓸 수 있다).
const REALESTATE_API_URL = 'http://apis.data.go.kr/1613000/RTMSDataSvcNrgTrade/getRTMSDataSvcNrgTrade';

async function fetchRealEstateForMonth(lawdCd, dealYmd) {
  const response = await axios.get(REALESTATE_API_URL, {
    params: { serviceKey: SERVICE_KEY, LAWD_CD: lawdCd, DEAL_YMD: dealYmd, numOfRows: 100, pageNo: 1, type: 'json' },
  });
  const resultCode = response.data?.response?.header?.resultCode;
  if (resultCode !== undefined && resultCode !== '00') {
    throw new Error(`실거래가 API 오류: ${response.data?.response?.header?.resultMsg || resultCode}`);
  }
  const items = response.data?.response?.body?.items?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

app.get('/api/realestate', async (req, res) => {
  try {
    if (!SERVICE_KEY) {
      return res.status(500).json({ success: false, message: '서버에 공공데이터 API 키가 설정되지 않았습니다.' });
    }
    if (!SGIS_SERVICE_ID || !SGIS_SECURITY_KEY) {
      return res.status(500).json({ success: false, message: '좌표→법정동코드 변환을 위해 SGIS 인증 정보가 필요합니다.' });
    }
    const { lat, lng } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: '위도(lat), 경도(lng) 값이 필요합니다.' });
    }

    const accessToken = await getSgisAccessToken();
    const { raw } = await coordsToAdmCode(parseFloat(lat), parseFloat(lng), accessToken);
    // 법정동코드 앞 5자리(시군구 단위) = 시도코드(2) + 시군구코드(3). 응답 형식이 이미 5자리로
    // 합쳐져 오는 경우도 있어서 방어적으로 처리한다.
    const sggRaw = raw.sgg_cd || '';
    const lawdCd = sggRaw.length >= 5 ? sggRaw.slice(0, 5) : `${raw.sido_cd || ''}${sggRaw}`.slice(0, 5);
    if (lawdCd.length !== 5) {
      throw new Error(`법정동코드 변환 실패 (원본: sido_cd=${raw.sido_cd}, sgg_cd=${raw.sgg_cd})`);
    }

    // 반경이 좁으면 이번 달 거래가 0건일 수 있어서, 최근 3개월을 순서대로 시도해 데이터가 있는
    // 첫 달을 쓴다 (완전히 빈 결과보다는 "몇 달 전 자료라도" 보여주는 게 낫다고 판단).
    const now = new Date();
    let items = [];
    let usedYmd = null;
    for (let i = 1; i <= 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
      try {
        const monthItems = await fetchRealEstateForMonth(lawdCd, ymd);
        if (monthItems.length > 0) { items = monthItems; usedYmd = ymd; break; }
      } catch (err) {
        console.warn(`⚠️ 실거래가 ${ymd} 조회 실패:`, err.message);
      }
    }

    if (items.length === 0) {
      return res.status(200).json({ success: true, lawdCd, hasData: false, message: '최근 3개월간 이 지역 상업업무용 부동산 거래 내역이 없습니다.' });
    }

    // 필드명은 국토부 기술문서 기준 예상값이며, 실제 응답에서 다를 경우를 대비해 여러 후보를 확인한다.
    const parsePrice = (item) => {
      const raw = item.dealAmount || item.거래금액 || '0';
      return parseInt(String(raw).replace(/,/g, '').trim(), 10) || 0;
    };
    const prices = items.map(parsePrice).filter((p) => p > 0);
    const avgPrice = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
    const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
    const minPrice = prices.length > 0 ? Math.min(...prices) : 0;

    return res.status(200).json({
      success: true,
      lawdCd,
      hasData: true,
      dealMonth: usedYmd,
      transactionCount: items.length,
      avgPriceManwon: avgPrice, // 만원 단위 (국토부 API 관례)
      maxPriceManwon: maxPrice,
      minPriceManwon: minPrice,
      sampleRaw: items[0], // 디버깅용 — 필드명이 예상과 다를 경우 이 값으로 확인 가능
    });
  } catch (error) {
    console.error('❌ 실거래가 조회 실패:', error.message);
    return res.status(502).json({ success: false, message: '실거래가 조회에 실패했습니다.', error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 정상적으로 실행 중입니다.`);
});
