const express = require('express');
const path = require('path');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const https = require('https');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// 개발 중 캐시 때문에 "고친 코드가 반영 안 된 것처럼 보이는" 혼란이 반복돼서,
// 브라우저가 index.html 등 정적 파일을 캐시하지 않도록 명시적으로 지시한다.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  },
}));

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
  // accessTimeout은 SGIS가 알려주는 실제 만료 시각(1970년 1월1일부터의 초, Unix epoch).
  // 예전엔 이 값을 안 쓰고 그냥 "30분"으로 임의로 가정했는데, 실제 토큰 수명이 그보다
  // 짧으면 이미 만료된 토큰을 계속 재사용하게 되어 "인증 정보가 존재하지 않습니다" 같은
  // 오류가 간헐적으로 났다 (호출 순서/타이밍에 따라 어떤 요청은 성공하고 어떤 건 실패).
  const timeoutVal = parseInt(response.data.result.accessTimeout, 10);
  sgisTokenExpiresAt = (timeoutVal && timeoutVal > nowSec) ? timeoutVal : nowSec + 300; // 값이 이상하면 5분만 신뢰
  console.log(`🔑 [진단] SGIS 토큰 발급 완료, 만료 예정 시각: ${new Date(sgisTokenExpiresAt * 1000).toISOString()} (지금으로부터 ${sgisTokenExpiresAt - nowSec}초 후)`);
  return sgisAccessToken;
}

// 좌표(WGS84) -> 행정구역 코드 체계. addr_type=20은 "행정동(읍면동)" 기준.
// SGIS 응답은 sido_cd(2자리)+sgg_cd(3자리)+emdong_cd(3자리)가 각각 따로 온다.
// 인구/가구 통계 API는 이걸 전부 이어붙인 8자리 코드를 요구하는데, 예전엔 emdong_cd(3자리)만
// 떼서 보내고 있었다 — 그래서 "검색결과가 존재하지 않습니다" 오류가 났다.
async function coordsToAdmCode(lat, lng, accessToken) {
  const response = await axios.get('https://sgisapi.mods.go.kr/OpenAPI3/addr/rgeocodewgs84.json', {
    params: { accessToken, x_coor: lng, y_coor: lat, addr_type: 20 },
  });
  // 파생값만 로그로 남기면 "우리가 잘못 읽은 건지 SGIS가 다르게 준 건지" 구분이 안 된다.
  // 원본 전체를 그대로 남겨서 확실히 비교할 수 있게 한다.
  console.log(`🔍 [진단] SGIS 좌표변환 원본 응답 (lat=${lat}, lng=${lng}):`, JSON.stringify(response.data));
  if (response.data?.errCd !== 0 || !response.data.result || response.data.result.length === 0) {
    throw new Error(`좌표→행정동 변환 실패: ${response.data?.errMsg || '결과 없음'}`);
  }
  const result = response.data.result[0];
  const sidoCd = result.sido_cd || '';
  const sggCd = result.sgg_cd || '';
  const emdongCd = result.emdong_cd || '';

  // sgg_cd가 이미 5자리(sido+sgg 합쳐진 형태)로 오는 경우도 관찰되어 방어적으로 처리한다.
  const sggCode5 = sggCd.length >= 5 ? sggCd.slice(0, 5) : `${sidoCd}${sggCd}`.slice(0, 5);
  const admCode8 = emdongCd ? `${sggCode5}${emdongCd}`.slice(0, 8) : sggCode5;

  console.log(`🔍 [진단] 좌표변환 결과: sido=${sidoCd}, sgg=${sggCd}, emdong=${emdongCd} -> 시군구코드(5자리)=${sggCode5}, 행정동코드(8자리)=${admCode8}`);

  return {
    admCd: admCode8,       // 인구/가구 통계용 (8자리, 읍면동 단위)
    sggCode5,               // 실거래가(LAWD_CD)용 (5자리, 시군구 단위)
    admName: result.emdong_nm || result.sgg_nm || result.sido_nm,
    raw: result,
  };
}

