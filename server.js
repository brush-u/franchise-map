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

app.listen(PORT, () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 정상적으로 실행 중입니다.`);
});
