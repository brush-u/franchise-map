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
    const { cx, cy, radius } = req.query;
    const pageNo = parseInt(req.query.pageNo, 10) || 1;
    const useFilterParam = req.query.useFilter || 'auto'; // 'auto' | '1' | '0'

    if (!cx || !cy || !radius) {
      return res.status(400).json({
        success: false,
        message: '경도(cx), 위도(cy), 반경(radius) 값이 모두 필요합니다.',
      });
    }

    if (!SERVICE_KEY) {
      console.error('❌ SERVICE_KEY 환경변수가 설정되지 않았습니다.');
      return res.status(500).json({ success: false, message: '서버에 공공데이터 API 키가 설정되지 않았습니다.' });
    }

    const apiURL = 'https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRadius';
    // numOfRows를 프론트가 지정할 수 있게 열어둔다. 작은 값(예: 30)으로 먼저 "미리보기"를
    // 빠르게 받아서 화면에 즉시 뭔가 보여주고, 이어서 큰 페이지로 전체를 채우는 데 쓴다.
    const PAGE_SIZE = Math.min(parseInt(req.query.numOfRows, 10) || 500, 500);
    // 업종 대분류: '12' = 음식 (실제 응답 데이터에서 확인된 값).
    const FOOD_INDS_LCLS_CD = '12';

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function fetchOnePage(useIndsFilter, retriesLeft = 2) {
      try {
        const params = {
          serviceKey: SERVICE_KEY,
          radius,
          cx,
          cy,
          type: 'json',
          numOfRows: PAGE_SIZE,
          pageNo,
        };
        if (useIndsFilter) params.indsLclsCd = FOOD_INDS_LCLS_CD;
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
          return fetchOnePage(useIndsFilter, retriesLeft - 1);
        }
        throw err;
      }
    }

    let response;
    let usedFilter;

    if (useFilterParam === '1' || useFilterParam === '0') {
      // 프론트가 이전 페이지 응답으로부터 이미 알고 있는 값 그대로 사용 (재판단 불필요, 더 빠름)
      usedFilter = useFilterParam === '1';
      response = await fetchOnePage(usedFilter);
    } else {
      // 'auto': 필터를 걸어서 시도하고, 실패하면 필터 없이 재시도
      try {
        response = await fetchOnePage(true);
        usedFilter = true;
      } catch (err) {
        if (err.isLogicalError) {
          console.warn('⚠️ 업종 필터(indsLclsCd) 사용 시 실패해서 필터 없이 재시도합니다:', err.message);
          response = await fetchOnePage(false);
          usedFilter = false;
        } else {
          throw err;
        }
      }
    }

    const dataBody = response.data?.body;
    let items = [];
    let totalCount = 0;
    if (dataBody) {
      if (Array.isArray(dataBody.items)) {
        items = dataBody.items;
      } else if (dataBody.items && Array.isArray(dataBody.items.item)) {
        items = dataBody.items.item;
      }
      totalCount = Number(dataBody.totalCount) || items.length;
    }

    const hasMore = pageNo * PAGE_SIZE < totalCount;
    console.log(`[API 성공] (필터 ${usedFilter ? '적용' : '미적용'}) 페이지 ${pageNo}: ${items.length}건 (전체 ${totalCount}건, 다음페이지: ${hasMore})`);

    return res.status(200).json({
      success: true,
      body: { items, totalCount, pageNo, pageSize: PAGE_SIZE, hasMore, usedFilter },
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

/**
 * 상권 심층 분석 API
 *
 * ⚠️ 중요: 이 엔드포인트는 실제 공공데이터/GIS 연산이 아니라
 * 좌표값을 해시 함수에 넣어 만든 시뮬레이션(데모) 데이터를 반환한다.
 * "PostGIS", "건축물대장", "인구센서스" 등은 설명 텍스트일 뿐 실제로 연동되어 있지 않다.
 * 프론트에 반드시 시뮬레이션임을 표시해야 하며, 실제 서비스 오픈 전 진짜 데이터로 교체가 필요하다.
 *
 * POST /api/v1/analysis/execute
 */
app.post('/api/v1/analysis/execute', async (req, res) => {
  try {
    const lat = req.body.lat || 37.5665;
    const lng = req.body.lng || 126.978;
    const module_id = req.body.module_id || 1;
    const searchRadius = req.body.radius || 400;

    console.log(`[심층 분석 요청 - 시뮬레이션] 위도: ${lat}, 경도: ${lng}, 모듈: ${module_id}, 반경: ${searchRadius}m`);

    const coordHash = Math.abs(Math.sin(parseFloat(lat) * 12.9898 + parseFloat(lng) * 78.233) * 43758.5453) % 1;
    const scale = (offset, range) => Math.floor(offset + coordHash * range);

    const footTraffic = scale(3400, 5200);
    const competitorCount = scale(12, 18);
    const monthlyRevenue = scale(42000000, 58000000);
    const officeWorkers = scale(2800, 4200);
    const residents = scale(1900, 2800);
    const bepMonths = scale(11, 5);
    const transitCount = scale(8, 12);
    const lunchPeak = '11:50 ~ 13:40';
    const dinnerPeak = '18:00 ~ 21:20';
    const averageRating = Number((3.7 + coordHash * 1.1).toFixed(1));

    const avgSpending = 13500;
    const conversionRate = 0.042;

    const analysisResult = {
      title: '반경 400m 상권 다차원 입지 타당성 및 심층 분석 리포트 (시뮬레이션)',
      is_simulated: true,
      simulation_notice: '이 리포트의 수치는 실제 공공데이터가 아니라 좌표 기반으로 생성한 데모용 시뮬레이션 값입니다. 실제 창업/투자 의사결정에 사용하지 마세요.',
      transit_count: transitCount,
      estimated_hourly_foot_traffic: footTraffic,
      competitor_count: competitorCount,
      average_rating: averageRating,
      lunch_peak: lunchPeak,
      dinner_peak: dinnerPeak,
      estimated_office_workers: officeWorkers,
      estimated_residents: residents,
      expected_monthly_revenue: monthlyRevenue,
      bep_months: bepMonths,
      detailed_explanation: `
[상권 입지 분석 상세 산출 근거 — ⚠️ 시뮬레이션 데이터입니다]

이 리포트는 실제 GIS/공공데이터 연산 결과가 아니라, 좌표값을 이용해 생성한 데모용 예시 데이터입니다.
아래 수치와 설명은 UI/리포트 레이아웃을 보여주기 위한 것이며, 실제 상권 분석 결과가 아닙니다.

1. 공간 범위 설정
- 분석 대상 영역: 기준점(위도 ${lat}, 경도 ${lng}) 반경 ${searchRadius}m
- 대중교통 인프라(예시 값): ${transitCount}개소

2. 배후 인구 구조 (예시 값)
- 주중 오피스 상주 인구: ${officeWorkers.toLocaleString()}명
- 주거 배후 인구: ${residents.toLocaleString()}명

3. 경쟁 환경 (예시 값)
- 동일 업종 점포 수: ${competitorCount}개소
- 경쟁사 평균 평점: ${averageRating}점 / 5.0

4. 예상 월 매출 및 BEP (예시 값, 실제 매출 예측 아님)
- 예상 월 매출: ${(monthlyRevenue / 10000).toLocaleString()}만 원
- 투자 원금 회수 예상: ${bepMonths}개월
      `.trim(),
    };

    return res.status(200).json({
      status: 'success',
      timestamp: new Date().toISOString(),
      query_params: { lat, lng, module_id, radius: searchRadius },
      result: analysisResult,
    });
  } catch (error) {
    console.error('⚠️ 서버 내부 연산 중 에러 발생:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 정상적으로 실행 중입니다.`);
});