// SGIS 토큰이 만료됐는데도 캐시를 재사용해서 "인증 정보가 존재하지 않습니다" 류의 오류가
// 나는 경우를 대비한 안전장치. 인증 관련 오류로 보이면 토큰을 강제로 새로 받아 한 번 더 시도한다.
async function withSgisAuthRetry(fn) {
  try {
    return await fn(await getSgisAccessToken());
  } catch (err) {
    const looksLikeAuthError = /인증|토큰|access.?token/i.test(err.message || '');
    if (!looksLikeAuthError) throw err;
    console.warn('⚠️ SGIS 인증 관련 오류로 보여 토큰을 새로 받아 재시도합니다:', err.message);
    sgisAccessToken = null;
    sgisTokenExpiresAt = 0;
    return await fn(await getSgisAccessToken());
  }
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

    const { admCd, admName } = await withSgisAuthRetry((accessToken) =>
      coordsToAdmCode(parseFloat(lat), parseFloat(lng), accessToken)
    );
    const accessToken = await getSgisAccessToken();

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
// 시군구명 -> 공식 법정동코드(행정표준코드관리시스템 기준, 5자리) 매핑표
// ══════════════════════════════════════════════════════════
// ⚠️ SGIS가 주는 sgg_cd는 SGIS 자체 내부 코드일 뿐, 국토부가 요구하는 공식 법정동코드와
// 다르다 (실측 확인: SGIS는 강남구=230, 국토부 공식 코드는 강남구=680). 그래서 SGIS가
// 정확히 알려주는 "시도명+시군구명" 텍스트를 이 표로 직접 변환해서 쓴다.
// 서울/광역시는 확실한 값이고, 그 외 지역은 최대한 정확히 반영했지만 최근 행정구역 개편
// (예: 군위군의 대구 편입 등)으로 실제와 다를 가능성이 있으니, 이상하면 알려주시면 고치겠다.
const SGG_NAME_TO_LAWD_CD = {
  // 서울특별시 (25개 전체, 고신뢰)
  '서울특별시 종로구': '11110', '서울특별시 중구': '11140', '서울특별시 용산구': '11170',
  '서울특별시 성동구': '11200', '서울특별시 광진구': '11215', '서울특별시 동대문구': '11230',
  '서울특별시 중랑구': '11260', '서울특별시 성북구': '11290', '서울특별시 강북구': '11305',
  '서울특별시 도봉구': '11320', '서울특별시 노원구': '11350', '서울특별시 은평구': '11380',
  '서울특별시 서대문구': '11410', '서울특별시 마포구': '11440', '서울특별시 양천구': '11470',
  '서울특별시 강서구': '11500', '서울특별시 구로구': '11530', '서울특별시 금천구': '11545',
  '서울특별시 영등포구': '11560', '서울특별시 동작구': '11590', '서울특별시 관악구': '11620',
  '서울특별시 서초구': '11650', '서울특별시 강남구': '11680', '서울특별시 송파구': '11710',
  '서울특별시 강동구': '11740',
  // 6대 광역시
  '부산광역시 중구': '26110', '부산광역시 서구': '26140', '부산광역시 동구': '26170',
  '부산광역시 영도구': '26200', '부산광역시 부산진구': '26230', '부산광역시 동래구': '26260',
  '부산광역시 남구': '26290', '부산광역시 북구': '26320', '부산광역시 해운대구': '26350',
  '부산광역시 사하구': '26380', '부산광역시 금정구': '26410', '부산광역시 강서구': '26440',
  '부산광역시 연제구': '26470', '부산광역시 수영구': '26500', '부산광역시 사상구': '26530',
  '부산광역시 기장군': '26710',
  '대구광역시 중구': '27110', '대구광역시 동구': '27140', '대구광역시 서구': '27170',
  '대구광역시 남구': '27200', '대구광역시 북구': '27230', '대구광역시 수성구': '27260',
  '대구광역시 달서구': '27290', '대구광역시 달성군': '27710',
  '인천광역시 중구': '28110', '인천광역시 동구': '28140', '인천광역시 미추홀구': '28177',
  '인천광역시 연수구': '28185', '인천광역시 남동구': '28200', '인천광역시 부평구': '28237',
  '인천광역시 계양구': '28245', '인천광역시 서구': '28260', '인천광역시 강화군': '28710',
  '인천광역시 옹진군': '28720',
  '광주광역시 동구': '29110', '광주광역시 서구': '29140', '광주광역시 남구': '29155',
  '광주광역시 북구': '29170', '광주광역시 광산구': '29200',
  '대전광역시 동구': '30110', '대전광역시 중구': '30140', '대전광역시 서구': '30170',
  '대전광역시 유성구': '30200', '대전광역시 대덕구': '30230',
  '울산광역시 중구': '31110', '울산광역시 남구': '31140', '울산광역시 동구': '31170',
  '울산광역시 북구': '31200', '울산광역시 울주군': '31710',
  '세종특별자치시 세종시': '36110',
  // 경기도 주요 시 (전체는 아니지만 인구 밀집지 위주로 우선 반영)
  '경기도 수원시': '41111', '경기도 성남시': '41131', '경기도 의정부시': '41150',
  '경기도 안양시': '41171', '경기도 부천시': '41190', '경기도 광명시': '41210',
  '경기도 평택시': '41220', '경기도 안산시': '41271', '경기도 고양시': '41281',
  '경기도 과천시': '41290', '경기도 구리시': '41310', '경기도 남양주시': '41360',
  '경기도 오산시': '41370', '경기도 시흥시': '41390', '경기도 군포시': '41410',
  '경기도 의왕시': '41430', '경기도 하남시': '41450', '경기도 용인시': '41461',
  '경기도 파주시': '41480', '경기도 이천시': '41500', '경기도 안성시': '41550',
  '경기도 김포시': '41570', '경기도 화성시': '41590', '경기도 광주시': '41610',
  '경기도 양주시': '41630', '경기도 포천시': '41650', '경기도 여주시': '41670',
};

function lookupLawdCd(sidoName, sggName) {
  const exact = SGG_NAME_TO_LAWD_CD[`${sidoName} ${sggName}`];
  if (exact) return exact;
  // 수원/성남/용인/고양은 구가 있어서 SGIS가 "수원시장안구"처럼 붙여줄 수도, 띄어줄 수도 있다.
  // 정확한 형식을 몰라도 앞부분(시 이름)만으로 다시 시도해서 매칭 실패를 줄인다.
  const compoundCities = ['수원시', '성남시', '용인시', '고양시'];
  const matched = compoundCities.find((c) => (sggName || '').includes(c));
  if (matched) return SGG_NAME_TO_LAWD_CD[`${sidoName} ${matched}`] || null;
  return null;
}

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

  // 게이트웨이 레벨 오류(활용신청 미승인, 키 문제 등)는 다른 오류들처럼 OpenAPI_ServiceResponse
  // 형태로 올 수 있다 — 이걸 놓치면 "0건"으로 착각하게 된다.
  if (response.data?.OpenAPI_ServiceResponse) {
    const gwErr = response.data.OpenAPI_ServiceResponse.cmmMsgHeader;
    throw new Error(`게이트웨이 오류: ${gwErr?.errMsg || JSON.stringify(response.data.OpenAPI_ServiceResponse)}`);
  }

  // ⚠️ 핵심 버그였던 부분: type=json으로 요청해도 이 API는 XML 텍스트를 그대로 돌려준다.
  // axios는 JSON 컨텐츠타입만 자동으로 객체로 파싱해주기 때문에, response.data가 사실은
  // "<?xml..." 로 시작하는 순수 문자열이었다. 그런데 코드는 이미 파싱된 객체인 것처럼
  // response.data.response.header... 로 읽으려고 해서 항상 undefined -> 빈 배열이 나왔다.
  // (로그엔 원본 텍스트가 찍혀서 데이터가 있는 것처럼 보였지만, 실제 코드는 그 안에서
  // 아무것도 못 꺼내고 있었다.)
  let root;
  if (typeof response.data === 'string') {
    const parsed = await parseStringPromise(response.data, { explicitArray: false, trim: true });
    root = parsed.response || parsed;
  } else {
    root = response.data?.response || response.data;
  }

  const resultCode = root?.header?.resultCode;
  console.log(`🏢 [진단] 실거래가 ${lawdCd}/${dealYmd} 파싱 결과: resultCode=${resultCode}, items 존재=${!!root?.body?.items}`);

  // 이 API는 성공 코드가 '00'이 아니라 '000'(세 자리)이다 — 다른 데이터포털 API들과 관례가 다르다.
  if (resultCode !== undefined && resultCode !== '00' && resultCode !== '000') {
    throw new Error(`실거래가 API 오류(resultCode ${resultCode}): ${root?.header?.resultMsg || '알 수 없음'}`);
  }

  const items = root?.body?.items?.item;
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

    const { raw } = await withSgisAuthRetry((accessToken) =>
      coordsToAdmCode(parseFloat(lat), parseFloat(lng), accessToken)
    );
    const lawdCd = lookupLawdCd(raw.sido_nm, raw.sgg_nm);
    if (!lawdCd) {
      return res.status(200).json({
        success: true, hasData: false,
        message: `"${raw.sido_nm} ${raw.sgg_nm}"은(는) 아직 법정동코드 매핑표에 없는 지역입니다. 현재는 서울 전체와 주요 광역시/경기도 위주로만 지원합니다.`,
      });
    }

    // 반경이 좁으면 이번 달 거래가 0건일 수 있어서, 최근 3개월을 순서대로 시도해 데이터가 있는
    // 첫 달을 쓴다 (완전히 빈 결과보다는 "몇 달 전 자료라도" 보여주는 게 낫다고 판단).
    const now = new Date();
    let items = [];
    let usedYmd = null;
    const monthErrors = []; // 진짜 0건인지, 조회 자체가 실패한 건지 구분하기 위해 기록해둔다.
    for (let i = 1; i <= 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
      try {
        const monthItems = await fetchRealEstateForMonth(lawdCd, ymd);
        if (monthItems.length > 0) { items = monthItems; usedYmd = ymd; break; }
      } catch (err) {
        console.warn(`⚠️ 실거래가 ${ymd} 조회 실패:`, err.message);
        monthErrors.push({ ymd, error: err.message });
      }
    }

    if (items.length === 0) {
      if (monthErrors.length === 3) {
        // 3개월 다 "0건"이 아니라 "조회 자체가 실패"한 경우 — 이걸 "거래가 없습니다"로 뭉뚱그리면
        // 진짜 원인(활용신청 미승인, 필드 파싱 오류 등)을 놓치게 된다.
        return res.status(200).json({
          success: true, lawdCd, hasData: false,
          message: '거래가 없는 게 아니라, 조회 자체가 3개월 다 실패했습니다 (아래 monthErrors 확인).',
          monthErrors,
        });
      }
      return res.status(200).json({ success: true, lawdCd, sidoNm: raw.sido_nm, sggNm: raw.sgg_nm, hasData: false, message: '최근 3개월간 이 지역 상업업무용 부동산 거래 내역이 없습니다.', monthsChecked: 3 - monthErrors.length });
    }

    // 필드명은 국토부 기술문서 기준 예상값이며, 실제 응답에서 다를 경우를 대비해 여러 후보를 확인한다.
    const parsePrice = (item) => parseInt(String(item.dealAmount || item.거래금액 || '0').replace(/,/g, '').trim(), 10) || 0;
    const parseArea = (item) => parseFloat(item.buildingAr || item.건물면적 || '0') || 0;

    // 총액만 보면 500㎡짜리 건물과 50㎡짜리 건물이 같은 10억이어도 완전히 다른 가치인데
    // 구분이 안 된다. 평당가(㎡ -> 평 환산, 1평=3.3058㎡)로 정규화해야 서로 비교가 된다.
    const pricePerPyeongList = items.map((item) => {
      const price = parsePrice(item); // 만원 단위
      const areaM2 = parseArea(item);
      if (price <= 0 || areaM2 <= 0) return null;
      const pyeong = areaM2 / 3.3058;
      return price / pyeong; // 만원/평
    }).filter((v) => v !== null && v > 0 && isFinite(v));

    const avgPricePerPyeong = pricePerPyeongList.length > 0
      ? Math.round(pricePerPyeongList.reduce((a, b) => a + b, 0) / pricePerPyeongList.length)
      : null;

    const prices = items.map(parsePrice).filter((p) => p > 0);
    const avgPrice = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
    const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
    const minPrice = prices.length > 0 ? Math.min(...prices) : 0;

    // 동(umdNm)별 집계 — 지도에 마커로 찍어서 "이 구 안 어느 동네에서 거래가 많았는지" 보여주는 용도.
    const dongGroups = {};
    items.forEach((item) => {
      const dong = item.umdNm || item.법정동 || '기타';
      if (!dongGroups[dong]) dongGroups[dong] = [];
      dongGroups[dong].push(item);
    });
    const dongBreakdown = Object.entries(dongGroups)
      .map(([name, dongItems]) => {
        const dongPrices = dongItems.map(parsePrice).filter((p) => p > 0);
        return {
          name,
          count: dongItems.length,
          avgPriceManwon: dongPrices.length > 0 ? Math.round(dongPrices.reduce((a, b) => a + b, 0) / dongPrices.length) : 0,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // 건물 용도 구성 — "근린생활시설(상가) 위주인지, 업무용(오피스) 위주인지"는 상권 성격을 보여준다.
    const useGroups = {};
    items.forEach((item) => {
      const use = item.buildingUse || item.건물용도 || '기타';
      useGroups[use] = (useGroups[use] || 0) + 1;
    });
    const buildingUseBreakdown = Object.entries(useGroups)
      .map(([name, count]) => ({ name, count, pct: Math.round((count / items.length) * 100) }))
      .sort((a, b) => b.count - a.count);

    return res.status(200).json({
      success: true,
      lawdCd,
      sidoNm: raw.sido_nm,
      sggNm: raw.sgg_nm,
      hasData: true,
      dealMonth: usedYmd,
      transactionCount: items.length,
      avgPriceManwon: avgPrice, // 만원 단위 (국토부 API 관례)
      maxPriceManwon: maxPrice,
      minPriceManwon: minPrice,
      avgPricePerPyeongManwon: avgPricePerPyeong, // 평당가 (만원/평) — 면적 정규화된 비교 가능 지표
      dongBreakdown,
      buildingUseBreakdown,
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